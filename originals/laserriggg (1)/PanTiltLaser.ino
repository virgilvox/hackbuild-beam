/*
  PAN/TILT LASER RIG  --  NULLLAB Maker-ESP32 (ESP32-WROOM-32E)
  ============================================================================
  Two servos aim a laser at a wall; the beam gates on and off to draw. This is
  the hardware half of laser-rig.html. The web app runs a 3D simulation of this
  exact rig and, when you connect, streams the SAME commands to this board so the
  glow that lands on your wall matches what the sim predicted.

  This single firmware listens on BOTH links at once:
    - USB serial (115200)      -> laser-rig.html, Connect (Serial)
    - Bluetooth LE / NUS       -> laser-rig.html, Connect (Bluetooth)
  Whichever you connect with just works, no reflashing. Commands from either link
  feed one parser; every reply is mirrored to both (so the USB line also doubles
  as a debug log while you drive over BLE).

  PINS  (all three are normal GPIO on the WROOM-32E; 25/26 are DAC-capable but
         drive servos fine through LEDC, 23 is a clean digital output)
    Pan servo   -> GPIO 26   (signal; servo V+ to external 5V, grounds commoned)
    Tilt servo  -> GPIO 25   (signal; same 5V rail)
    Laser gate  -> GPIO 23   (logic level, see LASER DRIVE below)

  LASER DRIVE  (read this before wiring a real module)
    GPIO 23 is a plain digital gate: it goes HIGH while the beam is on and LOW when
    off, nothing fancier. Like every ESP32 pin it swings 3.3 V and sources only
    about 20-40 mA, so it never powers the laser itself. It just switches. That is
    enough to drive a bare 5 mW pointer diode on a dropper resistor and no more.
    Anything with its own driver board or a hotter diode gets a low-side switch and
    its own supply:
        GPIO23 --[220 ohm]--+---- gate (logic-level N-FET like AO3400; a 2N2222
                            |      base works for small loads)
                           [10k] to GND (holds it off during boot)
        laser (-)  -> drain/collector
        source/emitter -> common GND
        laser (+)  -> its own rated supply (+), sized for the module's current
    All the laser current comes from that supply through the FET; the pin only
    swings the gate. Common ground between the ESP32, the FET, and the laser supply
    is mandatory. If your module is active-low, send  POL 0  (default active-high).

  SAFETY
    - Laser is forced OFF at boot, on BLE disconnect, and by a dead-man timer:
      if nothing arrives and nothing is playing for DM milliseconds (default
      1500), the beam cuts. Segment playback counts as life, so a long queued
      job never trips it mid-stroke; a frozen browser tab still cannot leave
      the laser stuck on, because a dead sender stops refilling the queue and
      the timer starts the moment the queue drains.
    - Mid-job starvation gates the beam too: if the queue runs dry for more
      than 300 ms with the laser lit, the beam drops rather than burn a dot
      into the glow paint while it waits. The next segment re-lights it,
      because every segment carries its own gate.
    - Every cutoff respects the POL polarity setting.
    - Never aim this at anyone's eyes, at reflective surfaces, or out a window.
      Use a phosphor / glow-paint target for the fun stuff.

  WIRE PROTOCOL  (plain text, one command per line, \n terminated; case-insensitive)
    M p t l     aim now: pan pulse (us), tilt pulse (us), laser gate 0/1.
                Both axes and the gate move in one command so the beam never
                tears between a stale axis and a fresh one. Snaps immediately
                and clears any queued segments. This is what jogging and live
                pointer control use.
    SEG p t l d QUEUED timed move: be at pan p, tilt t in d milliseconds, with
                the laser gate at l for the whole segment. The board holds a
                48 deep queue and interpolates between segments on its own
                clock. This is what the plotter streams, and it is why plotting
                now looks like a drawn line instead of a row of dots: the app
                keeps a couple hundred milliseconds of segments queued ahead of
                real time, so a late packet never shows up as a stall in the
                beam.
    CFG         dump the whole stored configuration as one key=value line.
    CFG k=v ... store any of those keys and commit them to flash.
                The board is the thing that is physically installed, so it is
                the one that should remember how it is installed. Pulse window,
                origin, target size, throw, mount height, servo profile and all
                four calibrated corners live in NVS and survive a power cycle,
                a reflash of the app, and swapping which machine or which
                transport you connect from. Reconnect over serial, BLE or
                anything else and the app pulls this back rather than making
                you set it up again.
    DITHER n    1 to dither the output across the servo's deadband, 0 for off.
                Inside its deadband a servo ignores the command entirely, so the
                fine pulse values sent to it do nothing and the beam lands on a
                grid one deadband wide. Dithering deliberately alternates across
                that boundary, at the frame rate, so the servo is always being
                driven and its TIME AVERAGE sits where the plan asked. The
                servo's own mechanical lag does the averaging, and on glow paint
                so does the phosphor, which integrates whatever charge falls on
                it. Worth trying rather than guaranteed: how much it buys
                depends on the servo, and on a tired one it can chatter.
    REPORT n    stream position every n ms (0 stops). The app turns this on so
                the viewport shows where the servos really are instead of where
                they were told to go. Each report ends with the queue's free
                slot count, which the app reads as flow control: it stops
                feeding segments when the board says it is nearly full, so a
                long job can never overflow the queue and drop geometry.
    JOB n       start a job: clear the queue, reset the packet sequence, and
                record n as the nominal segment length in ms. The board uses
                that to work out how much time a lost packet was carrying.
    FLUSH       drop every queued segment and hold where you are.
    <binary>    A5 | count | seq | [pan16 tilt16 flags dur]*count | crc8
                A6 | count | seq | pan16 tilt16 flags dur
                                 | [dpan8 dtilt8 flags dur]*(count-1) | crc8
                A4 | count | seq | [pan16 tilt16 velp8 velt8 flags dur]*count | crc8
                Everything after the opening byte is escaped so that A4 through
                A7 never occur inside a packet: A7 04 through A7 07 stand in
                for them. That is not tidiness, it is the difference between a
                stream that recovers and one that does not. Delta bytes are
                arbitrary, so before escaping a payload byte could equal the
                opening byte; lose one byte anywhere and the framer locks onto a
                payload byte as a header and never finds its footing again. Every
                packet after it fails its checksum and its contents fall through
                to the text parser, which is exactly what a bad link looked like:
                a burst of ERR unknown with binary in it, and a checksum counter
                climbing without stopping. Escaped, the opening byte can only
                ever mean the start of a packet, so a lost byte costs one packet
                and the next one lands clean.
                The second is the same thing with the pulses delta coded against
                an absolute anchor at the head of the packet. Consecutive
                segments barely differ, so most of a flat packet is zeroes;
                deltas take four bytes a segment instead of six and fit three
                into one BLE write rather than two. Deltas never cross a packet
                boundary, so a lost packet still cannot corrupt the ones after
                it. STAT reports bin=2 when this format is understood.
                The A4 format, STAT herm=1, adds the pulse velocity the
                trajectory should have as it arrives at each endpoint, signed,
                in sixteenths of a microsecond per millisecond. The board plays
                a cubic from wherever it really is, moving however it really
                is, to that endpoint pair, so position AND velocity are
                continuous across every boundary: the servos see one flowing
                curve instead of straight lines with a speed step at each
                joint. It also means a lost packet splices back in smoothly,
                as a curved reroute rather than a straight-line lurch.
                The same segments as SEG, packed. Sixteen bytes carries two of
                them inside a single BLE write, against roughly forty bytes and
                two writes as text, and every extra packet on a BLE link is
                another chance to drop one.
                Little-endian pulses, flags bit 0 is the laser gate, dur in ms.
                crc8 is the usual 0x07 polynomial over everything before it, and
                it is load bearing: BLE writes arrive in 20 byte chunks, so a
                lost chunk splices the head of one packet onto the tail of
                another. Unchecked that lands as a bogus pulse and the beam
                jumps clean across the room.
                seq is the sequence of the first segment in the packet. When it
                does not follow on from the last, the board knows exactly how
                many segments went missing and stretches the one it did get to
                cover their time, so the drawing stays at the planned speed
                instead of racing ahead of it.
    ECHO n      1 to reply OK to every M / P / L / SEG, 0 to stay quiet.
                Default 0. Acking a 60 Hz stream floods the BLE notify path and
                is itself a cause of choppy motion, so leave it off while
                plotting and turn it on only when you are typing commands into a
                serial terminal by hand.
    P p t       position only, laser gate unchanged.
    L l         laser gate only (0/1). Ships immediately, bypasses nothing.
    RANGE a b   set servo pulse limits in us (default 500 2500). Values are
                clamped to this window; the sim uses the same window.
    POL n       laser polarity: 1 active-high (default), 0 active-low.
    ZERO        set the origin the rig returns to = the current aim. Saved to
                flash and restored on boot, so power-up returns to your start.
    ZERO p t    set the origin explicitly to pulses p, t (the app uses this).
    CENTER      move to the stored origin, laser off. (HOME is an alias.)
    DET         detach servos (they go limp). ATT re-attaches.
    ATT         attach servos.
    DM ms       dead-man timeout in ms (0 disables it).
    PING        heartbeat; resets the dead-man timer, replies OK.
    ?           print a STAT line. (STATUS is an alias.)

  POSITIONING
    There is no absolute reference on hobby servos, so aim is set by hand. Jog the
    rig with M / P commands (the app has a jog pad) until the beam sits where you
    want the drawing centered, then send ZERO. From then on the app offsets every
    plot from that origin, and CENTER or a power cycle returns the rig to it.

  Replies: "OK", "ERR <reason>", a CFG line, a position report:
    @ <panUs> <tiltUs> <laser> <free queue slots>
  or a STAT line:
    STAT pan=<us> tilt=<us> laser=<0/1> hp=<us> ht=<us> min=<us> max=<us> pol=<0/1>
         att=<0/1> dm=<ms> seg=1 bin=2 q=<free slots> echo=<0/1>
         lost=<n> crc=<n> qd=<n>
  The seg=1 field is how laser-rig.html knows this board takes timed segments.
  Flash an older build and the app silently falls back to plain M frames.

  BLE BACKEND
    Uses the ESP32 Arduino BLEDevice API. On core <=3.2 that is Bluedroid; on core
    >=3.3 the same API is NimBLE-backed. It compiles either way. The one NimBLE
    trap (do not call notify() from inside onWrite) is avoided here: onWrite only
    buffers bytes, and all parsing happens from loop(). Replies queue into a TX
    ring that loop() trickles out one small notify at a time, so a long STAT
    line can never block the segment servicer, and incoming bytes are taken
    with getData()/getLength() rather than through a C string, because packed
    segments are raw bytes and a zero byte is a perfectly ordinary thing for
    one of them to contain.

  LIBRARIES
    - ESP32Servo  (Library Manager: "ESP32Servo" by Kevin Harrington)
    - BLE support ships with the ESP32 Arduino core; no extra install.
  BOARD: "ESP32 Dev Module" (or your NULLLAB variant). Upload at 115200.
*/

