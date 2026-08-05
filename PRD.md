# hackbuild-beam PRD

Repo: `github.com/virgilvox/hackbuild-beam`
Version: 1.0, 2026-08-04
Owner: Moheeb Zara (virgilvox)

**This document supersedes both `hackbuild-laser-rig-prd.md` and `hackbuild-beam-prd.md`.**
Both originals are preserved under `originals/` as evidence, not as instructions. Where they
disagreed, section 12 records the decision and the reason. Where they agreed, the agreement is
adopted silently.

---

## 1. Summary

BEAM is laser scanner control software: a wire protocol, a motion planner, a browser SDK, and
one control app. It exists today as two separate working tools that were built independently
and arrived at the same architecture:

| | WASHER | DETENT |
| --- | --- | --- |
| Rig | 2 servo pan/tilt head, 405nm diode | 2 mirror stepper scanner, 405nm diode |
| Board | ESP32-WROOM-32E | ESP32-C3 SuperMini |
| App | `laser-rig.html`, 6037 lines | `detent-plot.html`, 2241 lines |
| Firmware | `PanTiltLaser.ino`, 1204 lines | `detent_firmware.ino`, 823 lines |

They are the same machine. Both are two degrees of angular aim plus a one bit beam gate,
pointed at a flat target some distance away, driven from a browser over USB CDC or BLE Nordic
UART. Everything downstream of that shape came out the same in both projects independently:
dual transport on one parser, a plain text line protocol, config persisted in NVS with the
board as the source of truth on reconnect, a segment queue that interpolates on the board's own
clock with free slot count used as credit flow control, dead man cutoff and disconnect kill,
whole job velocity planning after both shipped per stroke stop-and-start first and found it
choppy, an actuator error model in the simulator, four corner capture, and the same content
pipeline of stroke font text, SVG import, image raster, calibration patterns and live sketch.

This document turns those two tools into one repo with one engine, one app, and two machine
profiles.

## 2. The thesis, and where it holds

Four things differ, and they are all the same seam.

| | washer (pan/tilt) | detent (two mirror) |
| --- | --- | --- |
| Axis unit | servo pulse microseconds, 500..2500, quantum 1 us | half steps, quantum 1 step = 0.0883268 deg of mirror |
| Geometry | throw plus mount height, two rotations about the head | throw plus mirror separation, tangent space |
| Error model | deadband, frame latch, lag, dither | backlash hysteresis, ramp on reversal, pull out, coil settle |
| Mapping | four corner bilinear over the unit square | four corner projective homography in (u, v) |

### 2.1 The geometry is not two models, it is one model twice

This is the load bearing result and it is worth stating precisely, because it is what makes a
single planner honest rather than a lowest common denominator.

WASHER's inverse kinematics, in tangent form:

```
tan(pan)  = wx / D
tan(tilt) = (wy + vOff) / hypot(wx, D)          vOff = wallH/2 - mountH
```

DETENT's ideal two mirror model:

```
a = atan2(x, throw + sep)
u = tan(a)      = x / (throw + sep)              (exactly, since tan(atan2(x,k)) = x/k)
v = y cos(a) / throw = y (throw + sep) / (throw * hypot(x, throw + sep))
```

Set `sep = 0` in DETENT and `vOff = 0` in WASHER and the two are the same function. Both are
one yaw about a first axis, then one lift of the already swung ray onto a plane, and both
already carry the `cos(a)` slant correction that makes the second axis depend on the first.
The remaining terms are parameters, not different physics:

- `sep` is DETENT's distance from the first pivot to the second, which lengthens the first
  axis's lever arm to `throw + sep` while the second stays at `throw`.
- `vOff` is WASHER's vertical offset of the target centre above the head.

So one `GimbalGeometry` with `{ throwMm, sepMm, vOffMm }` covers both rigs exactly. WASHER is
`sep = 0`; DETENT is `vOff = 0`. Neither loses anything.

The genuinely different part is small and lives below the geometry: converting an axis angle
into that axis's unit.

- WASHER: the servo angle *is* the beam yaw. `us = minUs + (deg / 180) * (maxUs - minUs)`,
  11.111 us per degree at the default window.
- DETENT: a mirror deflects the beam by twice its own rotation, so the mirror angle is
  `atan(u) / 2`, then divided by `DEG_PER_STEP` to reach half steps.

That is one number, a beam-angle-per-axis-angle factor: 1 for a servo head, 2 for a mirror.
The profile carries it.

### 2.2 Where the thesis is thin, stated up front

- **Quantum size.** WASHER's quantum is 1 us, which is 0.09 degrees of servo, about 0.24 mm on
  a 305 mm target at a 152 mm throw, against a 1.91 mm deadband. The command chain is eight
  times finer than the actuator, which is why dither exists. DETENT's quantum is one half step,
  0.1766 degrees of beam, about 0.55 mm on the bench geometry, and there is nothing finer to
  reach for: ULN2003 has no current control. **The quantiser is shared; the sub-quantum
  strategy is not.** Dither is a WASHER capability flag, not a planner feature.
- **Velocity limits are not expressible in the same terms without the profile.** WASHER's limit
  is angular slew in degrees per second, a continuous rate. DETENT's is pull-out: a discrete
  step rate above which the rotor loses sync and the geometry is silently gone. Both reduce to
  "maximum axis units per second", but the failure mode differs, so the profile also declares
  whether exceeding the limit degrades (servo lags) or destroys (stepper skips). The planner
  treats a destructive limit with a margin; the bench derating rule for DETENT is 70 percent of
  the measured stall rate.
- **Hermite endpoint velocity means less on a stepper.** A stepper does not have a velocity in
  the continuous sense, it has a tick interval. The merged design does not pretend otherwise:
  see section 5.3.

## 3. Naming

The repo is `hackbuild-beam`. The product is BEAM. Neither rig disappears; both become machine
profiles.

- `washer-servo` - 2x SG90 or MG90S pan/tilt, ESP32-WROOM-32E, 405nm diode.
- `detent-28byj` - 2x 28BYJ-48 on ULN2003, ESP32-C3 SuperMini, 405nm diode.

BEAM is the software. Machine profiles describe hardware. Future rigs (TMC bipolar mod, RGB
head, SPINDLE v6) are new profiles, not new apps.

npm packages publish under `@virgilvox` for now. Names are chosen so a later move to a
`@hackbuild` org is a scope swap and nothing structural.

Already flashed boards keep working. The app accepts the `READY LASER RIG` and `detent 1.3`
hello strings alongside the new `BEAM` one, and it recognises the `LASER RIG`, `DETENT` and
`BEAM` advertised names for display. It does not filter discovery on any of them: BLE discovery
filters on the Nordic UART service UUID, because a name filter cannot see the other rig at all
(section 5.3). A board that has never been reflashed is a supported configuration, not a
migration step.

## 4. Goals and non-goals

### Goals

1. One repo containing engine, app, firmware, hardware and docs, with CI that proves all of it
   on every push.
2. A JavaScript SDK anyone can use to drive a BEAM machine from their own page or script,
   without the studio app, and without a build step on their side.
3. One Vue 3 app that drives both rigs, with panels rendered off capability flags rather than
   off a user-chosen mode.
4. Feature and behavior parity with both current single files, verified by both existing test
   suites ported into the repo.
5. The hack.build theme as one central implementation that travels to other hack.build tools by
   copying a folder.
