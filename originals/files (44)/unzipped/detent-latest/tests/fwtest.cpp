// Harness: pulls the motion core out of the .ino and runs it against a virtual
// motor so we can prove commanded steps == physical steps.
#include <cstdio>
#include <cstdint>
#include <cmath>
#include <cstring>
#define IRAM_ATTR
static const float STEPS_PER_REV = 4075.7728f;
static const float DEG_PER_STEP  = 360.0f / STEPS_PER_REV;
static const uint32_t TICK_HZ = 10000;
static const uint16_t QUEUE_LEN = 256;
struct Config{uint16_t rate,rateTravel,rampSteps;int16_t lashX,lashY,limitX,limitY;
  float throwMm,sepMm,fieldW,fieldH;uint8_t invX,invY,laserHigh;uint16_t idleReleaseMs;};
static Config cfg={700,900,150,0,0,260,260,150.f,22.f,120.f,120.f,0,0,1,4000};
struct Seg{int16_t dx,dy;uint16_t interval;uint8_t laser;};
static Seg queue[QUEUE_LEN];
static volatile uint16_t qHead=0,qTail=0;
static inline uint16_t qCount(){return (uint16_t)((qHead+QUEUE_LEN-qTail)%QUEUE_LEN);}
static inline uint16_t qFree(){return QUEUE_LEN-1-qCount();}
static volatile int32_t physX=0,physY=0;
static int32_t logX=0,logY=0;
static int8_t lashDirX=1,lashDirY=1;
static volatile uint8_t phX=0,phY=0;
static volatile bool running=false;
static volatile int32_t aMajor=0,aStep=0,aErr=0,aMinorAbs=0;
static volatile int8_t aSx=0,aSy=0;
static volatile bool aXmajor=true;
static volatile uint16_t aInterval=1,aTick=0;
static volatile uint32_t aSinceStart=0;
static volatile uint16_t dropped=0;
static volatile int8_t lastDirX=0,lastDirY=0;
static volatile uint8_t aPlanned=0;
static volatile uint16_t settle=0;
static bool coilsLive=true;
static bool laserState=false;
static uint32_t lastMoveMs=0;
static inline void writeLaser(bool on){laserState=on;}
static inline void stepAxisX(int8_t s){phX=(uint8_t)((phX+(s>0?1:7))&7);physX+=s;}
static inline void stepAxisY(int8_t s){phY=(uint8_t)((phY+(s>0?1:7))&7);physY+=s;}
static uint32_t millis(){return 0;}

// ---- copied verbatim from detent_firmware.ino ----
static bool IRAM_ATTR onTick() {
  if (settle) { settle--; return false; }
  if (!running) {
    if (qHead == qTail) return false;
    const Seg &s = queue[qTail];
    qTail = (uint16_t)((qTail + 1) % QUEUE_LEN);
    writeLaser(s.laser != 0);
    int32_t adx = s.dx < 0 ? -s.dx : s.dx;
    int32_t ady = s.dy < 0 ? -s.dy : s.dy;
    if (adx == 0 && ady == 0) return false;
    aSx = s.dx > 0 ? 1 : (s.dx < 0 ? -1 : 0);
    aSy = s.dy > 0 ? 1 : (s.dy < 0 ? -1 : 0);
    aXmajor   = adx >= ady;
    aMajor    = aXmajor ? adx : ady;
    aMinorAbs = aXmajor ? ady : adx;
    aErr      = 2 * aMinorAbs - aMajor;
    aStep     = 0;
    aInterval = s.interval < 1 ? 1 : s.interval;
    aPlanned  = (s.laser & 2) ? 1 : 0;
    aTick     = 0;
    running   = true;
    if ((aSx && lastDirX && aSx != lastDirX) ||
        (aSy && lastDirY && aSy != lastDirY)) aSinceStart = 0;
    if (aSx) lastDirX = aSx;
    if (aSy) lastDirY = aSy;
    if (!coilsLive) { coilsLive = true; settle = TICK_HZ/33; return false; }
  }
  uint16_t iv = aInterval;
  if (!aPlanned) {
    uint32_t rs = cfg.rampSteps ? cfg.rampSteps : 1;
    if (aSinceStart < rs) { uint32_t k = rs - aSinceStart; iv = (uint16_t)(iv + (2*iv*k)/rs); }
  }
  if (++aTick < iv) return false;
  aTick = 0;
  if (aXmajor) {
    stepAxisX(aSx);
    if (aErr > 0) { stepAxisY(aSy); aErr -= 2 * aMajor; }
    aErr += 2 * aMinorAbs;
  } else {
    stepAxisY(aSy);
    if (aErr > 0) { stepAxisX(aSx); aErr -= 2 * aMajor; }
    aErr += 2 * aMinorAbs;
  }
  aSinceStart++;
  if (++aStep >= aMajor) { running = false; if (qHead == qTail) aSinceStart = 0; }
  return false;
}
static uint16_t intervalFor(uint16_t sps){if(sps<1)sps=1;uint32_t iv=TICK_HZ/sps;if(iv<1)iv=1;if(iv>65535)iv=65535;return (uint16_t)iv;}
static bool pushSeg(int16_t dx,int16_t dy,uint16_t interval,uint8_t laser){
  if(qFree()==0){dropped++;return false;}
  Seg s={dx,dy,interval,laser};queue[qHead]=s;qHead=(uint16_t)((qHead+1)%QUEUE_LEN);
  lastMoveMs=millis();return true;}