#include <ESP32Servo.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>

// ---- pin map ---------------------------------------------------------------
static const int PIN_PAN   = 26;
static const int PIN_TILT  = 25;
static const int PIN_LASER = 23;

// ---- Nordic UART Service (de-facto "serial over BLE") ----------------------
#define NUS_SERVICE "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX      "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"   // browser -> board (write)
#define NUS_TX      "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"   // board -> browser (notify)
static const char* DEVICE_NAME = "LASER RIG";

// ---- state -----------------------------------------------------------------
Servo panServo, tiltServo;
Preferences prefs;

int   minUs   = 500;     // servo pulse window; RANGE changes these
int   maxUs   = 2500;
int   midUs   = 1500;    // recomputed from min/max
int   panUs   = 1500;    // last commanded pulses
int   tiltUs  = 1500;
int   homePanUs  = 1500; // origin the rig zeroes to (ZERO sets it, CENTER goes to it)
int   homeTiltUs = 1500;
bool  laserOn = false;
bool  activeHigh = true; // POL
bool  attached   = false;
uint32_t dmMs    = 1500; // dead-man timeout, 0 = off

// ---------------------------------------------------------------------------
//  PERSISTENT CONFIG
//  Everything about how this rig is installed, kept on the board rather than in
//  whichever browser happened to set it up. A rig that has been aimed at a wall
//  and had its corners captured should not lose that because you reconnected
//  from a different laptop.
// ---------------------------------------------------------------------------
float cfgWallW = 305, cfgWallH = 305, cfgDist = 152, cfgMountH = 70;
float cfgSlew = 240, cfgAccel = 1800, cfgDead = 8;
char  cfgServo[12] = "micro9g";
// four captured corners, in degrees; NaN means not captured
float calPan[4] = {NAN,NAN,NAN,NAN}, calTilt[4] = {NAN,NAN,NAN,NAN};
bool  calOn = false;
uint32_t reportMs = 0, lastReport = 0, lastRepForce = 0;
float avgSegMs = 17;   // running average of wire segment durations, for loss stretch
int   lastRepPan = -1, lastRepTilt = -1; bool lastRepLaser = false;

uint32_t lastCmd = 0;    // millis of last M/P/L/PING

// ---- BLE plumbing ----------------------------------------------------------
BLEServer*         bleServer = nullptr;
BLECharacteristic* txChar    = nullptr;
volatile bool      bleConnected = false;

// bytes received over BLE, drained in loop(). The BLE callback runs on a
// separate FreeRTOS task (possibly the other core) from loop(), so a plain
// String would race. A fixed ring buffer under a portMUX is heap-free and
// safe across cores.
static const size_t RB_SZ = 512;
static volatile uint8_t rb[RB_SZ];
static volatile size_t rbHead = 0, rbTail = 0;
portMUX_TYPE rbMux = portMUX_INITIALIZER_UNLOCKED;