6. Keep the thing that makes these tools good: a single HTML file you can hand someone that
   runs from `file://` with no server and no install.
7. Never take either physical rig dark during the migration.

### Non-goals

- No cloud, no accounts, no telemetry, no server component.
- No G-code. BEAM's command stream is its own format and importers translate into it.
- No CONDUYT and no CLASP integration in v1. A bridge is a possible later package.
- No new machine profile for hardware that does not physically exist.
- No rewrite of behavior that currently works. Port it, keep the comment that explains it, and
  pin it with a test.

## 5. Architecture

### 5.1 Layers

Dependencies point one way only.

```
apps/studio (Vue 3, Pinia, Vite)
  theme/                     tokens, fonts, presentational components. Imports no beam code.
  @virgilvox/beam-link       transports, Device, streaming, safety. Imports core.
  @virgilvox/beam-sources    content in, strokes out, injected DOM primitives. Imports core.
  @virgilvox/beam-core       profiles, geometry, planner, protocol, sim. Imports nothing.
```

Enforced by lint in `eslint.config.js`, which is CI, not review.

### 5.2 The machine profile

The profile is the whole trick. It is the only place in the system that knows what kind of
machine is on the other end of the wire.

```ts
interface AxisUnit {
  readonly name: string;          // "us" | "halfstep"
  readonly quantum: number;       // smallest commandable increment, in axis units
  readonly min: number;
  readonly max: number;
  readonly subQuantum: "dither" | "none";
}

interface MachineProfile {
  readonly id: "washer-servo" | "detent-28byj";
  readonly label: string;

  /* Geometry. One model, two parameter sets. See section 2.1. */
  readonly geometry: { throwMm: number; sepMm: number; vOffMm: number };

  /* A mirror doubles the beam angle; a servo horn does not. 2 or 1. */
  readonly beamAnglePerAxisAngle: number;

  readonly axis: { a: AxisUnit; b: AxisUnit };

  /* Unrounded both ways. The planner needs the map's slope, not its nearest step. */
  forward(a: number, b: number): { x: number; y: number };
  inverse(x: number, y: number): { a: number; b: number };

  /* Local sensitivity in axis units per mm, taken on the busier axis, evaluated
     through whatever calibration is active. This is what the planner limits on. */
  sensitivity(from: Point, to: Point, cal: Calibration | null): number;

  readonly limits: {
    maxRate: number;                     // axis units per second
    maxAccel: number;                    // axis units per second squared
    overrun: "degrades" | "destroys";    // servo lags vs stepper skips
    derate: number;                      // 1.0 for servo, 0.7 for stepper pull-out
  };

  /* The simulator consumes this. One signature, two implementations. */
  actuator(): ActuatorModel;

  readonly caps: Capabilities;

  /* Picks itself on connect from the hello line plus the config dump. */
  matches(hello: string, config: Record<string, string>): boolean;
}

interface ActuatorModel {
  reset(a: number, b: number): void;
  /* Advance the model by dt seconds toward the commanded axis pair, and return
     where the machine physically is. Deadband, frame latch, lag and dither for a
     servo; backlash, reversal ramp, coil settle and pull-out for a stepper. */
  step(dt: number, cmdA: number, cmdB: number): { a: number; b: number };
}
```

The planner works in generic axis units and time. It never learns whether a unit is a
microsecond or a half step. Sources never knew in the first place. Link only cares which packet
formats the board negotiated.

Profile selection happens on connect, from the hello string plus the config dump, not from a
dropdown. If identity is ambiguous the app connects in a read-only state, shows the raw hello
line in the console, and asks. It never guesses a profile, because a wrong profile aims a live
beam through the wrong map.

### 5.3 The merged wire protocol

WASHER is ahead on the wire: escaped framing with CRC8, three negotiated packet formats, delta
packing, sequence gap recovery that stretches the surviving segment to cover lost time, and
capability negotiation. DETENT is text only, but it has the thing WASHER lacks: the board
executes the host's timing verbatim instead of stacking its own ramp on top.

#### Two domains, keyed by the magic byte

The merge does not force one packet family to carry both machines. It cannot, and trying was the
first wrong answer: a pulse value is effectively unsigned 500 to 2500 while a half step is a
signed count either side of zero, and a servo's duration is a whole millisecond while a stepper's
is an exact integer number of ISR ticks.

| Domain | Position unit | Time unit | Packets |
| --- | --- | --- | --- |
| pulse | servo pulse microseconds, uint16, 500..2500 | whole milliseconds, `dur` uint8 1..255 | A4, A5, A6 |
| step | half steps of mirror, **int16**, signed | ISR ticks, `iv` uint16 1..65535 | A3 fmt 0, 1, 2 |

**The magic byte is the domain discriminator and nothing else is.** No token, no negotiated mode,
no header flag. A board that one day drives both heads accepts both families with no ambiguity,
because A5 means pulses and A3 means steps at the byte level.

This is the direct lesson of the A4-versus-A5 escape asymmetry: one mechanism with two meanings
keyed by a version guess is how that asymmetry got in, and it is still the one place sender and
receiver disagree today.

Only `0xA0` through `0xAF` can ever be a magic byte, because the receiver reconstructs an escaped
byte as `0xA0 | (b & 0x0F)`. That is a hard sixteen value budget. `0xA3` spends one of it and a
sub-format nibble in the high half of the count byte keeps three new step formats inside it.

| Magic | Domain | Layout |
| --- | --- | --- |
| `0xA4` | pulse, hermite | `pan16 tilt16 velP8 velT8 flags8 dur8`, count 1..8. Unchanged |
| `0xA5` | pulse, flat | `pan16 tilt16 flags8 dur8`, count 1..10. Unchanged |
| `0xA6` | pulse, delta | 6 byte anchor then `dPan8 dTilt8 flags8 dur8`, count 1..10. Unchanged |
| `0xA3` fmt 0 | step, flat | `x16 y16 flags8 iv16`, 7 bytes per segment, count 1..8 |
| `0xA3` fmt 1 | step, delta | 7 byte anchor then `dx8 dy8 flags8 iv16`, count 1..10 |
| `0xA3` fmt 2 | step, run | packet-wide `iv16`, then `x16 y16 flags8`, then `dx8 dy8 flags8`, count 1..15 |

Header is `magic | count | seq` with the step formats packing `(fmt << 4) | count` into byte 1.
Trailer is one CRC8 byte. All multi-byte fields are little endian.

Format 2 is the workhorse for a plot: a straight run at constant planned speed shares one
interval across the whole packet, giving fifteen points in 53 bytes, about 3.5 bytes per point
against roughly 18 characters per point in the text protocol.

Step positions are absolute logical step targets, exactly what `S x,y,l` carries today, so the
board keeps computing its own deltas and its backlash take-up, 2000 step split and soft limit
clamping all keep working unchanged. The app must refuse a target outside int16 rather than let
it wrap, because the existing corner store truncates silently at that boundary.

#### The flags byte

DETENT's per segment field is already two bits and the firmware already reads it as two:

> **bit 0 beam gate, bit 1 planned, bits 2-7 reserved zero, ignored on receive.**

`planned` means the board executes the timing it was given and stacks no ramp of its own. The host
owns acceleration. Without it the firmware applies its own standstill ramp on top of a plan that
already decelerated into the corner and the two compound. The backlash take-up segment
deliberately clears the bit, because it happens at a reversal, which is exactly where speed costs
steps.

