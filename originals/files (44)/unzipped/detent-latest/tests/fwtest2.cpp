#include <cstdio>
#include <cstdint>
#include <cmath>
#define IRAM_ATTR
static const float STEPS_PER_REV=4075.7728f;
static const float DEG_PER_STEP=360.0f/STEPS_PER_REV;
struct Config{uint16_t rate,rateTravel,rampSteps;int16_t lashX,lashY;
 int16_t minX,maxX,minY,maxY;uint8_t limitsOn;float throwMm,sepMm,fieldW,fieldH;
 uint8_t invX,invY,laserHigh;uint16_t idleReleaseMs;int16_t cx[4],cy[4];
 uint8_t cornerSet,hValid;float h[8];};
static Config cfg={400,500,150,0,0,-2000,2000,-2000,2000,0,150.f,22.f,120.f,120.f,
 0,0,1,4000,{0,0,0,0},{0,0,0,0},0,0,{0,0,0,0,0,0,0,0}};
static float hinv[9];
static int32_t physX=0,physY=0,logX=0,logY=0;
static uint8_t phX=0,phY=0;
static int shaftX=0,shaftY=0;   // harness only: true shaft direction accumulator

static inline void stepAxisX(int8_t s){int8_t d=cfg.invX?-s:s;
  phX=(uint8_t)((phX+(d>0?1:7))&7); shaftX+=(d>0?1:-1); physX+=s;}
static inline void stepAxisY(int8_t s){int8_t d=cfg.invY?-s:s;
  phY=(uint8_t)((phY+(d>0?1:7))&7); shaftY+=(d>0?1:-1); physY+=s;}

static void mmToUV(float x,float y,float&u,float&v){
  if(cfg.hValid){float w=cfg.h[6]*x+cfg.h[7]*y+1.0f;
    if(fabsf(w)<1e-6f)w=(w<0?-1e-6f:1e-6f);
    u=(cfg.h[0]*x+cfg.h[1]*y+cfg.h[2])/w; v=(cfg.h[3]*x+cfg.h[4]*y+cfg.h[5])/w;
  }else{float a=atan2f(x,cfg.throwMm+cfg.sepMm); u=tanf(a); v=(y*cosf(a))/cfg.throwMm;}}
static void uvToMm(float u,float v,float&x,float&y){
  if(cfg.hValid){float w=hinv[6]*u+hinv[7]*v+hinv[8];
    if(fabsf(w)<1e-9f)w=(w<0?-1e-9f:1e-9f);
    x=(hinv[0]*u+hinv[1]*v+hinv[2])/w; y=(hinv[3]*u+hinv[4]*v+hinv[5])/w;
  }else{float a=atanf(u); x=(cfg.throwMm+cfg.sepMm)*u; y=cfg.throwMm*v/cosf(a);}}
static void rebuildInverse(){
  const float a=cfg.h[0],b=cfg.h[1],c=cfg.h[2],d=cfg.h[3],e=cfg.h[4],f=cfg.h[5],
              g=cfg.h[6],hh=cfg.h[7],i=1.0f;
  hinv[0]= (e*i-f*hh); hinv[1]=-(b*i-c*hh); hinv[2]= (b*f-c*e);
  hinv[3]=-(d*i-f*g);  hinv[4]= (a*i-c*g);  hinv[5]=-(a*f-c*d);
  hinv[6]= (d*hh-e*g); hinv[7]=-(a*hh-b*g); hinv[8]= (a*e-b*d);}
static void mmToSteps(float x,float y,int32_t&sx,int32_t&sy){
  float u,v;mmToUV(x,y,u,v);
  sx=(int32_t)lroundf((atanf(u)*0.5f)*57.2957795f/DEG_PER_STEP);
  sy=(int32_t)lroundf((atanf(v)*0.5f)*57.2957795f/DEG_PER_STEP);}
static void stepsToMm(int32_t sx,int32_t sy,float&x,float&y){
  float u=tanf(2.0f*sx*DEG_PER_STEP/57.2957795f);
  float v=tanf(2.0f*sy*DEG_PER_STEP/57.2957795f); uvToMm(u,v,x,y);}
static void limitsFromCorners(int16_t m){
  if(cfg.cornerSet!=0x0F)return;
  int16_t lo=cfg.cx[0],hi=cfg.cx[0];
  for(int i=1;i<4;i++){if(cfg.cx[i]<lo)lo=cfg.cx[i];if(cfg.cx[i]>hi)hi=cfg.cx[i];}
  cfg.minX=lo-m;cfg.maxX=hi+m;
  lo=cfg.cy[0];hi=cfg.cy[0];
  for(int i=1;i<4;i++){if(cfg.cy[i]<lo)lo=cfg.cy[i];if(cfg.cy[i]>hi)hi=cfg.cy[i];}
  cfg.minY=lo-m;cfg.maxY=hi+m;cfg.limitsOn=1;}