// bytes to notify out over BLE, drained in loop(). reply() used to push each
// chunk inline with a blocking delay between them, which stalled the segment
// servicer for tens of milliseconds every time a long line went out, and a
// stalled servicer is a stutter in the beam. Now replies land here and loop()
// trickles them out between everything else. Only loop() touches this ring,
// so it needs no lock.
static const size_t TB_SZ = 1024;
static uint8_t tb[TB_SZ];
static size_t tbHead = 0, tbTail = 0;
uint32_t lastNotify = 0;
volatile bool bleResetReq = false;   // set by onDisconnect, serviced in loop()

// separate line assembly per transport so partial lines never interleave
String serialLine;
String bleLine;

// ============================================================================
//  low-level helpers
// ============================================================================
void driveLaser(bool on) {
  laserOn = on;
  digitalWrite(PIN_LASER, (on == activeHigh) ? HIGH : LOW);
}

void recomputeMid() {
  if (maxUs < minUs) { int t = minUs; minUs = maxUs; maxUs = t; }
  midUs = (minUs + maxUs) / 2;
}

int clampUs(int v) {
  if (v < minUs) return minUs;
  if (v > maxUs) return maxUs;
  return v;
}

/* Dither to linearise the deadband.

   A servo does not quantise position onto a grid. Its deadband is hysteresis:
   below some error the motor is simply off, so it stops wherever it happened to
   get to, up to half a deadband short of the command, on whichever side it
   approached from. That is why a retraced line misses itself, and why a slow
   move creeps in fits.

   The fix is the classic one for a dead zone: add a small symmetric carrier so
   the motor is always being driven, and let the mechanics average it out. The
   carrier has to be symmetric, which was the flaw in the first attempt here.
   Quantising onto a deadband-sized grid looked reasonable but is not symmetric
   about the command: the servo could follow the near side of the grid and not
   the far side, so the average walked off toward whichever grid line was
   closer, and it was measurably worse than not dithering at all.

   A plain alternating plus and minus about the true value does not have that
   problem. The command itself stays exactly where the planner put it. */
uint32_t lastDither = 0;
bool  ditherOn = false;   // off unless asked: it keeps both servos hunting
float cfgLeadP = 0, cfgLeadT = 0;   // per-axis lead in ms: see the interpolator
int8_t ditherPhase = 1;

void applyServos() {
  if (!attached) return;
  /* The carrier phase flips once per servo frame; the offset rides on top of
     the LIVE command at every write. The old version froze a snapshot of the
     command for the whole frame, which quietly dropped the segment
     interpolator's update rate to 50 Hz whenever dithering was on: the one
     setting meant to make lines finer was making them steppier. */
  uint32_t now = millis();
  if (now - lastDither >= 20) { lastDither = now; ditherPhase = -ditherPhase; }
  int p = panUs, t = tiltUs;
  if (ditherOn && cfgDead >= 2) {
    const int a = (int) lroundf(cfgDead * 0.75f); // just enough to clear the dead zone
    p = clampUs(p + ditherPhase * a);
    t = clampUs(t + ditherPhase * a);
  }
  panServo.writeMicroseconds(p);
  tiltServo.writeMicroseconds(t);
}

void attachServos() {
  if (attached) return;                  // idempotent: ATT at plot start is free
  panServo.setPeriodHertz(50);
  tiltServo.setPeriodHertz(50);
  panServo.attach(PIN_PAN,  minUs, maxUs);
  tiltServo.attach(PIN_TILT, minUs, maxUs);
  attached = true;
  applyServos();
}

void detachServos() {
  panServo.detach();
  tiltServo.detach();
  attached = false;
}

// ============================================================================
//  SEGMENT QUEUE  --  the reason plotting is smooth
//  An M command snaps the servos to a new pulse the moment it lands. Stream a
//  few dozen of those a second down a link with any jitter and the motion comes
//  out as a stutter: the beam only moves during the gap the servo needs to
//  catch up, and it is stopped the rest of the time.
//  SEG says something different. Be at p,t in d milliseconds. The board keeps a
//  queue of those and interpolates between them on its own clock, so it is
//  always mid-move, and a packet arriving late just means the board is still
//  busy finishing the previous segment. Continuous motion, no dependence on
//  packet timing.
// ============================================================================
struct Seg { int16_t pan; int16_t tilt; int8_t vp; int8_t vt; uint8_t flags; uint8_t laser; uint16_t dur; };
static const int SEGQ = 48;
Seg  segBuf[SEGQ];
int  segHead = 0, segTail = 0;
bool segActive = false, segChain = false;
int  segFromPan = 1500, segFromTilt = 1500, segToPan = 1500, segToTilt = 1500;
uint32_t segT0 = 0, segEnd = 0, lastServoWrite = 0;
uint16_t segDur = 0;
float segV0P = 0, segV0T = 0, segV1P = 0, segV1T = 0;  // tangents, us per ms
float velP = 0, velT = 0;      // the trajectory's live velocity, us per ms
bool echoOn = false;          // ECHO 1 restores the per-command OK replies


void configSave() {
  prefs.putInt("min", minUs);      prefs.putInt("max", maxUs);
  prefs.putInt("hpu", homePanUs);  prefs.putInt("htu", homeTiltUs);
  prefs.putBool("pol", activeHigh); prefs.putUInt("dm", dmMs);
  prefs.putFloat("ww", cfgWallW);  prefs.putFloat("wh", cfgWallH);
  prefs.putFloat("ds", cfgDist);   prefs.putFloat("mh", cfgMountH);
  prefs.putFloat("sl", cfgSlew);   prefs.putFloat("ac", cfgAccel);
  prefs.putFloat("db", cfgDead);   prefs.putString("sv", cfgServo);
  prefs.putBool("cal", calOn);
  prefs.putBool("dit", ditherOn);
  prefs.putFloat("ffp", cfgLeadP); prefs.putFloat("fft", cfgLeadT);
  prefs.putBytes("cp", calPan,  sizeof(calPan));
  prefs.putBytes("ct", calTilt, sizeof(calTilt));
}

void configLoad() {
  minUs      = prefs.getInt("min", 500);
  maxUs      = prefs.getInt("max", 2500);
  activeHigh = prefs.getBool("pol", true);
  dmMs       = prefs.getUInt("dm", 1500);
  recomputeMid();
  homePanUs  = prefs.getInt("hpu", midUs);
  homeTiltUs = prefs.getInt("htu", midUs);
  cfgWallW   = prefs.getFloat("ww", 305);
  cfgWallH   = prefs.getFloat("wh", 305);
  cfgDist    = prefs.getFloat("ds", 152);
  cfgMountH  = prefs.getFloat("mh", 70);
  cfgSlew    = prefs.getFloat("sl", 240);
  cfgAccel   = prefs.getFloat("ac", 1800);
  cfgDead    = prefs.getFloat("db", 8);
  String sv  = prefs.getString("sv", "micro9g");
  sv.toCharArray(cfgServo, sizeof(cfgServo));
  calOn      = prefs.getBool("cal", false);
  ditherOn   = prefs.getBool("dit", false);
  cfgLeadP   = prefs.getFloat("ffp", 0);
  cfgLeadT   = prefs.getFloat("fft", 0);
  if (prefs.getBytesLength("cp") == sizeof(calPan))  prefs.getBytes("cp", calPan,  sizeof(calPan));
  if (prefs.getBytesLength("ct") == sizeof(calTilt)) prefs.getBytes("ct", calTilt, sizeof(calTilt));
}