Reserved bits are ignored rather than rejected so a later bit is purely additive.

#### Interval and duration are not the same field, and neither is derived from the other

An earlier draft of this document proposed making millisecond duration the universal currency and
having a stepper derive its tick interval from it. That is wrong and the reason is worth keeping.

In the step domain the duration is fully determined: a segment takes `dmaj * iv` ticks, where
`dmaj` is the Bresenham dominant axis delta. The relation is exact and integer at 50 microsecond
granularity. Forcing a whole millisecond field in between reintroduces precisely the rounding that
WASHER's residual carry exists to compensate, except worse, because the rounding would happen on
the board where the host's residual cannot reach it. So `iv` replaces `dur` in the step formats
and there is no millisecond field anywhere in A3.

Hermite endpoint velocity and `iv` are orthogonal, not redundant. A velocity describes the shape
of motion inside a segment, and it exists because a servo is a continuous positioner whose
acceleration ramps a straight chord cannot reproduce. `iv` describes the rate of a discrete step
clock, and it exists because a stepper has no sub-segment freedom at all: the path between two
step targets is the Bresenham line, dead straight, and the only thing a host controls is how fast
the ticks come. On a Bresenham stepper there is no tangent to give; on a servo there are no steps
to pace. No format carries both, so there is no runtime precedence question.

The tick rate is negotiated, not compiled in. The board publishes `tick=20000` and the app divides
by what it read. That retires the duplicated constant carrying the comment "must match firmware
TICK_HZ", and it means the stale `// 100 us` comment in the firmware can never again make a host
off by a factor of two, because the host is told rather than assuming.

#### Escaping, CRC and loss

Ported from WASHER, including the asymmetry, which is load bearing:

- Hermite packets escape `0xA4` through `0xA7`. Legacy A5 and A6 escape only `0xA5` through
  `0xA7`, because older firmware would mistranslate `A7 04`. The new A3 family uses a uniform
  `0xA3` floor and does not extend the asymmetry, it ends it.
- Escape is `0xA7` then the low nibble; the receiver reconstructs `0xA0 | (b & 0x0F)`. Byte 0 is
  never escaped.
- CRC8 is polynomial `0x07`, init 0, no reflection, no final xor, over the unescaped bytes from
  the magic through the last payload byte.
- A CRC failure keeps the sequence primed, so the next good packet still shows how many segments
  died and gets stretched to cover their time.
- Sequence gaps stretch the survivor by `gap * EMA(arriving wire durations)`, alpha one eighth,
  seeded from the job nominal, capped at 60 s.

One inherited defect is fixed rather than ported: an A5 or A6 payload byte equal to `0xA4` is not
escaped by the sender but is treated as a frame restart by the current receiver. **Fix: the
receiver treats a magic byte as a frame opener only when no frame is currently open.** Compatible
in both directions.

#### Classification comes before anything else, and this is a safety rule

**The app sends nothing but the probe until the peer is classified.** Not a config pull, not a
report request, not a banner.

This is not tidiness. The two text vocabularies collide destructively, because DETENT dispatches
on the first character of the line and treats the rest as arguments. Verified against the shipped
firmware:

| App sends | To a WASHER board | To a DETENT board |
| --- | --- | --- |
| `ECHO 0` | echo off, correct | `E` with rest `CHO 0`, which parses as 0 and **releases both coil sets** |
| `M 1500 1500 0` | pan and tilt to 1500 us, beam off | `M x y l` in **millimetres**: a full travel slam, unclamped because limits default off |
| `M 10 20 1` | clamps to the corner with the **beam lit** | a harmless 10 by 20 mm move |
| `L 0` / `L 1` | beam gate | beam gate. Identical in name, arity and meaning. The one free command |
| `?` | `STAT ...` | `st ...` |

Not every collision is dangerous: `PING` lands on `P` with an unparseable argument, so it falls to
the read-only corner dump rather than capturing a corner, and `FLUSH` is simply unknown. But
`ECHO 0` and `M` are enough on their own.

The probe is exactly `?`, one byte, which is the status command in both protocols and can never
open a binary frame. Classification is then free, because the two status lines already differ in
case and both apps already match case sensitively:

```
reply begins "STAT "  (uppercase)  -> pulse lineage
reply begins "st "    (lowercase)  -> step lineage
neither within 1200 ms             -> resend, up to two retries at 400 ms
still nothing                      -> unknown. Stay in simulator mode, emit nothing but the probe.
```

The 400 ms retry spacing is chosen against the framer: a board that was mid-packet swallowed the
probe inside the open frame, and an incomplete frame is abandoned after 250 ms.

**BLE discovery filters on the service UUID, never on the device name.** The DETENT app filters on
a `DETENT` name prefix today, which cannot see a `LASER RIG` board at all. Both firmwares
advertise the Nordic UART service UUID, so the service filter finds both and the advertised name
is for display only.

#### Capability tokens and the four day-one cases

Tokens live in the status line. `bin` and `ivb` are independent ladders and a board may advertise
either, both, or neither; the magic byte keys the domain, so nothing about that is ambiguous.

| Token | Meaning |
| --- | --- |
| `seg=1` | board takes timed segments at all. Absent means fall back to plain frames |
| `bin=N` | pulse binary level. 1 is A5, 2 also A6 delta |
| `herm=1` | A4 hermite. Only meaningful with `bin` |
| `ivb=N` | step binary level. 1 is A3 fmt 0, 2 also fmt 1, 3 also fmt 2 |
| `tick=N` | ISR base rate, the denominator for `iv`. Absent means no step clock |
| `esc=N` | framer contract. 1 is the legacy restart set and format-dependent floor, 2 is the uniform `0xA3` floor |
| `proto=2` | merged protocol level. Absent means legacy, of whichever lineage the status prefix identifies |

| Board | Detected by | App speaks |
| --- | --- | --- |
| Old washer firmware | uppercase `STAT`, no `proto` | A4/A5/A6 exactly as today. No `iv`, no A3, zero behavior change |
| Old detent firmware | lowercase `st`, no `proto` | Text 1.3 only: `S x,y,l[,iv]` batches, credit from `free=`. Interval fully honoured. Nothing is lost except bandwidth |
| New washer firmware | `proto=2`, `bin`, `herm` | Pulse binary with the uniform escape floor |
| New detent firmware | `proto=2`, `ivb`, `tick` | Step binary: framing, CRC and loss recovery on the stepper for the first time |

An unmodified board of either kind is driven correctly on the first day over the path it already
understands. Reflashing only buys the stepper rig the framing it never had. One change applies
even on the legacy path: writes go with response on both, because a board with no CRC and no
sequence numbers cannot tell you it lost a line.

#### Text command surface

Two vocabularies exist and both are spoken. They are not unified by renaming, which would break
flashed boards for no gain. `beam-core/protocol` exposes one typed command surface and two codecs.

| Intent | washer text | detent text |
| --- | --- | --- |
| Move now | `M p t l` | `M x y l` (mm) / `S x,y,l` (steps) |
| Timed segment | `SEG p t l ms` | `S x,y,l,iv` |
| Flush and stop | `FLUSH` | `X` |
| Beam | `L 0\|1` | `L 0\|1` |
| Status | `?` | `?` |
| Config dump | `CFG` | `Q` (qc1..qc4) / `C` |
| Persist | implicit on assignment | `W` (explicit) |
| Zero here | `ZERO` | `H` |
| Mapping | `CFG tl=..` corners | `Y h0..h7`, `P n`, `A margin` |

