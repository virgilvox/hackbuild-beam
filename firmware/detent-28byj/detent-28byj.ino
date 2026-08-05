// DETENT - two-mirror stepper laser scanner
// Target: ESP32-C3 SuperMini (Arduino-ESP32 core 3.x / ESP-IDF 5.x)
//
// Motor X -> ULN2003 A : IN1=GPIO0  IN2=GPIO1  IN3=GPIO3  IN4=GPIO4
// Motor Y -> ULN2003 B : IN1=GPIO5  IN2=GPIO6  IN3=GPIO7  IN4=GPIO10
// Laser gate           : GPIO20 (U0RXD, quiet at boot) -> 470R -> 2N2222 base
// Avoided              : GPIO2, GPIO8, GPIO9 (strapping), GPIO21 (U0TXD boot log)
//
// All nine pins are below 32, so the whole machine state is one register write.
//
// Transports: USB CDC serial and BLE Nordic UART. Both speak the same line protocol.

#include <Arduino.h>
#include <Preferences.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "driver/gptimer.h"
#include "soc/gpio_reg.h"

// ---------------------------------------------------------------- pin map

static const uint8_t PIN_X[4] = {0, 1, 3, 4};
static const uint8_t PIN_Y[4] = {5, 6, 7, 10};
static const uint8_t PIN_LASER = 20;

// ---------------------------------------------------------------- geometry

// 28BYJ-48 gear train is 63.68395:1, not 64:1. Eight half-steps per electrical
// revolution x 63.68395 = 4075.7728 half-steps per output revolution.
static const float STEPS_PER_REV = 4075.7728f;
static const float DEG_PER_STEP  = 360.0f / STEPS_PER_REV;   // 0.0883266 deg

// ---------------------------------------------------------------- timing

static const uint32_t TICK_HZ    = 20000;    // step ISR base rate
static const uint16_t QUEUE_LEN  = 256;      // segment ring buffer

// ---------------------------------------------------------------- config

struct Config {
  uint16_t rate;          // dominant-axis steps per second
  uint16_t rateTravel;    // steps per second when the laser is off
  uint16_t rampSteps;     // steps spent easing up from standstill
  int16_t  lashX, lashY;  // backlash take-up, steps
  int16_t  minX, maxX;    // soft limits, steps, asymmetric
  int16_t  minY, maxY;
  uint8_t  limitsOn;      // 0 = free jog, which is how you find the edges
  float    throwMm;       // Y mirror to target plane, along the beam axis
  float    sepMm;         // X mirror pivot to Y mirror pivot
  float    fieldW, fieldH;
  uint8_t  invX, invY;    // direction inversion, applied at the phase table
  uint8_t  laserHigh;     // 1 = active high
  uint16_t idleReleaseMs; // de-energise coils after this long idle, 0 = never
  int16_t  cx[4], cy[4];  // captured corner positions in steps, TL TR BR BL
  uint8_t  cornerSet;     // bitmask of which corners have been captured
  uint8_t  hValid;        // 1 = use the measured mapping instead of the ideal one
  float    h[8];          // mm -> (tan 2thetaX, tan 2thetaY) homography, h8 = 1
};

static Config cfg = {
  .rate = 400, .rateTravel = 500, .rampSteps = 150,
  .lashX = 0, .lashY = 0,
  .minX = -2000, .maxX = 2000, .minY = -2000, .maxY = 2000,
  .limitsOn = 0,
  .throwMm = 150.0f, .sepMm = 22.0f,
  .fieldW = 120.0f, .fieldH = 120.0f,
  .invX = 0, .invY = 0,
  .laserHigh = 1,
  .idleReleaseMs = 4000,
  .cx = {0,0,0,0}, .cy = {0,0,0,0},
  .cornerSet = 0, .hValid = 0,
  .h = {0,0,0,0,0,0,0,0}
};

// Inverse of the corner homography, rebuilt whenever h changes.
static float hinv[9] = {0,0,0,0,0,0,0,0,0};

static Preferences prefs;

// ---------------------------------------------------------------- phase tables

// Half-step, IN1..IN4. Bit 0 = IN1.
static const uint8_t HALFSTEP[8] = {0b0001, 0b0011, 0b0010, 0b0110,
                                    0b0100, 0b1100, 0b1000, 0b1001};

static uint32_t maskX[8], maskY[8];      // pins to raise for each phase
static uint32_t allX = 0, allY = 0, maskLaser = 0;