// corners are tl tr bl br, in that order
static const char* CORNER_KEY[4] = {"tl","tr","bl","br"};

String configLine() {
  char b[420];
  int n = snprintf(b, sizeof(b),
    "CFG min=%d max=%d hp=%d ht=%d pol=%d dm=%lu ww=%.1f wh=%.1f ds=%.1f mh=%.1f "
    "sl=%.0f ac=%.0f db=%.1f sv=%s cal=%d",
    minUs, maxUs, homePanUs, homeTiltUs, activeHigh ? 1 : 0, (unsigned long)dmMs,
    cfgWallW, cfgWallH, cfgDist, cfgMountH, cfgSlew, cfgAccel, cfgDead,
    cfgServo, calOn ? 1 : 0);
  n += snprintf(b + n, sizeof(b) - n, " dit=%d ffp=%.1f fft=%.1f",
                ditherOn ? 1 : 0, cfgLeadP, cfgLeadT);
  for (int i = 0; i < 4 && n < (int)sizeof(b) - 40; i++) {
    if (isnan(calPan[i])) continue;
    n += snprintf(b + n, sizeof(b) - n, " %s=%.2f,%.2f",
                  CORNER_KEY[i], calPan[i], calTilt[i]);
  }
  return String(b);
}

// one key=value token out of a CFG line
void configSet(const String& k, const String& v) {
  if      (k == "min") { minUs = v.toInt(); recomputeMid(); }
  else if (k == "max") { maxUs = v.toInt(); recomputeMid(); }
  else if (k == "hp")  homePanUs  = v.toInt();
  else if (k == "ht")  homeTiltUs = v.toInt();
  else if (k == "pol") activeHigh = v.toInt() != 0;
  else if (k == "dm")  dmMs = v.toInt();
  else if (k == "ww")  cfgWallW = v.toFloat();
  else if (k == "wh")  cfgWallH = v.toFloat();
  else if (k == "ds")  cfgDist = v.toFloat();
  else if (k == "mh")  cfgMountH = v.toFloat();
  else if (k == "sl")  cfgSlew = v.toFloat();
  else if (k == "ac")  cfgAccel = v.toFloat();
  else if (k == "db")  cfgDead = v.toFloat();
  else if (k == "sv")  v.toCharArray(cfgServo, sizeof(cfgServo));
  else if (k == "cal") calOn = v.toInt() != 0;
  else if (k == "dit") ditherOn = v.toInt() != 0;
  else if (k == "ffp") cfgLeadP = v.toFloat();
  else if (k == "fft") cfgLeadT = v.toFloat();
  else {
    for (int i = 0; i < 4; i++) {
      if (k != CORNER_KEY[i]) continue;
      int c = v.indexOf(',');
      if (c < 0) { calPan[i] = calTilt[i] = NAN; return; }
      calPan[i]  = v.substring(0, c).toFloat();
      calTilt[i] = v.substring(c + 1).toFloat();
      return;
    }
  }
}

// --- packed binary segment reception ---
static const uint8_t BIN_MAGIC   = 0xA5;   // flat: every pulse absolute
static const uint8_t BIN_MAGIC_D = 0xA6;   // anchor plus signed byte deltas
static const uint8_t BIN_ESC     = 0xA7;   // next byte is a literal, low nibble
static const uint8_t BIN_MAGIC_H = 0xA4;   // hermite: endpoint plus endpoint velocity

/* One framer per transport. They used to share a single set of these, so a few
   stray bytes on the idle link could walk the other one's packet boundary.

   Selected by index rather than passed by reference, which looks like a step
   backwards and is not. The Arduino IDE builds a .ino by generating prototypes
   for every function and inserting them above your code, so a function whose
   signature names a type you declared yourself gets a prototype that mentions a
   type nothing has heard of yet. It fails to compile in the IDE while building
   perfectly with a plain compiler, which is exactly how this reached the bench.
   An int in the signature has no such problem. */
static const int BINF_SERIAL = 0, BINF_BLE = 1;
struct BinFramer {
  uint8_t  buf[96];
  int      len = 0, need = 0;
  bool     active = false, delta = false, herm = false, esc = false;
  uint32_t opened = 0;
};
BinFramer binFramers[2];
uint8_t  expectSeq = 0;
bool     seqPrimed = false;
uint16_t nominalMs = 17;      // set by JOB; used to price a lost packet
uint32_t lostSegs = 0, badCrc = 0;
uint32_t qDrops = 0;          // segments that arrived to a full queue
uint32_t lastSegDone = 0;     // when the last segment finished playing
bool     jobArmed = false;    // a JOB is running; enables the starvation gate

uint8_t crc8calc(const uint8_t* d, int n) {
  uint8_t c = 0;
  for (int i = 0; i < n; i++) {
    c ^= d[i];
    for (int b = 0; b < 8; b++) c = (c & 0x80) ? (uint8_t)((c << 1) ^ 0x07) : (uint8_t)(c << 1);
  }
  return c;
}

int  segCount() { int n = segHead - segTail; if (n < 0) n += SEGQ; return n; }
int  segFree()  { return SEGQ - 1 - segCount(); }
void segClear() { segTail = segHead; segActive = false; segChain = false; velP = velT = 0; }

bool segPush(int p, int t, uint8_t l, uint16_t d, int8_t vp, int8_t vt, uint8_t fl) {
  int nx = (segHead + 1) % SEGQ;
  if (nx == segTail) return false;                 // queue full
  segBuf[segHead].pan   = (int16_t) p;
  segBuf[segHead].tilt  = (int16_t) t;
  segBuf[segHead].vp    = vp;
  segBuf[segHead].vt    = vt;
  segBuf[segHead].flags = fl;
  segBuf[segHead].laser = l;
  segBuf[segHead].dur   = d ? d : 1;
  segHead = nx;
  return true;
}