New firmware of both kinds accepts its own historical vocabulary unchanged. **No text command is
renamed or removed.** The one behavioral change is that explicit persistence becomes the rule on
both rigs: WASHER commits to flash on every config assignment today, which is a flash wear and
surprise persistence hazard, and it moves behind an explicit persist to match DETENT and
principle 1.

### 5.4 The unified planner

Both projects independently shipped per-stroke stop-and-start, found it choppy, and moved to
whole-job planning. The merged planner is one pipeline; the profile-dependent stages are named.

```
source polylines (mm, y-up)
  -> refine curves to PLAN.tol                      profile-independent
  -> merge strokes at the join tolerance            profile-independent
  -> travel ordering, optional unidirectional       profile-independent
  -> place on field: centre, mirror, scale, rotate, offset
  -> inverse map to axis units                      PROFILE
  -> sensitivity-limited speed caps                 PROFILE (units/s, accel, derate)
  -> junction and sustained-curvature limits        profile-independent
  -> forward/backward accel sweep, jerk smoothing   profile-independent
  -> timing integration with residual carry         profile-independent
  -> quantise to the axis quantum                   PROFILE (quantum, sub-quantum)
  -> emit: segments with duration, gate and planned bit
```

Reconciling the two velocity models: WASHER caps segment speed by
`servoSlew / degPerMm` and limits acceleration by `servoAccel * ACC_SHARE / degPerMm`, taking
the busier axis. DETENT caps by `rate` or `travel` steps per second, tightens at junctions by
`vFloor + (vmax - vFloor) * ((cos+1)/2)^1.5`, then runs forward and backward accel passes over
dominant-axis step counts. These are the same computation in different units. The merged form
is WASHER's, with `degPerMm` generalised to the profile's `sensitivity()` in axis units per mm,
and DETENT's dominant-axis step count is exactly `sensitivity * ds` for a stepper. DETENT's
junction cosine blend and WASHER's junction-deviation formula both survive, as a
profile-supplied junction cost rather than as a shared default.

Junction handling is the one place the two planners must **not** be merged, and the reason is
physics rather than taste. WASHER decelerates to zero at a reversal, because a servo reversing
at speed slams through half a degree of gear slop and that is an audible knock and a visible
wobble; arriving at rest is the correct answer. DETENT holds a floor of 120 steps per second,
because below its pull-in rate there is nothing further to gain and the firmware's own
standstill ramp handles the restart.

There is a sharper reason DETENT must plan its own corner deceleration, and it is a safety
issue rather than a quality one. **Setting the planned bit bypasses the firmware's reversal
ramp entirely.** That ramp is what stops a full rate reversal, and a full rate reversal is
exactly where these motors skip. The bench measured the inter-step gap going from 23 ticks
cruising to 41 post-turn with no host plan; with the planned bit set that protection is gone
and the host owns it completely. So `caps.firmwareRampBypassed` is a visible capability flag,
because it converts a planner bug from a slow corner into skipped steps, and a skipped step is
geometry that is silently gone with no way to detect it.

One caveat on those numbers: the default ramp length of 150 steps exceeds the 100 step move the
harness used, so its "cruise" figure of 23 ticks is itself still on the ramp rather than at true
cruise. Any assertion written against them has to say so.

Everything geometric derives from one path tolerance, `PLAN.tol`, in target millimetres. Both
apps arrived at that independently and both record why: a fixed sample rate spends detail
evenly, which is exactly wrong, because a straight run needs almost none and a tight curve
needs a great deal.

### 5.5 The unified simulator

One `Sim` executes the emitted command stream the way the firmware does, through the profile's
`ActuatorModel`. This is the load bearing piece in both projects, and both learned the same
lesson: **the simulator is worthless unless it replays the firmware's real behavior rather than
the ideal path.**

WASHER goes further and runs the firmware's segment interpolator locally as a digital twin,
fed the same segment objects that went on the wire, with board position reports demoted to a
slow drift correction. That survives, generalised: the twin is the interpolator plus the
profile's actuator model, and it is what the viewport draws during a live plot.

The sync duty is a rule, not an aspiration: **any firmware change updates the reference model in
the same commit.** The existing g++ harness has already drifted from the shipped `.ino` on four
counts (tick rate 10000 against the firmware's 20000, an older limits struct, a `writeLaser`
that no longer matches, and `stepAxis` without inversion) while still carrying a
`// copied verbatim` comment. That drift is exactly what the rule exists to prevent, and it is
recorded in `docs/invariants.md` as a known-stale fixture to be re-derived at M1.

### 5.6 The app

One Vue 3 app, `apps/studio`. `<script setup>`, Pinia, Vite, no router. The library stays
framework agnostic; Vue appears only in `theme/` and in the app.

Panels render off capability flags, not off a mode selector:

- Dither, pulse range, servo preset, lead: shown when `caps.dither` / `caps.pulseWindow`.
- Backlash comp, coil release, stall hunt, step rates: shown when `caps.backlash` /
  `caps.coilRelease` / `caps.pullOut`.
- Four corner capture: shown when `caps.corners`, which is both.
- Homography solve and residual: shown when `caps.mappingSolve`, which is both after M2.
- The 3D scanner viewport: profile-supplied geometry drawing.

Stores: `link` (transport, connection), `machine` (profile, adopted board config, live
position), `calibration` (corners, mapping, residual, aspect), `project` (source, content
parameters, strokes, planned commands), `job` (run state, progress, speed override), `log`.
One composable, `useSession`, owns the core session and pipes its events into the stores. No
component imports core internals.

Two build outputs from one codebase: a static site for GitHub Pages with the mock transport on
a demo button, and `beam.html`, a single file that works offline from `file://`.

### 5.7 Firmware

Two sketches stay, because two boards stay. What moves into `firmware/lib` as headers is
everything the two have in common and currently duplicate:

- `beam_queue.h` - the segment ring, free-slot accounting, credit reporting.
- `beam_frame.h` - escaped framing, CRC8, the two independent per-transport framers, the 250 ms
  idle abandon.
- `beam_seq.h` - sequence numbers, gap detection, the EMA loss estimator and the stretch.
- `beam_safety.h` - dead man, starvation gate, disconnect kill.
- `beam_nvs.h` - the persisted config block and its load/save with validation.
- `beam_parse.h` - line assembly, tokenising, the shared command table.
- `beam_protocol_generated.h` - magics, capability tokens, field offsets. Generated from
  `packages/beam-core/src/protocol/spec.ts` so the wire contract has exactly one source.

Each per-rig sketch becomes a pin map, a driver implementing one interface, and a profile id.
The driver interface is small:

```c
struct BeamDriver {
  void  (*begin)(void);
  void  (*writeAxes)(int32_t a, int32_t b);   // us for servo, step target for stepper
  void  (*gate)(bool on);
  void  (*idle)(void);                        // coil release, detach, whatever this rig needs
  int32_t (*clampA)(int32_t), (*clampB)(int32_t);
};
```

Realistic budget: about 200 to 260 lines per sketch against 1204 and 823 today, with roughly
900 lines of shared headers. Arduino IDE stays the canonical build for the audience; a
`platformio.ini` sits alongside for CI, building the same `.ino`.