static void buildMasks() {
  allX = allY = 0;
  for (int i = 0; i < 4; i++) { allX |= (1u << PIN_X[i]); allY |= (1u << PIN_Y[i]); }
  maskLaser = (1u << PIN_LASER);
  for (int p = 0; p < 8; p++) {
    uint32_t mx = 0, my = 0;
    for (int i = 0; i < 4; i++) {
      if (HALFSTEP[p] & (1 << i)) { mx |= (1u << PIN_X[i]); my |= (1u << PIN_Y[i]); }
    }
    maskX[p] = mx; maskY[p] = my;
  }
}

static inline void IRAM_ATTR writePhaseX(uint8_t p) {
  REG_WRITE(GPIO_OUT_W1TC_REG, allX & ~maskX[p]);
  REG_WRITE(GPIO_OUT_W1TS_REG, maskX[p]);
}
static inline void IRAM_ATTR writePhaseY(uint8_t p) {
  REG_WRITE(GPIO_OUT_W1TC_REG, allY & ~maskY[p]);
  REG_WRITE(GPIO_OUT_W1TS_REG, maskY[p]);
}
static volatile bool laserOn = false;
static inline void IRAM_ATTR writeLaser(bool on) {
  laserOn = on;
  bool level = cfg.laserHigh ? on : !on;
  REG_WRITE(level ? GPIO_OUT_W1TS_REG : GPIO_OUT_W1TC_REG, maskLaser);
}
static inline void releaseCoils() {
  REG_WRITE(GPIO_OUT_W1TC_REG, allX | allY);
}

// ---------------------------------------------------------------- segment queue

struct Seg {
  int16_t  dx, dy;       // physical step delta, signed, backlash already folded in
  uint16_t interval;     // ISR ticks between dominant-axis steps
  uint8_t  laser;        // laser state for the whole segment
};

static Seg              queue[QUEUE_LEN];
static volatile uint16_t qHead = 0, qTail = 0;   // head = write, tail = read

static inline uint16_t IRAM_ATTR qCount() {
  return (uint16_t)((qHead + QUEUE_LEN - qTail) % QUEUE_LEN);
}
static inline uint16_t qFree() { return QUEUE_LEN - 1 - qCount(); }

// ---------------------------------------------------------------- motion state

static volatile int32_t physX = 0, physY = 0;    // physical step position
static int32_t logX = 0, logY = 0;               // logical (backlash-corrected)
static int8_t  lashDirX = 1, lashDirY = 1;       // which side of the slack we sit on

static volatile uint8_t phX = 0, phY = 0;
static volatile bool    running = false;
static volatile bool    coilsLive = false;
static volatile uint32_t lastMoveMs = 0;

// active segment, ISR-owned
static volatile int32_t  aMajor = 0, aStep = 0, aErr = 0, aMinorAbs = 0;
static volatile int8_t   aSx = 0, aSy = 0;
static volatile bool     aXmajor = true;
static volatile uint16_t aInterval = 1, aTick = 0;
static volatile uint32_t aSinceStart = 0;
static volatile uint16_t dropped = 0;
static volatile int8_t   lastDirX = 0, lastDirY = 0;
static volatile uint8_t  aPlanned = 0;
static volatile uint16_t settle = 0;

static gptimer_handle_t gpt = NULL;

// Inversion is applied HERE, to the phase advance, not in the kinematics.
// That way it changes which way the shaft actually turns for every command path
// -- jog, raw steps, and mm moves alike -- while the logical step counter keeps
// following what was asked for. Putting it in the kinematics only ever affected
// mm moves, which is why jog would not invert.
static inline void IRAM_ATTR stepAxisX(int8_t s) {
  int8_t d = cfg.invX ? -s : s;
  phX = (uint8_t)((phX + (d > 0 ? 1 : 7)) & 7);
  writePhaseX(phX);
  physX += s;
}
static inline void IRAM_ATTR stepAxisY(int8_t s) {
  int8_t d = cfg.invY ? -s : s;
  phY = (uint8_t)((phY + (d > 0 ? 1 : 7)) & 7);
  writePhaseY(phY);
  physY += s;
}