// Called every pass through loop(), so interpolation resolution is set by how
// fast loop() spins, not by how fast packets arrive.
void serviceSegments() {
  uint32_t now = millis();
  if (!segActive && segTail == segHead) {
    /* Mid-job starvation: the sender stalled and the queue ran dry. Holding
       the beam lit at a dead stop burns a dot into the glow paint until the
       dead-man notices, so gate it off after a short grace. The next segment
       re-lights it, because every segment carries its own gate. */
    if (jobArmed && laserOn && now - lastSegDone > 300) { driveLaser(false); velP = velT = 0; }
    return;
  }
  int guard = 0;
  while (guard++ < SEGQ) {
    if (!segActive) {
      if (segTail == segHead) return;
      Seg s = segBuf[segTail];
      segTail = (segTail + 1) % SEGQ;
      segFromPan = panUs;  segFromTilt = tiltUs;
      segToPan   = clampUs(s.pan);
      segToTilt  = clampUs(s.tilt);
      segDur     = s.dur;
      /* Continuity is a claim, not a default. If the queue starved long
         enough that this segment starts from a resync, the velocity tracked
         before the gap describes a trajectory that no longer exists; the
         starvation gate only zeroes it when the beam was lit. */
      bool cont = segChain && (uint32_t)(now - segEnd) < 250;
      if (!cont) { velP = velT = 0; }
      /* Hermite tangents. A packed segment carries the velocity the
         trajectory should have as it ARRIVES at the endpoint; the curve
         starts from whatever position and velocity the board really has, so
         every boundary is seamless and the hole left by a lost packet gets
         spliced over by a smooth reroute instead of a straight-line lurch.
         Legacy segments carry no velocity: both tangents get the chord and
         the cubic collapses to exactly the straight line old senders expect. */
      segV0P = velP; segV0T = velT;
      if (s.flags & 1) {
        segV1P = s.vp / 16.0f;
        segV1T = s.vt / 16.0f;
        /* Overshoot guard. A healthy segment's tangents sit near its chord
           slope and pass untouched. A splice over a big hole starts from a
           real velocity that can dwarf the stretched chord, and a cubic
           given a tangent several times its chord swings far outside it.
           Capping each tangent at three chord slopes plus a fixed few
           microseconds of headroom bounds the whole curve to about 1.4
           chords: the damage a bad splice can do stays proportional to the
           gap it covers, on every axis, however long the stretch runs. */
        float limP = (3.0f * fabsf(segToPan  - segFromPan)  + 24.0f) / (float) segDur;
        float limT = (3.0f * fabsf(segToTilt - segFromTilt) + 24.0f) / (float) segDur;
        if (segV0P >  limP) segV0P =  limP;
        if (segV0P < -limP) segV0P = -limP;
        if (segV1P >  limP) segV1P =  limP;
        if (segV1P < -limP) segV1P = -limP;
        if (segV0T >  limT) segV0T =  limT;
        if (segV0T < -limT) segV0T = -limT;
        if (segV1T >  limT) segV1T =  limT;
        if (segV1T < -limT) segV1T = -limT;
      } else {
        segV1P = (segToPan  - segFromPan)  / (float) segDur;
        segV1T = (segToTilt - segFromTilt) / (float) segDur;
        segV0P = segV1P; segV0T = segV1T;
      }
      // start where the previous segment was meant to finish, so a long job
      // does not accumulate a millisecond of drift per frame. If the queue
      // starved for a while, resync to now instead.
      segT0  = cont ? segEnd : now;
      segEnd = segT0 + segDur;
      segChain  = false;
      segActive = true;
      driveLaser(s.laser != 0);
      lastCmd = now;                    // playback counts as life for the dead-man
    }
    uint32_t el = (now >= segT0) ? (now - segT0) : 0;
    if (el < segDur) {
      float D   = (float) segDur;
      float T   = (float) el / D;
      float h00 = (2*T - 3)*T*T + 1;
      float h10 = ((T - 2)*T + 1)*T;
      float h01 = (3 - 2*T)*T*T;
      float h11 = (T - 1)*T*T;
      float pp  = h00*segFromPan  + h10*D*segV0P + h01*segToPan  + h11*D*segV1P;
      float pt  = h00*segFromTilt + h10*D*segV0T + h01*segToTilt + h11*D*segV1T;
      float d00 = 6*T*T - 6*T;
      float d10 = 3*T*T - 4*T + 1;
      float d11 = 3*T*T - 2*T;
      velP = d00*(segFromPan  - segToPan)  / D + d10*segV0P + d11*segV1P;
      velT = d00*(segFromTilt - segToTilt) / D + d10*segV0T + d11*segV1T;
      /* Lead is a per-axis phase advance: command an axis a few milliseconds
         into its own future. The pan servo hauls the whole tilt assembly, so
         it answers late and coordinated diagonals grow a hook at every stroke
         start; two or three milliseconds of lead on pan straightens them
         without touching the geometry. Position plus lead times velocity is
         the first-order expansion of evaluating the curve at t plus lead,
         which is exact on the constant-acceleration ramps the planner emits. */
      panUs  = clampUs((int) lroundf(pp + cfgLeadP * velP));
      tiltUs = clampUs((int) lroundf(pt + cfgLeadT * velT));
      // An analogue servo latches one position per 20 ms frame, so it was
      // tempting to write on a matching 20 ms cadence. That is worse, not
      // better: two free-running 20 ms clocks drift against each other, so a
      // write lands anywhere from just before a frame boundary to a whole
      // frame early, and the latched value carries 0 to 20 ms of wander with
      // it. Writing far faster than the frame costs nothing and means whatever
      // the servo latches is always the freshest value, which is also exactly
      // what the direct-drive path does when it applies an M command the
      // instant it arrives.
      if (now - lastServoWrite >= 2) { lastServoWrite = now; applyServos(); }
      return;
    }
    panUs = segToPan; tiltUs = segToTilt;          // land exactly on the endpoint
    velP = segV1P; velT = segV1T;
    applyServos(); lastServoWrite = now;
    segActive = false;
    segChain  = true;
    lastSegDone = now;
  }
}

// mirror a reply to whichever links are live. The USB side prints straight
// into the UART's own buffer; the BLE side queues into the TX ring for loop()
// to trickle out, because notify() stalls or drops when the stack is
// congested and blocking here starves the segment queue. If the ring is full
// the line is dropped: replies are advisory, the beam is not.
void reply(const String& s) {
  Serial.println(s);
  if (!bleConnected || !txChar) return;
  size_t need = s.length() + 1;
  size_t room = (tbTail + TB_SZ - tbHead - 1) % TB_SZ;
  if (need > room) return;
  for (size_t i = 0; i < s.length(); i++) { tb[tbHead] = (uint8_t) s[i]; tbHead = (tbHead + 1) % TB_SZ; }
  tb[tbHead] = '\n'; tbHead = (tbHead + 1) % TB_SZ;
}

void sendStat() {
  char buf[260];
  snprintf(buf, sizeof(buf),
    "STAT pan=%d tilt=%d laser=%d hp=%d ht=%d min=%d max=%d pol=%d att=%d dm=%lu "
    "seg=1 bin=2 herm=1 q=%d echo=%d lost=%lu crc=%lu qd=%lu",
    panUs, tiltUs, laserOn ? 1 : 0, homePanUs, homeTiltUs, minUs, maxUs,
    activeHigh ? 1 : 0, attached ? 1 : 0, (unsigned long)dmMs,
    segFree(), echoOn ? 1 : 0, (unsigned long)lostSegs, (unsigned long)badCrc,
    (unsigned long)qDrops);
  reply(String(buf));
}

void saveConfig() { configSave(); }   // one place writes flash, so nothing gets missed

// ============================================================================
//  command parser  (one line in, acts, replies)
// ============================================================================
/* Feed one segment out of a decoded packet. A sequence gap means packets were
   dropped between this one and the last; their positions are gone but their
   time is not, so the segment that did arrive is stretched to cover the gap.
   Without that the board runs ahead of the plan and the whole drawing speeds
   up every time the link hiccups. */