The stepper keeps its own ISR. The header set deliberately does not try to abstract the step
generator: a 20 kHz Bresenham ISR and a 2 ms servo write throttle are not the same thing and
pretending otherwise would be the abstraction that costs more than it earns.

## 6. Repo layout

```
hackbuild-beam/
  PRD.md                          this document, governing
  CLAUDE.md                       working rules for agents
  package.json                    private, pnpm workspaces
  pnpm-workspace.yaml
  tsconfig.base.json
  eslint.config.js                boundary and house-style enforcement
  tools/
    eslint-plugin-house-style/    the no-dashes no-emoji rule
    capture-fixtures/             lifts golden vectors out of the two original HTML files
    gen-protocol/                 spec.ts -> docs/protocol.md + generated firmware header
  packages/
    beam-core/                    @virgilvox/beam-core
      src/profiles/               washer-servo.ts, detent-28byj.ts
      src/geometry/               the one gimbal model, calibration, homography
      src/planner/                refine, merge, order, limit, junction, profile, timing
      src/protocol/               spec.ts, packers, parsers, negotiation, codecs
      src/sim/                    the firmware reference model and actuator models
      testing/                    reference model + golden fixtures, published
    beam-sources/                 @virgilvox/beam-sources
      src/                        font, models3d, svg, raster, patterns, sketch
    beam-link/                    @virgilvox/beam-link
      src/                        Device, stream, safety, hunt
      src/web/                    WebSerial, WebBluetooth
  theme/                          not a package, travels by folder copy
    tokens.css  grain.css  fonts/  components/  icons/
  apps/
    studio/                       the Vue app, builds dist/beam.html and the Pages site
  firmware/
    lib/                          the shared headers
    washer/washer.ino
    detent/detent.ino
    motortest/motortest.ino
  hardware/
    washer-servo/                 servo_base_lego.scad and the two servo base STLs
    detent-28byj/                 galvobody, galvobrack, BOM, SPINDLE shield notes
  docs/
    protocol.md                   generated, do not hand edit
    invariants.md                 the registry, section 11
    profiles.md                   how to add a machine
    calibration.md  speed.md  manual.md
  originals/                      the two shipped tools, preserved as evidence
  .github/workflows/
    ci.yml  firmware.yml  pages.yml  release.yml
```

### Package entry points

Subpath exports are declared public API, not deep imports. Documented and covered by tests.

| Package | Entries |
| --- | --- |
| `@virgilvox/beam-core` | `.`, `./profiles/washer-servo`, `./profiles/detent-28byj`, `./testing` |
| `@virgilvox/beam-sources` | `.` |
| `@virgilvox/beam-link` | `.`, `./web` |

```js
import { Device } from "@virgilvox/beam-link";
import { WebSerialTransport } from "@virgilvox/beam-link/web";

const dev = new Device(new WebSerialTransport());
await dev.connect();          // adopts board config and picks the profile, never clobbers
dev.on("status", s => render(s));
await dev.run(plan);          // planned timing, flow control, progress
```

## 7. Principles

These are constraints, not preferences.

1. **The board is the source of truth.** Connect adopts board config. Pushing config is always
   an explicit act, and so is persisting it. This came out of a field audit and it stays.
2. **The single-file build is a first-class release artifact.** Fonts and icons ship inside it.
   It must work offline from `file://`.
3. **Pure logic never touches the DOM.** Anything needing `DOMParser` or a canvas takes injected
   primitives so it still runs headless under test.
4. **Safety behaviors live in the SDK, not the app**, so every consumer of the SDK gets them.
5. **The planner never learns what an axis unit is.** That knowledge lives in the profile.
6. **A behavior that was paid for on the bench keeps the comment that explains it**, and the
   comment moves with the code.
7. **House style is a build failure, not a review comment.** No em dashes, no en dashes, no
   emoji, anywhere, including UI copy and comments.

## 8. Users

- Moheeb, running and evolving both rigs.
- Hackerspace folks building either published rig from the STLs and BOM, who need flash,
  calibrate, plot to be a twenty minute path.
- Developers embedding beam control in their own pages, who need the SDK without the app.
- Other hack.build tools (KERF, PLATEN, SPIGOT and friends), which vendor the theme folder only.

## 9. The theme

`theme/` lives at the repo root and travels by folder copy. It is deliberately not a package.
Apps import it through a Vite alias so nothing changes if it ever becomes one.

**Tokens.** Pink `#FE0386` is the single accent and it is canonical: it is the favicon value,
it is what DETENT ships, and it is what both PRDs specify. The WASHER app's `#ff3366` is drift
and does not survive the merge. Cream paper `#f5f0e6`, paper-dark `#e8e0d0`, paper-cream
`#faf8f3`, ink `#1a1a1a`, ink-2 `#0a0a0a`. Hard block shadows `4px 4px 0 0`, never blur. Zero
border radius everywhere. Paper grain as an inline SVG `feTurbulence` overlay at
`baseFrequency 0.8, numOctaves 4`.

**Schemes.** One token set derives two: paper (cream ground, ink text) and ink (dark ground,
paper text). A laser bench in a dark room needs the ink scheme, so studio defaults to ink with a
toggle; docs pages default to paper. Pink stays the only accent in both and must hold contrast
on every control.

**Typography.** Five faces, each with a job, self-hosted as subset woff2, all OFL or Apache
licensed, no runtime font fetch.

| Face | Role |
| --- | --- |
| IBM Plex Mono | the wordmark and all utility text, which in an instrument UI is most of the text |
| Permanent Marker | display headlines and panel heads only, used sparingly |
| Special Elite | typewriter prose: hints, folded explainers, the manual |
| VT323 | the console readout and canvas numerics, the one terminal surface |
| Libre Baskerville italic | the tagline, if it appears |

**Wordmark.** "hack" in ink, then the dot and "build" both in pink. The logo is the two-path
favicon SVG, broken arc in ink and wrench in pink, scaled only through the calibrated viewBox
`117 103 800 800`. Retrieved from the canonical asset, never redrawn.

**Components**, the union of both inventories, `Hb` prefixed, props-only, no business logic:
`HbHeaderBar`, `HbPanel`, `HbGroupHead`, `HbFold`, `HbButton`, `HbField`, `HbNumber`,
`HbRange`, `HbToggle`, `HbKv`, `HbNote`, `HbHint`, `HbConsole`, `HbOverlay`, `HbBadge`,
`HbChip`, `HbStatusChip`, `HbRunDock`, `HbIcon`, `HbWordmark`.

`HbIcon` is a curated inline SVG set of the thirty or so glyphs the tools use, sourced from
Font Awesome Free with CC BY 4.0 attribution in `theme/README.md`. Inline SVG keeps the single
file small and offline. Icons are never emoji and never a webfont.

`theme.html` ships as a second Vite entry: a page rendering every component in both schemes,
doubling as the visual regression fixture.

## 10. Testing

Port, do not rewrite. Both existing suites encode audit findings.

**Golden vectors, first.** Before any porting, `tools/capture-fixtures` lifts the shipped
functions out of both original HTML files and records fixtures: packed bytes for known segment
lists in all three formats including NUL and escape-heavy payloads, parser outputs for recorded
`STAT`, `CFG`, `@`, `st` and `qc1..qc4` lines, planner timelines for reference jobs, and
homography solves for the bench corner set. Ported code reproduces the fixtures byte for byte
before any refactor improves anything. The missing `h.txt` fixture that `fwtest2.cpp` requires
is recovered from `audit_test.py` and committed.