static bool IRAM_ATTR onTick(gptimer_handle_t, const gptimer_alarm_event_data_t*, void*) {
  if (settle) { settle--; return false; }
  if (!running) {
    if (qHead == qTail) return false;
    const Seg &s = queue[qTail];
    qTail = (uint16_t)((qTail + 1) % QUEUE_LEN);

    writeLaser((s.laser & 1) != 0);

    int32_t adx = s.dx < 0 ? -s.dx : s.dx;
    int32_t ady = s.dy < 0 ? -s.dy : s.dy;
    if (adx == 0 && ady == 0) return false;      // laser-only or dwell segment

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

    // Direction reversal on either axis restarts the ramp. Without this every
    // corner is a full-rate reversal, which is where these motors skip.
    if ((aSx && lastDirX && aSx != lastDirX) ||
        (aSy && lastDirY && aSy != lastDirY)) aSinceStart = 0;
    if (aSx) lastDirX = aSx;
    if (aSy) lastDirY = aSy;

    // Re-energising after an idle release: hold the last phase for ~30 ms so
    // the rotor pulls back into register before we ask it to move.
    if (!coilsLive) {
      writePhaseX(phX); writePhaseY(phY);
      coilsLive = true;
      settle = TICK_HZ / 33;
      return false;
    }
  }

  // Ease up from standstill. The mirrors are tiny but the gear train has slop,
  // and a cold start straight into full rate is where these motors skip.
  uint16_t iv = aInterval;
  if (!aPlanned) {
    uint32_t rs = cfg.rampSteps ? cfg.rampSteps : 1;
    if (aSinceStart < rs) {
      uint32_t k = rs - aSinceStart;
      iv = (uint16_t)(iv + (2 * iv * k) / rs);   // 3x slower at standstill, linear ramp
    }
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
  if (++aStep >= aMajor) {
    running = false;
    if (qHead == qTail) aSinceStart = 0;         // queue drained, ramp again next time
  }
  return false;
}

// ---------------------------------------------------------------- planner

static uint16_t intervalFor(uint16_t stepsPerSec) {
  if (stepsPerSec < 1) stepsPerSec = 1;
  uint32_t iv = TICK_HZ / stepsPerSec;
  if (iv < 1) iv = 1;
  if (iv > 65535) iv = 65535;
  return (uint16_t)iv;
}

static bool pushSeg(int16_t dx, int16_t dy, uint16_t interval, uint8_t laser) {
  if (qFree() == 0) { dropped++; return false; }
  Seg s = { dx, dy, interval, laser };
  queue[qHead] = s;
  qHead = (uint16_t)((qHead + 1) % QUEUE_LEN);
  lastMoveMs = millis();
  return true;
}

// Queue a move to an absolute logical step position, folding in backlash take-up.
// Physical position sits on one side of the gear slack; when the commanded
// direction reverses we push an extra lash steps through before the mirror moves.
static bool moveToSteps(int32_t tx, int32_t ty, uint8_t laser, uint16_t ivOverride = 0) {
  if (cfg.limitsOn) {
    if (tx > cfg.maxX) tx = cfg.maxX;
    if (tx < cfg.minX) tx = cfg.minX;
    if (ty > cfg.maxY) ty = cfg.maxY;
    if (ty < cfg.minY) ty = cfg.minY;
  }

  int32_t dLogX = tx - logX, dLogY = ty - logY;
  if (dLogX == 0 && dLogY == 0) {
    return pushSeg(0, 0, 1, laser);
  }

  int32_t extraX = 0, extraY = 0;
  if (dLogX > 0 && lashDirX < 0) { extraX =  cfg.lashX; lashDirX =  1; }
  if (dLogX < 0 && lashDirX > 0) { extraX = -cfg.lashX; lashDirX = -1; }
  if (dLogY > 0 && lashDirY < 0) { extraY =  cfg.lashY; lashDirY =  1; }
  if (dLogY < 0 && lashDirY > 0) { extraY = -cfg.lashY; lashDirY = -1; }

  uint16_t iv = ivOverride ? ivOverride
                           : intervalFor(laser ? cfg.rate : cfg.rateTravel);
  uint8_t segFlags = (laser ? 1 : 0) | (ivOverride ? 2 : 0);

  // Take up slack with the laser off, and at the SLOWER of the two rates.
  // It happens at a reversal, which is exactly where speed costs steps.
  if (extraX || extraY) {
    uint16_t ivA = intervalFor(cfg.rate), ivB = intervalFor(cfg.rateTravel);
    if (!pushSeg((int16_t)extraX, (int16_t)extraY, ivA > ivB ? ivA : ivB, 0)) return false;
  }

  logX = tx; logY = ty;

  // Long moves are split so no single segment exceeds int16 and so the queue
  // stays granular enough for a stop to land quickly.
  int32_t rx = dLogX, ry = dLogY;
  while (rx || ry) {
    int32_t cx = rx, cy = ry;
    int32_t m = (cx < 0 ? -cx : cx) > (cy < 0 ? -cy : cy) ? (cx < 0 ? -cx : cx) : (cy < 0 ? -cy : cy);
    if (m > 2000) {
      cx = (rx * 2000) / m; cy = (ry * 2000) / m;
      if (cx == 0 && cy == 0) { cx = rx; cy = ry; }
    }
    if (!pushSeg((int16_t)cx, (int16_t)cy, iv, segFlags)) return false;
    rx -= cx; ry -= cy;
  }
  return true;
}

// ---------------------------------------------------------------- kinematics

// Two-mirror scanner. The X mirror swings the beam in the horizontal plane, the
// beam travels sepMm to the Y mirror, then the Y mirror lifts it. Beam
// deflection is twice the mirror rotation, hence the halving.
//
// Everything is done in (u, v) = (tan 2thetaX, tan 2thetaY). In that space the
// ideal model is nearly linear in target mm, which is exactly what makes a
// four-corner homography able to absorb real-world error: rotation, keystone
// from an off-axis mount, a wrong throw estimate, mirrors not quite square.
// With corners captured, the measured map wins. Without, fall back to ideal.

static void mmToUV(float x, float y, float &u, float &v) {
  if (cfg.hValid) {
    float w = cfg.h[6]*x + cfg.h[7]*y + 1.0f;
    if (fabsf(w) < 1e-6f) w = (w < 0 ? -1e-6f : 1e-6f);
    u = (cfg.h[0]*x + cfg.h[1]*y + cfg.h[2]) / w;
    v = (cfg.h[3]*x + cfg.h[4]*y + cfg.h[5]) / w;
  } else {
    float a = atan2f(x, cfg.throwMm + cfg.sepMm);
    u = tanf(a);
    v = (y * cosf(a)) / cfg.throwMm;
  }
}

static void uvToMm(float u, float v, float &x, float &y) {
  if (cfg.hValid) {
    float w = hinv[6]*u + hinv[7]*v + hinv[8];
    if (fabsf(w) < 1e-9f) w = (w < 0 ? -1e-9f : 1e-9f);
    x = (hinv[0]*u + hinv[1]*v + hinv[2]) / w;
    y = (hinv[3]*u + hinv[4]*v + hinv[5]) / w;
  } else {
    float a = atanf(u);
    x = (cfg.throwMm + cfg.sepMm) * u;
    y = cfg.throwMm * v / cosf(a);
  }
}

// Adjugate inverse of [[h0 h1 h2],[h3 h4 h5],[h6 h7 1]]. Scale is irrelevant
// because the result is used projectively.
static void rebuildInverse() {
  const float a = cfg.h[0], b = cfg.h[1], c = cfg.h[2];
  const float d = cfg.h[3], e = cfg.h[4], f = cfg.h[5];
  const float g = cfg.h[6], hh = cfg.h[7], i = 1.0f;
  hinv[0] =  (e*i - f*hh);  hinv[1] = -(b*i - c*hh);  hinv[2] =  (b*f - c*e);
  hinv[3] = -(d*i - f*g);   hinv[4] =  (a*i - c*g);   hinv[5] = -(a*f - c*d);
  hinv[6] =  (d*hh - e*g);  hinv[7] = -(a*hh - b*g);  hinv[8] =  (a*e - b*d);
}

static void mmToSteps(float x, float y, int32_t &sx, int32_t &sy) {
  float u, v; mmToUV(x, y, u, v);
  sx = (int32_t)lroundf((atanf(u) * 0.5f) * 57.2957795f / DEG_PER_STEP);
  sy = (int32_t)lroundf((atanf(v) * 0.5f) * 57.2957795f / DEG_PER_STEP);
}

static void stepsToMm(int32_t sx, int32_t sy, float &x, float &y) {
  float u = tanf(2.0f * sx * DEG_PER_STEP / 57.2957795f);
  float v = tanf(2.0f * sy * DEG_PER_STEP / 57.2957795f);
  uvToMm(u, v, x, y);
}

// Corners are stored TL TR BR BL. Limits derived from them get a small margin
// so a plot that touches the edge does not clip.
static void limitsFromCorners(int16_t margin) {
  if (cfg.cornerSet != 0x0F) return;
  int16_t lo = cfg.cx[0], hi = cfg.cx[0];
  for (int i = 1; i < 4; i++) { if (cfg.cx[i] < lo) lo = cfg.cx[i]; if (cfg.cx[i] > hi) hi = cfg.cx[i]; }
  cfg.minX = lo - margin; cfg.maxX = hi + margin;
  lo = cfg.cy[0]; hi = cfg.cy[0];
  for (int i = 1; i < 4; i++) { if (cfg.cy[i] < lo) lo = cfg.cy[i]; if (cfg.cy[i] > hi) hi = cfg.cy[i]; }
  cfg.minY = lo - margin; cfg.maxY = hi + margin;
  cfg.limitsOn = 1;
}

// ---------------------------------------------------------------- transport

static String rxSerial;
static BLECharacteristic *txChar = nullptr;
static volatile bool bleConnected = false;
static String rxBle;

static void emit(const String &s) {
  Serial.print(s); Serial.print('\n');
  if (bleConnected && txChar) {
    String line = s + "\n";
    // NUS payloads are small; chunk to stay inside the negotiated MTU.
    for (size_t i = 0; i < line.length(); i += 180) {
      size_t end = (i + 180 > line.length()) ? line.length() : i + 180;
      String chunk = line.substring(i, end);
      txChar->setValue((uint8_t*)chunk.c_str(), chunk.length());
      txChar->notify();
      delay(2);
    }
  }
}

static void stopAll(bool killLaser) {
  noInterrupts();
  qHead = qTail;
  running = false;
  aSinceStart = 0;
  interrupts();
  if (killLaser) writeLaser(false);
  logX = physX; logY = physY;
}

static void statusLine() {
  float mx, my;
  stepsToMm(physX, physY, mx, my);
  char buf[224];
  snprintf(buf, sizeof(buf),
    "st q=%u free=%u px=%ld py=%ld lx=%ld ly=%ld mx=%.2f my=%.2f run=%d drop=%u "
    "rate=%u lon=%u map=%u cs=%u",
    (unsigned)qCount(), (unsigned)qFree(), (long)physX, (long)physY,
    (long)logX, (long)logY, mx, my, running ? 1 : 0, (unsigned)dropped, cfg.rate,
    cfg.limitsOn, cfg.hValid, cfg.cornerSet);
  emit(String(buf));
}

static void saveConfig() {
  prefs.begin("detent", false);
  prefs.putBytes("cfg", &cfg, sizeof(cfg));
  prefs.end();
}
static void loadConfig() {
  prefs.begin("detent", true);
  if (prefs.isKey("cfg")) {
    Config tmp;
    if (prefs.getBytes("cfg", &tmp, sizeof(tmp)) == sizeof(tmp)) cfg = tmp;
    if (cfg.hValid) rebuildInverse();
  }
  prefs.end();
}


// ---------------------------------------------------------------- arg parsing
// sscanf float support depends on how newlib was built. strtof does not, so all
// argument parsing goes through this instead.
static int argc_ = 0;
static float argv_[10];

static void parseArgs(const String &rest) {
  argc_ = 0;
  const char *p = rest.c_str();
  while (*p && argc_ < 10) {
    while (*p == ' ' || *p == '\t') p++;
    if (!*p) break;
    char *end;
    float v = strtof(p, &end);
    if (end == p) break;
    argv_[argc_++] = v;
    p = end;
  }
}
static float argf(int i, float dflt) { return i < argc_ ? argv_[i] : dflt; }
static int   argi(int i, int dflt)   { return i < argc_ ? (int)lroundf(argv_[i]) : dflt; }

// ---------------------------------------------------------------- protocol
//
//  ?                      status
//  V                      identify
//  H                      zero here, clear queue
//  S x,y,l x,y,l ...      queue absolute moves in STEPS (batched, one line)
//  M x y l                queue one absolute move in MM
//  J dx dy                jog relative steps
//  L 0|1                  laser now
//  R rate travel          step rates
//  B lashX lashY          backlash steps
//  G throw sep w h        geometry in mm
//  I invX invY            direction inversion (applied at the phase table)
//  N minX maxX minY maxY  soft limits in steps; bare N reports them
//  U 0|1                  enforce limits. 0 = free jog, use while calibrating
//  P n                    capture current position as corner n (0 TL 1 TR 2 BR 3 BL)
//  P                      report all four captured corners
//  A margin               derive limits from the four corners and enable them
//  Y h0..h7               load the corner homography; Y with no args clears it
//  E 0|1                  release / energise coils
//  X                      stop, flush, laser off
//  W                      persist config
//  C                      dump config

static volatile uint32_t lastRxMs = 0;

static void handle(String line) {
  lastRxMs = millis();
  line.trim();
  if (!line.length()) return;
  char c = line.charAt(0);
  String rest = line.substring(1); rest.trim();

  switch (c) {
    case '?': statusLine(); return;
    case 'V': emit("detent 1.3 esp32c3 spr=4075.77 dps=0.088327 tick=20000"); return;

    case 'H':
      stopAll(true);
      physX = physY = 0; logX = logY = 0;
      lashDirX = lashDirY = 1;
      emit("ok home"); return;

    case 'S': {
      int n = 0, ok = 0;
      int i = 0;
      while (i < (int)rest.length()) {
        int sp = rest.indexOf(' ', i);
        String tok = (sp < 0) ? rest.substring(i) : rest.substring(i, sp);
        i = (sp < 0) ? rest.length() : sp + 1;
        tok.trim(); if (!tok.length()) continue;
        int c1 = tok.indexOf(','), c2 = tok.indexOf(',', c1 + 1);
        if (c1 < 0 || c2 < 0) continue;
        int c3 = tok.indexOf(',', c2 + 1);
        long sx = tok.substring(0, c1).toInt();
        long sy = tok.substring(c1 + 1, c2).toInt();
        int  lz, iv = 0;
        if (c3 < 0) lz = tok.substring(c2 + 1).toInt();
        else { lz = tok.substring(c2 + 1, c3).toInt(); iv = tok.substring(c3 + 1).toInt(); }
        if (iv < 0) iv = 0; if (iv > 65535) iv = 65535;
        n++;
        if (moveToSteps(sx, sy, lz ? 1 : 0, (uint16_t)iv)) ok++;
        else break;
      }
      emit(String("ok ") + ok + "/" + n + " free=" + qFree());
      return;
    }

    case 'M': {
      parseArgs(rest);
      int32_t sx, sy; mmToSteps(argf(0, 0), argf(1, 0), sx, sy);
      int l = argi(2, 0);
      emit(moveToSteps(sx, sy, l ? 1 : 0) ? String("ok free=") + qFree() : "err full");
      return;
    }

    case 'J': {
      parseArgs(rest);
      emit(moveToSteps(logX + argi(0, 0), logY + argi(1, 0), 0) ? "ok" : "err full");
      return;
    }

    case 'L': writeLaser(rest.toInt() != 0); lastMoveMs = millis(); emit("ok"); return;

    case 'R': {
      parseArgs(rest);
      int a = argi(0, 0), b = argi(1, 0), r = argi(2, 0);
      if (a > 0) cfg.rate = a;
      if (b > 0) cfg.rateTravel = b;
      if (r > 0) cfg.rampSteps = r;
      emit("ok"); return;
    }

    case 'B': {
      parseArgs(rest);
      cfg.lashX = argi(0, 0); cfg.lashY = argi(1, 0); emit("ok"); return;
    }

    case 'G': {
      parseArgs(rest);
      float t = argf(0, 0), s = argf(1, -1), w = argf(2, 0), h = argf(3, 0);
      if (t > 1) cfg.throwMm = t;
      if (s >= 0) cfg.sepMm = s;
      if (w > 1) cfg.fieldW = w;
      if (h > 1) cfg.fieldH = h;
      emit("ok"); return;
    }

    case 'I': {
      parseArgs(rest);
      cfg.invX = argi(0, 0) ? 1 : 0;
      cfg.invY = argi(1, 0) ? 1 : 0;
      emit(String("ok inv=") + cfg.invX + "," + cfg.invY); return;
    }

    case 'N': {
      parseArgs(rest);
      if (argc_ >= 4) {
        cfg.minX = argi(0, cfg.minX); cfg.maxX = argi(1, cfg.maxX);
        cfg.minY = argi(2, cfg.minY); cfg.maxY = argi(3, cfg.maxY);
        if (cfg.minX > cfg.maxX) { int16_t t = cfg.minX; cfg.minX = cfg.maxX; cfg.maxX = t; }
        if (cfg.minY > cfg.maxY) { int16_t t = cfg.minY; cfg.minY = cfg.maxY; cfg.maxY = t; }
      }
      char b[96];
      snprintf(b, sizeof(b), "lim x=%d..%d y=%d..%d on=%u",
               cfg.minX, cfg.maxX, cfg.minY, cfg.maxY, cfg.limitsOn);
      emit(String(b)); return;
    }

    case 'U':
      parseArgs(rest);
      cfg.limitsOn = argi(0, 0) ? 1 : 0;
      emit(String("ok limits=") + cfg.limitsOn); return;

    case 'P': {
      parseArgs(rest);
      if (argc_ >= 1) {
        int n = argi(0, 0);
        if (n < 0 || n > 3) { emit("err corner 0..3"); return; }
        cfg.cx[n] = (int16_t)logX; cfg.cy[n] = (int16_t)logY;
        cfg.cornerSet |= (1 << n);
        char b[80];
        snprintf(b, sizeof(b), "ok corner %d = %ld,%ld set=%u",
                 n, (long)logX, (long)logY, cfg.cornerSet);
        emit(String(b)); return;
      }
      char b[160];
      snprintf(b, sizeof(b), "corners set=%u tl=%d,%d tr=%d,%d br=%d,%d bl=%d,%d",
               cfg.cornerSet, cfg.cx[0], cfg.cy[0], cfg.cx[1], cfg.cy[1],
               cfg.cx[2], cfg.cy[2], cfg.cx[3], cfg.cy[3]);
      emit(String(b)); return;
    }

    case 'A': {
      parseArgs(rest);
      if (cfg.cornerSet != 0x0F) { emit("err need all four corners"); return; }
      limitsFromCorners((int16_t)argi(0, 4));
      char b[96];
      snprintf(b, sizeof(b), "ok lim x=%d..%d y=%d..%d on=1",
               cfg.minX, cfg.maxX, cfg.minY, cfg.maxY);
      emit(String(b)); return;
    }

    case 'Y': {
      parseArgs(rest);
      if (argc_ < 8) {
        cfg.hValid = 0;
        emit("ok mapping cleared, using ideal model"); return;
      }
      for (int i = 0; i < 8; i++) cfg.h[i] = argf(i, 0);
      rebuildInverse();
      cfg.hValid = 1;
      emit("ok mapping loaded"); return;
    }

    case 'E':
      if (rest.toInt()) { writePhaseX(phX); writePhaseY(phY); coilsLive = true; }
      else { releaseCoils(); coilsLive = false; }
      emit("ok"); return;

    case 'D':
      parseArgs(rest);
      cfg.idleReleaseMs = (uint16_t)argi(0, cfg.idleReleaseMs);
      emit(String("ok idle=") + cfg.idleReleaseMs); return;

    case 'X': stopAll(true); dropped = 0; emit("ok stop"); return;
    case 'W': saveConfig(); emit("ok saved"); return;

    case 'Q': {
      char b[240];
      snprintf(b, sizeof(b),
        "qc1 rate=%u travel=%u ramp=%u lashx=%d lashy=%d minx=%d maxx=%d miny=%d maxy=%d "
        "lon=%u invx=%u invy=%u throw=%.2f sep=%.2f fw=%.1f fh=%.1f idle=%u",
        cfg.rate, cfg.rateTravel, cfg.rampSteps, cfg.lashX, cfg.lashY,
        cfg.minX, cfg.maxX, cfg.minY, cfg.maxY, cfg.limitsOn,
        cfg.invX, cfg.invY, cfg.throwMm, cfg.sepMm, cfg.fieldW, cfg.fieldH,
        cfg.idleReleaseMs);
      emit(String(b));
      snprintf(b, sizeof(b),
        "qc2 cs=%u c0=%d,%d c1=%d,%d c2=%d,%d c3=%d,%d map=%u",
        cfg.cornerSet, cfg.cx[0], cfg.cy[0], cfg.cx[1], cfg.cy[1],
        cfg.cx[2], cfg.cy[2], cfg.cx[3], cfg.cy[3], cfg.hValid);
      emit(String(b));
      if (cfg.hValid) {
        String hl = "qc3 h=";
        for (int i = 0; i < 8; i++) { if (i) hl += ","; hl += String(cfg.h[i], 9); }
        emit(hl);
      }
      emit("qc4 end");
      return;
    }

    case 'C': {
      char buf[288];
      snprintf(buf, sizeof(buf),
        "cfg rate=%u travel=%u lash=%d,%d lim=%d..%d,%d..%d on=%u throw=%.1f sep=%.1f "
        "field=%.1fx%.1f inv=%u,%u corners=%u map=%u",
        cfg.rate, cfg.rateTravel, cfg.lashX, cfg.lashY,
        cfg.minX, cfg.maxX, cfg.minY, cfg.maxY, cfg.limitsOn,
        cfg.throwMm, cfg.sepMm, cfg.fieldW, cfg.fieldH,
        cfg.invX, cfg.invY, cfg.cornerSet, cfg.hValid);
      emit(String(buf)); return;
    }
  }
  emit("err unknown");
}

// ---------------------------------------------------------------- BLE

#define NUS_SERVICE "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_RX      "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_TX      "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

class SrvCB : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { bleConnected = true; }
  void onDisconnect(BLEServer *s) override {
    bleConnected = false;
    stopAll(true);                     // link dropped, kill the beam
    s->startAdvertising();
  }
};