void binSegment(int pan, int tilt, uint8_t on, uint16_t dur, uint8_t seq,
                int8_t vp, int8_t vt, uint8_t fl) {
  uint16_t d0 = dur;
  if (seqPrimed) {
    uint8_t gap = (uint8_t)(seq - expectSeq);
    if (gap) {
      lostSegs += gap;
      /* Segments are not a fixed length: they run from a millisecond to a
         hundred and fifty, ended wherever the tolerance says. A single
         neighbour used to stand in for the lost ones, which was fine when a
         packet carried two segments and a gap meant two guesses; at eight to
         a packet one bad sample gets multiplied by eight, and the bench
         measured the plot running a tenth of a second off tempo from one
         drop. A running average of what has actually been arriving is the
         honest estimator, seeded from the JOB nominal. */
      uint32_t est = (uint32_t) lroundf(avgSegMs < 1 ? 1 : avgSegMs);
      uint32_t stretched = (uint32_t)dur + (uint32_t)gap * est;
      dur = (uint16_t)(stretched > 60000 ? 60000 : stretched);
      /* The wire velocity was sized for the original duration. The hermite
         tangent term scales with duration, so playing a stretched segment
         with the unscaled velocity bulges the splice off its chord, beam on.
         The same ground covered over more time is slower ground: scale the
         arrival velocity down by the same ratio and the curve stays inside
         the line it is standing in for. */
      if ((fl & 1) && d0 && dur > d0) {
        vp = (int8_t) lroundf(vp * (float) d0 / (float) dur);
        vt = (int8_t) lroundf(vt * (float) d0 / (float) dur);
      }
    }
  }
  expectSeq = (uint8_t)(seq + 1);
  seqPrimed = true;
  if (d0) avgSegMs += ((float) d0 - avgSegMs) * 0.125f;
  if (!segPush(clampUs(pan), clampUs(tilt), on, dur, vp, vt, fl)) qDrops++;
  lastCmd = millis();
}

/* Returns true if the byte belonged to a packet on this transport.

   The opening byte cannot occur inside a packet, because the sender escapes it.
   That one property is what makes the stream recover: seeing an opening byte
   always means a packet starts here, so a lost byte spoils the packet it was in
   and nothing after it. */
bool binFeed(int which, uint8_t b) {
  BinFramer& f = binFramers[which];
  if (!f.active) {
    if (b != BIN_MAGIC && b != BIN_MAGIC_D && b != BIN_MAGIC_H) return false;
    f.active = true; f.len = 0; f.need = 0; f.esc = false;
    f.delta  = (b == BIN_MAGIC_D);
    f.herm   = (b == BIN_MAGIC_H);
    f.opened = millis();
    f.buf[f.len++] = b;
    return true;
  }

  // an opening byte part way through means the packet being built never finished
  if (!f.esc && (b == BIN_MAGIC || b == BIN_MAGIC_D || b == BIN_MAGIC_H)) {
    f.len = 0; f.need = 0; f.delta = (b == BIN_MAGIC_D); f.herm = (b == BIN_MAGIC_H);
    f.opened = millis();
    f.buf[f.len++] = b;
    return true;
  }
  if (!f.esc && b == BIN_ESC) { f.esc = true; return true; }
  if (f.esc) { b = (uint8_t)(0xA0 | (b & 0x0F)); f.esc = false; }

  if (f.len < (int) sizeof(f.buf)) f.buf[f.len++] = b;
  else { f.active = false; f.len = 0; return true; }        // runaway, give up

  if (f.len == 2) {
    int count = f.buf[1];
    if (count < 1 || count > (f.herm ? 8 : 10)) { f.active = false; f.len = 0; return true; }
    f.need = f.herm  ? (3 + count * 8 + 1)
           : f.delta ? (3 + 6 + (count-1) * 4 + 1)
           :           (3 + count * 6 + 1);
  }
  if (f.need && f.len >= f.need) {
    int count = f.buf[1];
    if (crc8calc(f.buf, f.need - 1) == f.buf[f.need - 1]) {
      uint8_t seq = f.buf[2];
      if (f.herm) {
        for (int i = 0; i < count; i++) {
          const uint8_t* p = f.buf + 3 + i * 8;
          binSegment((int)(p[0] | (p[1] << 8)), (int)(p[2] | (p[3] << 8)),
                     p[6] & 1, p[7], (uint8_t)(seq + i),
                     (int8_t) p[4], (int8_t) p[5], 1);
        }
      } else if (!f.delta) {
        for (int i = 0; i < count; i++) {
          const uint8_t* p = f.buf + 3 + i * 6;
          binSegment((int)(p[0] | (p[1] << 8)), (int)(p[2] | (p[3] << 8)),
                     p[4] & 1, p[5], (uint8_t)(seq + i), 0, 0, 0);
        }
      } else {
        const uint8_t* p = f.buf + 3;
        int pan  = (int)(p[0] | (p[1] << 8));
        int tilt = (int)(p[2] | (p[3] << 8));
        binSegment(pan, tilt, p[4] & 1, p[5], seq, 0, 0, 0);
        for (int i = 1; i < count; i++) {
          const uint8_t* q = f.buf + 9 + (i-1) * 4;
          pan  += (int8_t) q[0];
          tilt += (int8_t) q[1];
          binSegment(pan, tilt, q[2] & 1, q[3], (uint8_t)(seq + i), 0, 0, 0);
        }
      }
    } else {
      /* A bad checksum is a corrupted or truncated packet. Dropping it costs
         a few segments; trusting it would put the beam somewhere it was never
         asked to go, which on a laser is not a rounding error.
         The sequence stays primed on purpose. expectSeq still describes the
         last GOOD packet, so the next good one shows exactly how many
         segments died in between and gets stretched to cover their time.
         Unpriming here threw that away, which meant every corrupted packet
         also silently deleted its time from the drawing and the board ran
         ahead of the plan. */
      badCrc++;
    }
    f.active = false; f.len = 0; f.need = 0; f.esc = false;
  }
  return true;
}

/* A packet that stops arriving part way must not hold the framer open, or the
   text that follows it disappears into a packet that will never complete. */
void binIdleCheck(int which) {
  BinFramer& f = binFramers[which];
  if (f.active && millis() - f.opened > 250) { f.active = false; f.len = 0; f.esc = false; }
}