**Firmware reference model.** Lives in `beam-core/testing` as the executable spec, published so
downstream consumers can run conformance tests. Sync duty as in 5.5.

**Fidelity budgets**, gates from measured baselines, all carried forward:

| Metric | Budget | Rig |
| --- | --- | --- |
| Worst boundary velocity step, hermite | <= 0.08 us/ms per ms | washer |
| RMS tracking error, float endpoints | <= 1.1 x path tolerance | washer |
| Hermite segment count vs legacy | <= 0.45 x | washer |
| Loss splice, one dropped 8-segment packet | tempo error <= 30 ms, per-ms step < 8 us | washer |
| Corner splice with stretch | <= 2.0 mm off path | washer |
| Resync into a dwell | 0.00 mm excursion | washer |
| Laser gate timing | exact to +/- 4 ms | both |
| Oversized packets after fit loop | 0 | both |
| Corner residual, solved homography | <= 1 step, and <= 0.3 mm on the bench set | detent |
| mm -> steps -> mm worst round trip | <= 1.0 mm (measured 0.289) | detent |
| Diagonal Bresenham deviation | <= 3 in `2y - x` | detent |
| Endpoint exactness, with and without lash | exact | detent |

**Soak.** MockTransport with 1 percent injected drop and 50 ms latency jitter runs a ten minute
text job against each profile: `qd` and `drop` stay 0, no dead man fires, beam-on error inside
budget. The same scenario on real hardware is the manual acceptance for M2.

**App.** Component smoke tests against the theme entry, plus Playwright over the built single
file opened from `file://`: mock transport for both profiles, plan text, run, pause, resume,
stop, adopt-on-connect from a `qc` dump and from a `CFG` line, corner capture and solve, clip
banner, invert changes hardware and never the preview, and no horizontal scroll at 1100, 1400
and 1920 wide.

**Firmware CI** compiles `esp32:esp32:esp32c3` and `esp32:esp32:esp32` on every push. It cannot
run motion, but it can never ship a firmware that does not build.

## 11. Invariants registry

`docs/invariants.md` holds the full merged registry, tagged `[both]`, `[washer]` or `[detent]`,
each phrased as a testable assertion with the bench observation that paid for it. A pull request
that changes one of those behaviors changes its test and says why in the body.

The registry merges 27 numbered WASHER invariants with roughly 70 DETENT assertions recovered
from `fwtest.cpp`, `fwtest2.cpp`, `caltest.py`, `plantest.py`, `audit_test.py` and `narrow.py`.
A representative selection, to fix the shape:

**Transport and flow control**
1. `[both]` BLE writes go with response through one serialised writer. Without-response writes
   vanish silently under congestion; the bench log showed `lost` jumping 29 in one beat.
2. `[washer]` Adaptive chunking: start at 180 bytes, drop to 20 stickily the first time a write
   is refused, resend what the refusal bounced, reset to 180 on a new connection.
3. `[both]` Oversized frames are never dropped: the fit loop hands segments back until the
   escaped packet fits the 176-byte budget.
4. `[both]` The emitter halts while more than 3 writes are in flight.
5. `[washer]` The emit gate requires `room() >= 6` on the projected credit
   `BOARDQ - sentSinceQ - pendingSegs.length`.
6. `[detent]` The credit window requires `free >= batchMax + 8 = 14` before sending a batch of
   6 points, polls every 40 ms while blocked, and re-queries with `?` after 25 consecutive
   blocked polls.
7. `[both]` Dropped segments are erased geometry and are never silent.

**Wire format**
8. `[both]` Escape asymmetry: hermite packets escape `0xA4` through `0xA7`, legacy packets only
   `0xA5` through `0xA7`. Deliberate and load bearing.
9. `[both]` CRC8 over unescaped bytes. A CRC failure keeps the sequence primed so the lost time
   still stretches.
10. `[both]` Packet counts are 8 hermite, 10 legacy, matching the firmware framer caps exactly.
11. `[both]` A segment may never straddle a gate change, and the gate a segment carries is the
    one at its start.
12. `[detent]` The wire point format is `x,y,l` with an optional fourth `iv` field, space
    joined, `S ` prefixed. A trailing comma for a missing `iv` breaks the board parser.

**Playback and timing**
13. `[both]` Durations carry a residual so millisecond rounding never accumulates. Independent
    rounding was putting the beam gate up to 15 ms from where the plan wanted it.
14. `[washer]` Tangent clamp: 3 chord slopes plus 24 us of headroom over duration, per axis.
    Corner splice went from 11.25 mm off path to 1.60 mm, provably inert on healthy segments.
15. `[washer]` Loss stretch scales arrival velocity by `originalDur / stretchedDur`.
16. `[detent]` A planned segment executes the host's timing verbatim: the firmware stacks no
    standstill ramp on top. First gap and max gap both stay at the commanded interval, not at
    the roughly 3x ramped value.
17. `[detent]` Direction reversal on either axis restarts the ramp, so the post-turn step gap is
    strictly wider than the cruise gap. Without it every corner is a full-rate reversal, which
    is where these motors skip.
18. `[detent]` The backlash take-up is its own segment, beam off, at the slower of the two
    rates, with the planned bit clear so it always gets the firmware ramp.
19. `[detent]` Long moves split so no segment exceeds 2000 steps on the dominant axis, which is
    what makes the int16 delta cast lossless.

**Safety**
20. `[both]` Queued playback counts as life. The dead man fires only on a lit beam, an empty
    queue and a silent link, and dumps the queue when it does.
21. `[washer]` The starvation gate cuts the beam within 300 ms when an armed job runs dry, and
    zeroes velocity.
22. `[both]` Stop ordering is flush then beam off, never the reverse, because queued segments
    carry their own gate and will relight the beam.
23. `[both]` Any flush must be paired with zeroing the client's assumed arrival velocity and
    resetting the twin, because the board's clear zeroes its own.
24. `[both]` The e-stop flag is checked before emission within a tick, not after.
25. `[detent]` Keepalive polls every 2 s while the beam is manually held on, inside the board's
    5 s dead man.
26. `[washer]` Idle keepalive polls once a second whenever connected; in-plot poll every 1.2 s,
    inside the 1.5 s dead man.

**Geometry and calibration**
27. `[both]` The forward map and the inverse map must be exact inverses of each other, including
    the home offset and including the active calibration. Breaking this cost 159 mm of drawing
    offset on the washer rig once already.
28. `[both]` Everything that computes speed, error or aim goes through the one mapping funnel,
    so calibration participates everywhere and not just in aiming.
29. `[detent]` The adjugate inverse stays unnormalised. Normalising by `hinv[8]` to match the
    forward form's trailing 1 works for well-conditioned H and blows up where `hinv[8]`
    approaches zero.
30. `[detent]` The homography lands all four corners of a deliberately skewed rig within one
    step, and the degenerate case (pivot below `1e-14`) is rejected rather than solved.
31. `[both]` Inversion is a wiring correction. It changes what the hardware does and never
    transforms the preview.
32. `[detent]` Limits derived from four corners add a 4 step margin outward and set limits on
    as a side effect.

**Motion quality**
33. `[washer]` The emission error metric is time-aware: plan versus played at matched instants,
    through the full calibrated map, scoring the quantised tangents that ship. The old
    spatial-only metric approved the exact lurch it existed to prevent.