static bool moveToSteps(int32_t tx,int32_t ty,uint8_t laser,uint16_t ivOverride=0){
  if(tx> cfg.limitX)tx= cfg.limitX; if(tx<-cfg.limitX)tx=-cfg.limitX;
  if(ty> cfg.limitY)ty= cfg.limitY; if(ty<-cfg.limitY)ty=-cfg.limitY;
  int32_t dLogX=tx-logX,dLogY=ty-logY;
  if(dLogX==0&&dLogY==0)return pushSeg(0,0,1,laser);
  int32_t extraX=0,extraY=0;
  if(dLogX>0&&lashDirX<0){extraX= cfg.lashX;lashDirX= 1;}
  if(dLogX<0&&lashDirX>0){extraX=-cfg.lashX;lashDirX=-1;}
  if(dLogY>0&&lashDirY<0){extraY= cfg.lashY;lashDirY= 1;}
  if(dLogY<0&&lashDirY>0){extraY=-cfg.lashY;lashDirY=-1;}
  uint16_t iv=ivOverride?ivOverride:intervalFor(laser?cfg.rate:cfg.rateTravel);
  uint8_t segFlags=(laser?1:0)|(ivOverride?2:0);
  if(extraX||extraY){uint16_t ivA=intervalFor(cfg.rate),ivB=intervalFor(cfg.rateTravel);
    if(!pushSeg((int16_t)extraX,(int16_t)extraY,ivA>ivB?ivA:ivB,0))return false;}
  logX=tx;logY=ty;
  int32_t rx=dLogX,ry=dLogY;
  while(rx||ry){
    int32_t cx=rx,cy=ry;
    int32_t m=(cx<0?-cx:cx)>(cy<0?-cy:cy)?(cx<0?-cx:cx):(cy<0?-cy:cy);
    if(m>2000){cx=(rx*2000)/m;cy=(ry*2000)/m;if(cx==0&&cy==0){cx=rx;cy=ry;}}
    if(!pushSeg((int16_t)cx,(int16_t)cy,iv,segFlags))return false;
    rx-=cx;ry-=cy;}
  return true;}
static void mmToSteps(float x,float y,int32_t&sx,int32_t&sy){
  float a=atan2f(x,cfg.throwMm+cfg.sepMm);
  float b=atanf((y*cosf(a))/cfg.throwMm);
  float tx=(a*0.5f)*57.2957795f/DEG_PER_STEP;
  float ty=(b*0.5f)*57.2957795f/DEG_PER_STEP;
  sx=(int32_t)lroundf(cfg.invX?-tx:tx);sy=(int32_t)lroundf(cfg.invY?-ty:ty);}

static void runQueue(long maxTicks=200000000L){long t=0;while((running||qHead!=qTail)&&t<maxTicks){onTick();t++;}}