void handleLine(String line) {
  line.trim();
  if (line.length() == 0) return;

  // split into up to 6 tokens (SEG takes four arguments)
  String tok[6]; int nt = 0;
  int start = 0;
  for (int i = 0; i <= line.length() && nt < 6; i++) {
    if (i == line.length() || line[i] == ' ' || line[i] == '\t') {
      if (i > start) tok[nt++] = line.substring(start, i);
      start = i + 1;
    }
  }
  if (nt == 0) return;

  String cmd = tok[0]; cmd.toUpperCase();
  uint32_t now = millis();

  if (cmd == "M") {                         // aim now: pan tilt laser
    if (nt < 4) { reply("ERR M needs p t l"); return; }
    segClear();                              // a direct aim wins over the queue
    jobArmed = false;                        // and ends the job as far as the gate cares
    panUs  = clampUs(tok[1].toInt());
    tiltUs = clampUs(tok[2].toInt());
    applyServos();
    driveLaser(tok[3].toInt() != 0);
    lastCmd = now;
    if (echoOn) reply("OK");
  }
  else if (cmd == "SEG") {                   // queued timed move: p t laser ms
    if (nt < 5) { reply("ERR SEG needs p t l ms"); return; }
    if (!segPush(clampUs(tok[1].toInt()), clampUs(tok[2].toInt()),
                 tok[3].toInt() != 0 ? 1 : 0, (uint16_t) tok[4].toInt(), 0, 0, 0)) {
      reply("ERR segq full");                // always worth hearing about
    } else if (echoOn) reply("OK");
    lastCmd = now;
  }
  else if (cmd == "FLUSH") {                 // abandon the queue, hold position
    segClear();
    jobArmed = false;
    binFramers[0].active = binFramers[1].active = false;
    binFramers[0].len = binFramers[1].len = 0;
    seqPrimed = false;
    lastCmd = now;
    reply("OK");
  }
  else if (cmd == "CFG") {                   // read or write the stored setup
    if (nt < 2) { reply(configLine()); return; }
    int sp = line.indexOf(' ');
    String rest = line.substring(sp + 1);
    int i = 0;
    while (i < (int)rest.length()) {
      int e = rest.indexOf(' ', i); if (e < 0) e = rest.length();
      int q = rest.indexOf('=', i);
      if (q > i && q < e) configSet(rest.substring(i, q), rest.substring(q + 1, e));
      i = e + 1;
    }
    configSave();                            // committed, so it survives a power cut
    reply("OK");
  }
  else if (cmd == "DITHER") {                // sub-deadband positioning
    ditherOn = (nt > 1) ? tok[1].toInt() != 0 : true;
    reply("OK");
  }
  else if (cmd == "REPORT") {                // stream where the servos really are
    reportMs = (nt > 1) ? (uint32_t)tok[1].toInt() : 0;
    lastRepPan = -1;                         // force the first one out
    reply("OK");
  }
  else if (cmd == "JOB") {                   // start a job: reset the sequence
    segClear();
    for (int i = 0; i < 2; i++) {
      binFramers[i].active = false;
      binFramers[i].len = binFramers[i].need = 0;
      binFramers[i].esc = false;
    }
    seqPrimed = false; lostSegs = 0; badCrc = 0; qDrops = 0;
    nominalMs = (nt > 1) ? (uint16_t)tok[1].toInt() : 17;
    if (nominalMs < 1) nominalMs = 1;
    avgSegMs = nominalMs;                    // seed the loss estimator fresh
    jobArmed = true;
    lastSegDone = now;
    lastCmd = now;
    reply("OK");
  }
  else if (cmd == "ECHO") {                  // 0 = quiet (default), 1 = ack all
    if (nt < 2) { reply("ERR ECHO needs 0/1"); return; }
    echoOn = tok[1].toInt() != 0;
    reply("OK");
  }
  else if (cmd == "P") {                     // position only
    if (nt < 3) { reply("ERR P needs p t"); return; }
    segClear();
    jobArmed = false;
    panUs  = clampUs(tok[1].toInt());
    tiltUs = clampUs(tok[2].toInt());
    applyServos();
    lastCmd = now;
    if (echoOn) reply("OK");
  }
  else if (cmd == "L") {                     // laser gate only
    if (nt < 2) { reply("ERR L needs 0/1"); return; }
    jobArmed = false;                        // a hand on the gate outranks the job
    driveLaser(tok[1].toInt() != 0);
    lastCmd = now;
    if (echoOn) reply("OK");
  }
  else if (cmd == "RANGE") {
    if (nt < 3) { reply("ERR RANGE needs a b"); return; }
    int a = tok[1].toInt(), b = tok[2].toInt();
    if (a == minUs && b == maxUs) { sendStat(); return; }  // nothing changed:
                                     // no servo glitch, no flash write. The app
                                     // sends RANGE at every plot start, and
                                     // re-arming the servos for the same window
                                     // was a twitch at the top of every job.
    minUs = a;
    maxUs = b;
    recomputeMid();
    if (attached) { detachServos(); attachServos(); }  // re-arm with new window
    panUs = clampUs(panUs); tiltUs = clampUs(tiltUs);
    saveConfig();
    sendStat();
  }
  else if (cmd == "POL") {
    if (nt < 2) { reply("ERR POL needs 0/1"); return; }
    activeHigh = tok[1].toInt() != 0;
    driveLaser(laserOn);                     // re-assert with new polarity
    saveConfig();
    sendStat();
  }
  else if (cmd == "ZERO") {                  // set the origin the rig returns to; saved
    if (nt >= 3) { homePanUs = clampUs(tok[1].toInt()); homeTiltUs = clampUs(tok[2].toInt()); }
    else         { homePanUs = panUs; homeTiltUs = tiltUs; }   // capture current aim
    saveConfig();
    sendStat();
  }
  else if (cmd == "CENTER" || cmd == "HOME") {
    segClear();
    jobArmed = false;
    panUs = homePanUs; tiltUs = homeTiltUs;    // return to the zeroed origin
    applyServos();
    driveLaser(false);
    lastCmd = now;
    reply("OK");
  }
  else if (cmd == "DET") {
    segClear();
    jobArmed = false;
    driveLaser(false);
    detachServos();
    reply("OK");
  }
  else if (cmd == "ATT") {
    attachServos();
    reply("OK");
  }
  else if (cmd == "DM") {
    if (nt < 2) { reply("ERR DM needs ms"); return; }
    dmMs = (uint32_t) tok[1].toInt();
    saveConfig();
    sendStat();
  }
  else if (cmd == "PING") {
    lastCmd = now;
    reply("OK");
  }
  else if (cmd == "?" || cmd == "STATUS") {
    sendStat();
  }
  else {
    /* Only complain about something that looks like a command. A line made of
       stray bytes is framing debris, and answering it makes things worse: the
       reply is long, it goes out one notify at a time, and it holds up the loop
       that is trying to keep the segment queue fed. */
    bool printable = true;
    for (unsigned i = 0; i < cmd.length() && printable; i++) {
      char c = cmd[i];
      if (c < 32 || c > 126) printable = false;
    }
    if (printable && cmd.length() <= 12) reply("ERR unknown " + cmd);
  }
}

// ============================================================================
//  BLE callbacks  (buffer only; never parse or notify from here)
// ============================================================================
class ServerCB : public BLEServerCallbacks {
  void onConnect(BLEServer* s) override {
    bleConnected = true;
  }
  void onDisconnect(BLEServer* s) override {
    bleConnected = false;
    segClear();                               // do not keep drawing to nobody
    driveLaser(false);                        // safety: kill beam if BLE drops
    bleResetReq = true;                       // loop() clears line + framer state
    BLEDevice::startAdvertising();            // let another client reconnect
  }
};