34. `[washer]` Steps per frame is a ceiling defaulting to 4.0. The axis-alternating band, about
    0.4 to 2.5 deadband steps per frame, is where two independent hysteresis quantisers pop one
    axis at a time; the readout names the band and warns inside it.
35. `[both]` Integer axis endpoints are the physical floor. Dither exists for exactly that on
    the servo rig, and the sim models deadband, frame latching and backlash so the preview tells
    the truth.

**Porting hazards, promoted to invariants because a naive port dies on them**
36. `[detent]` Integer division in the motion core truncates toward zero. `Math.trunc`, never
    `Math.floor`: the segment splitter divides negative numerators and
    `Math.floor(-7000*2000/9000)` is -1556 where C++ gives -1555, and that single step
    propagates through the remainder loop.
37. `[detent]` `lroundf` rounds half away from zero, `Math.round` rounds half toward positive
    infinity. They already disagree today at negative half-integers between the firmware and the
    browser. A port that must match the firmware needs
    `Math.sign(v) * Math.round(Math.abs(v))`.
38. `[detent]` `DEG_PER_STEP` is computed from `360 / 4075.7728`, never pasted as the rounded
    `0.0883266` from the comment. The real value is `0.08832680761793199`.
39. `[detent]` `TICK_HZ` is one shared exported constant. The firmware is 20000, the browser
    says `// must match firmware TICK_HZ`, and the g++ harness says 10000. That is three
    literals for one number and the harness's 23-and-41 tick reference values are rate-dependent.
40. `[both]` The flag bits stay bits. A planned travel move has bit 1 set and bit 0 clear, and
    the serialiser and the ISR must agree on that in one `uint8` field.

## 12. Decisions, where the two PRDs disagreed

Every fork, closed. No item is left open.

| # | Fork | Decision | Reason |
| --- | --- | --- | --- |
| 1 | Repo and product name | `hackbuild-beam`, product BEAM | BEAM is already the general name and the profile concept is already written into that PRD |
| 2 | Language | TypeScript strict in source, plain ESM plus `.d.ts` shipped | One rig counts microseconds and the other counts half steps. Unit confusion is the failure this repo most needs a compiler for |
| 3 | Library build step | Yes, and esm.sh serves the built dist | Follows from 2, and costs consumers nothing |
| 4 | Package count | Three (`core`, `sources`, `link`) plus declared subpath entries | The seams follow environment boundaries. Sources need injected DOM primitives, link needs a browser, core needs neither |
| 5 | Sources package | Its own package | Combined source volume across both apps is the largest single block after the planner |
| 6 | npm scope permanence | `@virgilvox` now, structured for `@hackbuild` later | Subpath entries are declared public API, not deep imports, so the "no deep imports" rule is satisfied |
| 7 | Theme location | Repo root `theme/` | Two consumers already exist in this repo and more are named. App-local would need moving on day one |
| 8 | Theme import | Vite alias `@theme` | Nothing in an app changes if it ever becomes a package |
| 9 | Component names | `Hb` prefix, union of both inventories | Prefix survives a folder copy into another tool without collisions |
| 10 | Font delivery | Self-hosted subset woff2, no runtime CDN | Offline is a principle, and it also answers the older PRD's open question |
| 11 | Offline | A principle, not a nice-to-have | A bench is often not on wifi |
| 12 | Icons | Inline SVG only, Font Awesome Free as art source with CC BY 4.0 attribution | Keeps the single file small and offline, and records the licence obligation |
| 13 | Single-file size | Under 900 KB without the 3D stage, under 1.5 MB with it | See risks: three.js is the one large dependency and it is vendored, never fetched |
| 14 | App directory and outputs | `apps/studio`, two outputs: Pages site and `beam.html` | A hosted demo with a mock transport is how a stranger evaluates this without hardware |
| 15 | Store names | `link`, `machine`, `calibration`, `project`, `job`, `log` | Six, because calibration and job both earned their own |
| 16 | Router | None. Second Vite entry for the theme page | The app is one screen |
| 17 | Showcase surface | `theme.html` as a second entry, rendering both schemes | Build entry, not a route, and both schemes because both are required |
| 18 | Colour schemes | Two, paper and ink. Studio defaults to ink | A dark room needs the dark one |
| 19 | Typography roles | Adopted as specified in section 9 | The role assignment is the part that makes five faces coherent |
| 20 | Wordmark and logo | Fully specified, canonical asset, viewBox `117 103 800 800` | The mark is retrieved, never redrawn |
| 21 | Accent colour | `#FE0386` | Canonical in the favicon, in DETENT, and in both PRDs. WASHER's `#ff3366` is drift |
| 22 | Firmware home and handling | `firmware/` tree, shared headers, both sketches refactored | Overrides the older PRD's freeze. Capability negotiation keeps flashed boards working |
| 23 | What gets inlined at build | Both: the firmware per profile with `?raw`, and `docs/manual.md` | Each solved a different problem and neither costs much |
| 24 | CI shape | Four named workflows | Named workflows are auditable; prose is not |
| 25 | Release and licence | changesets, npm provenance, lockstep versions, MIT | Theme has no version, it travels with the repo |
| 26 | Milestone vocabulary | M0 through M5 | Matches the newer document |
| 27 | When the theme lands | M0 | Everything visual is blocked on it, and it is cheap |
| 28 | The release gate | M2, both rigs, both transports, calibrate and plot end to end | Publishing before hardware acceptance is how a regression ships |
| 29 | Testing tiers | Four: golden vectors, reference model, fidelity budgets, soak. Plus app e2e | Fixes the older document's count-of-five-labelled-four defect |
| 30 | Test frameworks | vitest for packages, Playwright for the app, both first class | The responsive checks cannot run in jsdom |
| 31 | Fidelity budget table | Kept and extended with the stepper rows | Numbers from measured baselines are the only honest gates |
| 32 | Reference model | One model in `beam-core`, published via the `./testing` entry | One model, but published, which is the union of both positions |
| 33 | Golden-vector capture | Yes, an explicit M0 deliverable | This is a port. Byte-for-byte first, improvements after |
| 34 | Invariants registry | `docs/invariants.md`, first class, with the PR rule | The registry is the reason five sessions of bench debugging survive a rewrite |
| 35 | Docs set and casing | Lowercase, `docs/protocol.md invariants.md profiles.md calibration.md speed.md manual.md` | Consistency beats either original convention |
| 36 | Protocol doc generation | Generated from `protocol/spec.ts` into both `docs/protocol.md` and a firmware header | Resolves the direction flip: the TS spec is the source and the firmware includes generated constants, so drift is impossible rather than merely discouraged |
| 37 | The wire protocol | Merged, two domains keyed by the magic byte. WASHER's framing, CRC and loss recovery come to the stepper as a new `0xA3` family carrying DETENT's tick interval; the planned bit is one bit in a flags byte DETENT's firmware already reads | Section 5.3. A pulse value is unsigned and a half step is signed, so one packet family cannot carry both |
| 37a | Classification order | The app sends nothing but the probe `?` until the peer is classified | A safety rule: `ECHO 0` to a step board releases both coil sets, and `M 1500 1500 0` is an unclamped full travel slam. Verified against the shipped firmware |
| 37b | BLE discovery | Filter on the Nordic UART service UUID, never on the device name | The step app's `DETENT` name prefix filter cannot see a `LASER RIG` board at all |
| 38 | Machine profiles | The central abstraction | Section 5.2 |
| 39 | Hardware folder | Yes, `hardware/washer-servo/` and `hardware/detent-28byj/`, files moved in | Neither original claimed the two servo base STLs. They get a home |
| 40 | Backwards compatibility | Explicit. Both hello strings, all three BLE names | A board in someone else's hands must keep working |
| 41 | Bridge integrations | Neither CONDUYT nor CLASP in v1 | Same shape of decision in both documents |
| 42 | Stretch scope | Union: `.beam.json` project files, example gallery, node CLI with a serialport transport, web flasher via esp-web-tools, theme extraction | None block release |
| 43 | Users and Risks sections | Kept and extended | Sections 8 and 14 |
| 44 | What supersedes what | This document supersedes both | Stated at the top, and both originals stay under `originals/` |
| 45 | House-style enforcement | A lint rule with teeth | Already implemented in `tools/eslint-plugin-house-style` |
| 46 | Config adoption | Principle 1, plus explicit persist on both rigs | WASHER's implicit flash write on every `CFG k=v` moves behind an explicit persist |
| 47 | DOM injection | Positive framing with a mechanism: injected primitives | `svg` takes a `parseXml`, `raster` takes a grayscale buffer |