class RxCB : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *ch) override {
    String v = ch->getValue().c_str();
    for (size_t i = 0; i < v.length(); i++) {
      char ch2 = v[i];
      if (ch2 == '\n' || ch2 == '\r') { if (rxBle.length()) { handle(rxBle); rxBle = ""; } }
      else if (rxBle.length() < 400) rxBle += ch2;
    }
  }
};

static void startBLE() {
  BLEDevice::init("DETENT");
  BLEDevice::setMTU(247);
  BLEServer *srv = BLEDevice::createServer();
  srv->setCallbacks(new SrvCB());
  BLEService *svc = srv->createService(NUS_SERVICE);
  txChar = svc->createCharacteristic(NUS_TX, BLECharacteristic::PROPERTY_NOTIFY);
  txChar->addDescriptor(new BLE2902());
  BLECharacteristic *rx = svc->createCharacteristic(
      NUS_RX, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rx->setCallbacks(new RxCB());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
}

// ---------------------------------------------------------------- setup / loop

void setup() {
  Serial.begin(115200);

  buildMasks();
  for (int i = 0; i < 4; i++) { pinMode(PIN_X[i], OUTPUT); pinMode(PIN_Y[i], OUTPUT); }
  pinMode(PIN_LASER, OUTPUT);
  releaseCoils();
  writeLaser(false);

  loadConfig();

  gptimer_config_t tc = {};
  tc.clk_src = GPTIMER_CLK_SRC_DEFAULT;
  tc.direction = GPTIMER_COUNT_UP;
  tc.resolution_hz = 1000000;                 // 1 us tick
  gptimer_new_timer(&tc, &gpt);

  gptimer_event_callbacks_t cb = {};
  cb.on_alarm = onTick;
  gptimer_register_event_callbacks(gpt, &cb, NULL);

  gptimer_alarm_config_t ac = {};
  ac.alarm_count = 1000000 / TICK_HZ;         // 100 us
  ac.reload_count = 0;
  ac.flags.auto_reload_on_alarm = true;
  gptimer_set_alarm_action(gpt, &ac);
  gptimer_enable(gpt);
  gptimer_start(gpt);

  startBLE();
  lastMoveMs = millis();
  lastRxMs = millis();
  emit("detent ready");
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') { if (rxSerial.length()) { handle(rxSerial); rxSerial = ""; } }
    else if (rxSerial.length() < 400) rxSerial += c;
  }

  static uint32_t lastReport = 0;
  uint32_t now = millis();

  // Unsolicited flow-control tick. Fast while moving so the host window stays
  // fresh, slow but never silent while idle, so a lost notify can't wedge the
  // host waiting for a free= that never comes.
  uint32_t beat = (running || qCount() > 0) ? 150 : 700;
  if (now - lastReport > beat) {
    lastReport = now;
    statusLine();
  }

  // Dead-man: beam on, nothing queued, and the host has said nothing for 5 s
  // means the host is gone (tab asleep, link dropped mid-session). Park dark.
  if (laserOn && !running && qCount() == 0 && (now - lastRxMs) > 5000) {
    writeLaser(false);
    emit("warn deadman beam off");
  }

  // Idle release. These motors cook if you leave a phase energised all day.
  if (cfg.idleReleaseMs && coilsLive && !running && qCount() == 0 &&
      (now - lastMoveMs) > cfg.idleReleaseMs) {
    releaseCoils();
    coilsLive = false;
  }

  delay(1);
}