class RxCB : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    /* getData()/getLength(), never a c_str(). Packed segments are raw bytes
       and a zero byte is a perfectly ordinary thing for one to contain: a
       laser-off flag, a zero delta on a straight line, the low byte of a
       pulse. Routing the value through a C string cut every such packet off
       at its first zero, which downstream read as a checksum failure, which
       read as a link dropping most of what was sent over it. This one line
       was the whole of "plotting over bluetooth barely works". */
    const uint8_t* d = c->getData();
    size_t n = c->getLength();
    if (!d || !n) return;
    portENTER_CRITICAL(&rbMux);
    for (size_t i = 0; i < n; i++){
      size_t nx = (rbHead + 1) % RB_SZ;
      if (nx != rbTail){ rb[rbHead] = d[i]; rbHead = nx; }  // drop on overflow
    }
    portEXIT_CRITICAL(&rbMux);
  }
};

void setupBLE() {
  BLEDevice::init(DEVICE_NAME);
  // nudge the MTU up so status lines fit in one notify where the phone allows it
  BLEDevice::setMTU(185);

  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ServerCB());

  BLEService* svc = bleServer->createService(NUS_SERVICE);

  txChar = svc->createCharacteristic(
      NUS_TX, BLECharacteristic::PROPERTY_NOTIFY);
  txChar->addDescriptor(new BLE2902());

  BLECharacteristic* rxChar = svc->createCharacteristic(
      NUS_RX, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rxChar->setCallbacks(new RxCB());

  svc->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE);
  adv->setScanResponse(true);
  adv->setMinPreferred(0x06);
  adv->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
}

// ============================================================================
//  setup / loop
// ============================================================================
void setup() {
  Serial.begin(115200);

  pinMode(PIN_LASER, OUTPUT);

  prefs.begin("laserrig", false);
  configLoad();                               // the whole installed setup, not just pulses

  driveLaser(false);                          // beam off before anything moves
  panUs = homePanUs; tiltUs = homeTiltUs;     // boot to the zeroed origin

  // ESP32Servo shares LEDC timers; hand it a block up front for stability
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  attachServos();

  setupBLE();

  lastCmd = millis();
  delay(200);
  reply("READY LASER RIG");
  sendStat();
}

void loop() {
  // --- a BLE client just left: clear its half-built line and framer state ---
  if (bleResetReq) {
    bleResetReq = false;
    bleLine = "";
    binFramers[BINF_BLE].active = false;
    binFramers[BINF_BLE].len = binFramers[BINF_BLE].need = 0;
    binFramers[BINF_BLE].esc = false;
    tbTail = tbHead;                          // nobody left to notify
  }

  // --- drain USB serial, line at a time ---
  while (Serial.available()) {
    uint8_t b = (uint8_t) Serial.read();
    binIdleCheck(BINF_SERIAL);
    if (binFeed(BINF_SERIAL, b)) continue;             // packed segments
    char c = (char) b;
    if (c == '\n' || c == '\r') {
      if (serialLine.length()) { handleLine(serialLine); serialLine = ""; }
    } else {
      serialLine += c;
      // Runaway guard, sized for the longest legitimate line: a CFG push with
      // all four corners runs close to 200 characters, and the old 120 cap was
      // silently destroying exactly that line, which is why corner calibration
      // never seemed to stick on the board.
      if (serialLine.length() > 300) serialLine = "";
    }
  }

  // --- drain BLE ring buffer, line at a time ---
  uint8_t batch[256]; size_t bn = 0;
  portENTER_CRITICAL(&rbMux);
  while (rbTail != rbHead && bn < sizeof(batch)) {
    batch[bn++] = rb[rbTail];
    rbTail = (rbTail + 1) % RB_SZ;
  }
  portEXIT_CRITICAL(&rbMux);
  for (size_t i = 0; i < bn; i++) {
    uint8_t b = batch[i];
    // Binary packets and text commands share the one stream. A packet always
    // opens with 0xA5, which never appears in an ASCII command, so the framer
    // gets first refusal on every byte and text carries on underneath it.
    binIdleCheck(BINF_BLE);
    if (binFeed(BINF_BLE, b)) continue;
    char c = (char) b;
    if (c == '\n' || c == '\r') {
      if (bleLine.length()) { handleLine(bleLine); bleLine = ""; }
    } else {
      bleLine += c;
      if (bleLine.length() > 300) bleLine = "";        // same sizing as serial
    }
  }

  // --- trickle queued replies out over BLE ---
  // One small notify at a time with a breath between them, so the radio never
  // gets a burst it has to drop and this loop never has to wait on it.
  if (bleConnected && txChar && tbTail != tbHead && millis() - lastNotify >= 3) {
    uint8_t chunk[20]; size_t n = 0;
    while (tbTail != tbHead && n < sizeof(chunk)) {
      chunk[n++] = tb[tbTail];
      tbTail = (tbTail + 1) % TB_SZ;
    }
    txChar->setValue(chunk, n);
    txChar->notify();
    lastNotify = millis();
  }

  // --- run the segment queue ---
  // This is the hot path during a plot. It runs every pass, which on an ESP32
  // is tens of thousands of times a second, so the interpolated pulse is always
  // current no matter how the packets happened to land.
  serviceSegments();

  // --- position report ---
  // Terse on purpose: this runs alongside the segment stream and must not
  // crowd it. Only sent when something actually moved, so a parked rig is silent.
  /* An armed job reports whether or not anyone asked. The trailing queue
     figure is the sender's flow control; without it the credit window goes
     stale and every refill lands as a burst on a queue whose depth nobody
     measured, which is how qd climbs by forty a beat. */
  uint32_t repEff = reportMs ? reportMs : (jobArmed ? 150 : 0);
  if (repEff && millis() - lastReport >= repEff) {
    lastReport = millis();
    bool changed = (panUs != lastRepPan || tiltUs != lastRepTilt || laserOn != lastRepLaser);
    // Speak up every few beats even when parked. The trailing queue figure is
    // the app's flow control, and it needs to see the queue drain even while
    // the beam is holding still.
    bool due = millis() - lastRepForce >= repEff * 4;
    if (changed || due) {
      lastRepPan = panUs; lastRepTilt = tiltUs; lastRepLaser = laserOn;
      lastRepForce = millis();
      char rp[48];
      snprintf(rp, sizeof(rp), "@ %d %d %d %d", panUs, tiltUs, laserOn ? 1 : 0, segFree());
      reply(String(rp));
    }
  }

  // --- dead-man cutoff ---
  /* Queued playback is life. A board with half a second of trajectory in
     hand is executing recent instructions, and dumping that queue because
     the LINK went quiet destroys geometry it already held; the starvation
     gate above covers the queue-runs-dry case within 300 ms. The dead-man
     stays as the backstop it was meant to be: a lit beam, nothing queued,
     nothing arriving. */
  if (dmMs > 0 && laserOn && (millis() - lastCmd > dmMs)
      && !segActive && segTail == segHead) {
    segClear();
    driveLaser(false);
    reply("ERR deadman laser off");
  }
}