## 13. Milestones

The order is chosen so neither rig ever goes dark. The protocol layer lands first, both existing
firmwares negotiate before anything is reflashed, and the UI is rebuilt last against an engine
that is already pinned by the bench invariants.

| M | Deliverable | Acceptance |
| --- | --- | --- |
| **M0** scaffold | Workspaces, CI green, boundary and house-style lint, theme extracted with its demo entry, golden-vector capture script, fixtures recorded from both HTML files, `h.txt` recovered | Lint, dep rules and an empty test pass on all packages. Fixtures exist and are committed |
| **M1** engine | Protocol layer ported from WASHER, planned bit added, profiles for both rigs, geometry unified per 2.1, planner and sim ported, both invariant suites executable | Golden vectors byte-identical. Fidelity table green. Both original test suites pass against the ported engine |
| **M2** parity | `beam-link` with all three transports, `apps/studio` replacing both HTML tools, single-file build | The gate that matters. `beam.html` opened from `file://` drives **both** physical rigs through a full calibrate-and-plot session, over serial and over BLE, against **unmodified** firmware. Bench soak green on both |
| **M3** firmware | Shared headers, both sketches refactored onto the driver interface, `plan=1` reported, framing and CRC on the stepper | Both sketches compile in CI and on the bench. Both rigs plot with the new firmware and with the old, selected by negotiation alone. Line counts inside budget |
| **M4** publish | 0.1.0 on npm, READMEs, Pages demo with the mock transport | `npm i @virgilvox/beam-link` and the snippet in section 6 drives a board of either kind |
| **M5** projects | `.beam.json` export and import, example gallery, docs complete | A saved project round-trips through export, reload, plot on both profiles |

M2 is the release gate. Nothing publishes until one file drives both machines.

## 14. Risks

- **Single-file weight.** The WASHER app pulls three.js r128 from a CDN for its 3D stage, which
  is incompatible with the offline principle and is by far the largest thing in the bundle.
  Mitigation: vendor a trimmed three.js, lazy-load the 3D stage behind a capability, and hold the
  no-3D build under 900 KB so the offline bench path is always small. The 3D stage is a preview
  luxury; the plot must never depend on it.
- **The profile abstraction leaking into the app anyway.** If every panel is behind a capability
  flag, the app can end up with the complexity of both rigs and the simplicity of neither.
  Mitigation: capability flags gate whole panels, never individual controls inside a panel, and
  the theme page renders both profiles side by side so the divergence is visible.
- **Duration-to-interval conversion on the stepper.** Deriving a tick interval from a
  millisecond duration is exact only where the dominant-axis delta is large enough. Mitigation:
  the conversion is a pinned invariant with a test over the full range, the 1 ms floor and the
  2000 step split bound the error, and the diagnostic path that genuinely needs tick precision
  stays on text.
- **WebBluetooth notify drops.** Already bit both projects. The dead man, heartbeat and stall
  poke contract is pinned by tests on both sides of the wire.
- **Two firmware build paths drifting.** The `.ino` is the single source and PlatformIO builds
  the same file. Protocol constants are generated, not typed twice.
- **Reference model drift.** Already happened once: the g++ harness models a superseded firmware
  while claiming to be copied verbatim. Mitigation: the same-commit sync duty, plus a CI check
  that the generated protocol header matches the one in the tree.
- **Scope migration to `@hackbuild`.** No undeclared deep imports anywhere; package names are
  identical across scopes.

## 15. Open questions

1. Does the WASHER rig want its four corner map upgraded from bilinear to the projective
   homography DETENT uses? Both are quad-to-quad and the homography is strictly more general,
   but bilinear is what the WASHER bench was tuned against and the Newton inverse is already
   working. Proposal: ship both, default per profile, and compare residuals on the bench at M2.
2. Is `fwtest.cpp` expected to build and pass against the current `.ino`, or is it frozen as a
   record of what was proven at an earlier revision? It differs on four counts today. The answer
   decides whether M0 re-derives its reference values at 20 kHz or preserves 10 kHz as a fixture.
3. The DETENT manual gives two derating factors for pull-out, 70 percent for STALL HUNT and 60
   percent for the RAMP pattern. Which is the bench-verified number? The profile carries one.
4. Should the `simulate()` and `lashError()` pair, currently the highest-value untested unit in
   the DETENT app, be pinned at M0 with newly written tests, or ported first and pinned at M1?
5. **The beam arming gesture, and this one is a safety surface.** WASHER arms with a button and
   tracks three separate armed flags that the e-stop clears. DETENT fires on shift-drag and
   deliberately keeps the beam lit if you release shift before the pointer, which its own manual
   flags with "so watch your hand". These cannot both be true of one pad. Needs a decision, not
   a merge. Until it is decided the merged pad ships with the button model, because an explicit
   arm is the safer default and the shift-drag behavior is the one its own documentation warns
   about.
6. Does the 3D stage survive? It is the largest single thing in the WASHER app, it needs
   three.js plus three embedded meshes plus the offset-pivot yaw solve, and it fights the offline
   size budget. The position taken in section 14 is to vendor it and lazy-load it behind a
   capability so the plot never depends on it, but "drop it" is a legitimate answer that saves
   most of the budget.
7. Which SVG importer wins? WASHER samples the browser's own path geometry via `getTotalLength`,
   which handles anything a browser can render but needs a live DOM. DETENT has a hand-written
   path parser that runs headless. Picking the parser is defensible for testability and it is a
   capability regression; it should be a stated decision rather than a side effect.
8. Where do the fifteen pieces of measured explainer prose live? The lead hint, the dithering
   explainer with its 0.94 mm to 0.35 mm claim, the mirror hint, the short-throw hint and the
   resolution, sweep and smoothness readouts are all paid-for copy that currently lives in one
   app's HTML and in no docs file.
9. Should `.beam.json` project save and load move out of M5? Neither original has it, so it is
   not a regression, but the merge makes it worse: with two profiles the operator retypes two
   sets of app-only settings, and the measured gearbox slack has no wire field at all, so a board
   moved to another machine loses the only record of it.