int main(){
  // 1. straight moves land exactly
  int32_t pts[][2]={{100,0},{100,80},{-60,80},{-60,-90},{0,0},{37,-13}};
  for(auto&p:pts){moveToSteps(p[0],p[1],1);runQueue();
    if(physX!=p[0]||physY!=p[1]){printf("FAIL no-lash %ld,%ld got %ld,%ld\n",(long)p[0],(long)p[1],(long)physX,(long)physY);return 1;}}
  printf("no-lash positioning exact: ok (final %ld,%ld)\n",(long)physX,(long)physY);

  // 2. with backlash, physical lags logical by exactly one lash on reversal
  physX=physY=0;logX=logY=0;lashDirX=lashDirY=1;qHead=qTail=0;
  cfg.lashX=7;cfg.lashY=5;
  moveToSteps(100,100,1);runQueue();
  printf("fwd  log(100,100) phys(%ld,%ld)\n",(long)physX,(long)physY);
  moveToSteps(0,0,1);runQueue();
  printf("rev  log(0,0)     phys(%ld,%ld)  expect(-7,-5)\n",(long)physX,(long)physY);
  if(physX!=-7||physY!=-5){printf("FAIL lash model\n");return 1;}
  moveToSteps(100,100,1);runQueue();
  printf("fwd  log(100,100) phys(%ld,%ld)  expect(100,100)\n",(long)physX,(long)physY);
  if(physX!=100||physY!=100){printf("FAIL lash return\n");return 1;}

  // 3. Bresenham keeps both axes moving together on a diagonal
  physX=physY=0;logX=logY=0;lashDirX=lashDirY=1;qHead=qTail=0;cfg.lashX=cfg.lashY=0;
  moveToSteps(200,100,1);
  long t=0;int maxSkew=0;
  while((running||qHead!=qTail)&&t<5000000){onTick();t++;
    int skew=(int)llabs((long long)physY*2-(long long)physX);
    if(skew>maxSkew)maxSkew=skew;}
  printf("diagonal 200x100: end(%ld,%ld) max 2y-x deviation %d\n",(long)physX,(long)physY,maxSkew);
  if(maxSkew>3){printf("FAIL interpolation not simultaneous\n");return 1;}

  // 4. long move splitting stays inside int16
  physX=physY=0;logX=logY=0;qHead=qTail=0;cfg.limitX=cfg.limitY=30000;
  moveToSteps(9000,4500,1);
  int segs=qCount();bool ok=true;
  for(int i=qTail;i!=qHead;i=(i+1)%QUEUE_LEN){if(abs(queue[i].dx)>2000||abs(queue[i].dy)>2000)ok=false;}
  runQueue();
  printf("long move: %d segments, all <=2000: %s, end(%ld,%ld)\n",segs,ok?"yes":"no",(long)physX,(long)physY);
  if(!ok||physX!=9000||physY!=4500){printf("FAIL long move\n");return 1;}

  // 5. limits clamp
  cfg.limitX=cfg.limitY=260;physX=physY=0;logX=logY=0;qHead=qTail=0;
  moveToSteps(9999,-9999,1);runQueue();
  printf("clamped to (%ld,%ld) expect (260,-260)\n",(long)physX,(long)physY);
  if(physX!=260||physY!=-260){printf("FAIL clamp\n");return 1;}

  // 6. kinematics sanity
  int32_t sx,sy;mmToSteps(60,0,sx,sy);
  printf("60mm right -> %ld steps  (%.3f mm/step)\n",(long)sx,60.0/sx);
  mmToSteps(0,60,sx,sy);
  printf("60mm up    -> %ld steps\n",(long)sy);

  // 7. reversal re-ramps: gaps between steps widen right after the turn
  physX=physY=0;logX=logY=0;lashDirX=lashDirY=1;qHead=qTail=0;
  cfg.limitX=cfg.limitY=30000;cfg.lashX=cfg.lashY=0;cfg.rampSteps=150;
  moveToSteps(100,0,1); moveToSteps(0,0,1);
  {
    long t=0; int32_t lastPX=physX; long lastStepT=0;
    long gapBefore=-1, gapAfter=-1; int32_t peak=0; bool sawPeak=false;
    while((running||qHead!=qTail)&&t<20000000){
      onTick(); t++;
      if(physX!=lastPX){
        long gap=t-lastStepT;
        if(physX>lastPX && physX==99) gapBefore=gap;          // cruising fwd
        if(sawPeak && physX==peak-3) gapAfter=gap;            // 3rd step after turn
        if(physX>peak){peak=physX;}
        if(!sawPeak && physX<peak) sawPeak=true;
        lastPX=physX; lastStepT=t;
      }
    }
    printf("reversal: cruise gap %ld ticks, post-turn gap %ld ticks (want post > cruise)\n",
           gapBefore, gapAfter);
    if(gapAfter <= gapBefore){printf("FAIL no reversal ramp\n");return 1;}
    if(physX!=0){printf("FAIL end position %ld\n",(long)physX);return 1;}
  }

  // 8. planned points run at exactly the interval the host chose
  physX=physY=0;logX=logY=0;qHead=qTail=0;lastDirX=lastDirY=0;
  moveToSteps(60,0,1,40);
  {
    long t=0; int32_t lastPX=physX; long lastStepT=0; long firstGap=-1,maxGap=0;
    while((running||qHead!=qTail)&&t<10000000){
      onTick(); t++;
      if(physX!=lastPX){
        long gap=t-lastStepT;
        if(firstGap<0&&physX>1)firstGap=gap;
        if(physX>2&&gap>maxGap)maxGap=gap;
        lastPX=physX;lastStepT=t;
      }
    }
    printf("planned: first gap %ld, max gap %ld (want both ~40, not ~120 ramped)\n",firstGap,maxGap);
    if(firstGap>45||maxGap>45){printf("FAIL planner override not honored\n");return 1;}
    if(physX!=60){printf("FAIL end %ld\n",(long)physX);return 1;}
  }

  printf("\nALL FIRMWARE MOTION TESTS PASS\n");
  return 0;}