static int32_t clampTo(int32_t v,int32_t lo,int32_t hi){return v<lo?lo:(v>hi?hi:v);}
static void applyLimits(int32_t&tx,int32_t&ty){
  if(cfg.limitsOn){tx=clampTo(tx,cfg.minX,cfg.maxX);ty=clampTo(ty,cfg.minY,cfg.maxY);}}

int main(){
  int fail=0;
  // 1. invert acts on the shaft, not the logical counter, on BOTH axes
  for(int iy=0;iy<2;iy++){
    cfg.invX=0;cfg.invY=iy;physX=physY=0;shaftX=shaftY=0;
    for(int i=0;i<50;i++){stepAxisX(1);stepAxisY(1);}
    printf("invY=%d  logical(%ld,%ld) shaft(%d,%d)\n",iy,(long)physX,(long)physY,shaftX,shaftY);
    if(physX!=50||physY!=50){printf("FAIL logical count changed\n");fail=1;}
    if(shaftY!=(iy?-50:50)){printf("FAIL Y shaft did not invert\n");fail=1;}
  }
  cfg.invX=1;cfg.invY=0;physX=physY=0;shaftX=shaftY=0;
  for(int i=0;i<50;i++){stepAxisX(1);stepAxisY(1);}
  printf("invX=1  shaft(%d,%d) expect(-50,50)\n",shaftX,shaftY);
  if(shaftX!=-50||shaftY!=50){printf("FAIL X invert\n");fail=1;}
  cfg.invX=cfg.invY=0;

  // 2. limits off means free jog; on means asymmetric clamp
  int32_t tx,ty;
  cfg.limitsOn=0; tx=5000;ty=-5000;applyLimits(tx,ty);
  printf("limits off: %ld,%ld (expect 5000,-5000)\n",(long)tx,(long)ty);
  if(tx!=5000||ty!=-5000){printf("FAIL free jog clamped\n");fail=1;}
  cfg.limitsOn=1;cfg.minX=-40;cfg.maxX=300;cfg.minY=-120;cfg.maxY=90;
  tx=5000;ty=-5000;applyLimits(tx,ty);
  printf("limits on : %ld,%ld (expect 300,-120)\n",(long)tx,(long)ty);
  if(tx!=300||ty!=-120){printf("FAIL clamp\n");fail=1;}

  // 3. limits derived from four skewed corners
  cfg.cx[0]=-150;cfg.cy[0]= 140; cfg.cx[1]= 170;cfg.cy[1]= 155;
  cfg.cx[2]= 165;cfg.cy[2]=-130; cfg.cx[3]=-160;cfg.cy[3]=-145;
  cfg.cornerSet=0x0F; limitsFromCorners(4);
  printf("auto limits x=%d..%d y=%d..%d (expect -164..174, -149..159)\n",
         cfg.minX,cfg.maxX,cfg.minY,cfg.maxY);
  if(cfg.minX!=-164||cfg.maxX!=174||cfg.minY!=-149||cfg.maxY!=159){printf("FAIL auto limits\n");fail=1;}

  // 4. homography must land the four corners exactly, and round trip
  FILE*fp=fopen("h.txt","r"); float H[8];
  for(int i=0;i<8;i++) if(fscanf(fp,"%f",&H[i])!=1){printf("no h.txt\n");return 2;}
  fclose(fp);
  for(int i=0;i<8;i++)cfg.h[i]=H[i];
  rebuildInverse(); cfg.hValid=1;
  const float mx[4]={-60,60,60,-60}, my[4]={60,60,-60,-60};
  printf("corner check (measured mapping):\n");
  for(int i=0;i<4;i++){
    int32_t sx,sy; mmToSteps(mx[i],my[i],sx,sy);
    printf("  mm(%6.1f,%6.1f) -> steps(%4ld,%4ld)  want(%4d,%4d)\n",
           mx[i],my[i],(long)sx,(long)sy,cfg.cx[i],cfg.cy[i]);
    if(labs((long)sx-cfg.cx[i])>1||labs((long)sy-cfg.cy[i])>1){printf("  FAIL corner %d\n",i);fail=1;}
  }
  float worst=0;
  for(float x=-60;x<=60;x+=10)for(float y=-60;y<=60;y+=10){
    int32_t sx,sy;mmToSteps(x,y,sx,sy);float rx,ry;stepsToMm(sx,sy,rx,ry);
    float d=hypotf(rx-x,ry-y); if(d>worst)worst=d;}
  printf("mm -> steps -> mm worst round trip: %.3f mm\n",worst);
  if(worst>1.0f){printf("FAIL round trip\n");fail=1;}

  printf(fail?"\nFAILURES\n":"\nALL PASS\n");
  return fail;}
