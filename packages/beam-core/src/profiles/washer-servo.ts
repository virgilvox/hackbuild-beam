import { mmToAngles, anglesToMm } from "../geometry/gimbal.js";
import type {
  ActuatorModel,
  AxisPair,
  Calibration,
  GimbalGeometry,
  MachineProfile,
  Point,
} from "../types.js";

/*
 * washer-servo: a two servo pan/tilt head with a 405nm diode, on an
 * ESP32-WROOM-32E. Axis unit is servo pulse microseconds.
 *
 * The geometry is the shared gimbal with sepMm = 0, because a pan/tilt head
 * rotates about one point. The vertical offset is real and it is the thing that
 * once cost 159 mm of drawing offset: the cardboard sits on the floor, so its
 * centre is at wallH/2 above the floor while the laser is at mountH, and a design
 * point at wy is wy + vOff above the laser, which is what the tilt axis has to
 * cover.
 */

/**
 * What the servo can actually do.
 *
 * A 9g micro servo is not a galvo. It takes a new position 50 times a second and
 * no faster, it has a few microseconds of deadband inside which a command produces
 * no movement at all, and it has gear slop that turns a step in acceleration into
 * an audible knock and a visible wobble. Planning in target millimetres alone
 * ignores every one of those. These are the numbers the planner is actually
 * constrained by, and they are per axis, in degrees.
 *
 * `band` is the paid for detail: the inner loop is proportional over a narrow band
 * and flat out beyond it, which is how these actually behave. A single soft gain
 * for every servo made a 9g and a digital settle in almost the same time, which is
 * not what the bench shows.
 */
export interface ServoPreset {
  label: string;
  slew: number; // deg/s
  accel: number; // deg/s^2
  deadband: number; // us
  frame: number; // hz, how often the servo latches a new command
  lash: number; // deg of gear slop eaten on a reversal
  band: number; // deg over which the inner loop is proportional
}

export const SERVO_PRESETS: Record<string, ServoPreset> = {
  micro9g: { label: "9g micro (SG90 / MG90S)", slew: 240, accel: 1800, deadband: 8, frame: 50, lash: 0.55, band: 6.0 },
  micro9gm: { label: "9g metal gear (MG90S)", slew: 300, accel: 2600, deadband: 6, frame: 50, lash: 0.3, band: 5.0 },
  standard: { label: "Standard metal gear", slew: 420, accel: 5000, deadband: 4, frame: 50, lash: 0.18, band: 3.5 },
  digital: { label: "Digital high speed", slew: 700, accel: 9000, deadband: 2, frame: 200, lash: 0.08, band: 1.6 },
};

export interface WasherConfig {
  distMm: number;
  wallW: number;
  wallH: number;
  mountH: number;
  minUs: number;
  maxUs: number;
  homeA: number; // pulse us the design origin maps to, set by ZERO
  homeB: number;
  trimA: number; // degrees
  trimB: number;
  invA: boolean;
  invB: boolean;
  servo: keyof typeof SERVO_PRESETS | string;
  dither: boolean;
}

export const WASHER_DEFAULTS: WasherConfig = {
  distMm: 152, // 6 in throw
  wallW: 305, // onto a 12 in square target
  wallH: 305,
  mountH: 70,
  minUs: 500,
  maxUs: 2500,
  homeA: 1500,
  homeB: 1500,
  trimA: 0,
  trimB: 0,
  invA: false,
  invB: false,
  servo: "micro9g",
  dither: false,
};

const RAD = 180 / Math.PI;

function geometryOf(c: WasherConfig): GimbalGeometry {
  return {
    throwMm: c.distMm,
    sepMm: 0,
    vOffMm: c.wallH / 2 - c.mountH,
  };
}

/** Degrees of servo travel per microsecond of pulse. 0.09 at the default window. */
function degPerUs(c: WasherConfig): number {
  return 180 / Math.max(1, c.maxUs - c.minUs);
}

export function createWasherServo(cfg: Partial<WasherConfig> = {}): MachineProfile {
  const c: WasherConfig = { ...WASHER_DEFAULTS, ...cfg };
  const preset = SERVO_PRESETS[c.servo] ?? SERVO_PRESETS["micro9g"]!;
  const g = geometryOf(c);
  const dpu = degPerUs(c);
  const usPerDeg = 1 / dpu;

  const clampUs = (v: number) => Math.min(c.maxUs, Math.max(c.minUs, v));

  /*
   * Angle to axis unit. The servo horn carries the whole head, so the axis angle is
   * the beam angle and beamAnglePerAxisAngle is 1.
   *
   * Inversion is applied here, at the last step, and never in the mm-space model.
   * INV-09: inversion is a wiring correction, so it changes what the hardware does
   * and must not transform the preview. The stepper rig gets this for free because
   * its firmware inverts at the phase table; the servo rig has no phase table, so
   * the equivalent place is the axis encoder, which is still after all the geometry
   * and therefore still invisible to the preview.
   *
   * TRIM IS A DELIBERATE DEVIATION FROM THE SHIPPED APP. See INV-86.
   *
   * In the original, trim is added inside `ik` and then consumed as a difference by
   * `wallToAngles` and by `fk`, so it cancels exactly and the two trim controls have
   * no effect on the aim at all. Verified numerically: trim of (5, -3) degrees gives
   * a bit-identical aim to trim of zero at every probe.
   *
   * Here it is applied absolutely, which is what the control obviously means. This
   * is the one place the port does not reproduce the original, and it is flagged
   * rather than silent because reproducing the original faithfully would mean
   * shipping a dead knob.
   */
  const angleToUs = (t: number, home: number, trim: number, inv: boolean) => {
    const deg = (inv ? -1 : 1) * t * RAD + trim;
    return clampUs(home + deg * usPerDeg);
  };
  const usToAngle = (us: number, home: number, trim: number, inv: boolean) => {
    const deg = (us - home) * dpu - trim;
    return ((inv ? -1 : 1) * deg) / RAD;
  };

  return {
    id: "washer-servo",
    /*
     * A whole deadband, because that is how far the miss actually is. The inner
     * loop cuts the motor once the error falls inside the band, so an axis coming
     * up to a target stops a full deadband short of it rather than half. Half was
     * the intuitive figure and it measures worse: the sweep is monotonic all the
     * way to 1.0 and turns over after.
     */
    backlashAxis: preset.deadband,
    label: "WASHER: servo pan/tilt head",
    geometry: g,
    beamAnglePerAxisAngle: 1,

    axis: {
      a: { name: "us", quantum: 1, min: c.minUs, max: c.maxUs, subQuantum: "dither" },
      b: { name: "us", quantum: 1, min: c.minUs, max: c.maxUs, subQuantum: "dither" },
    },

    limits: {
      maxRate: preset.slew * usPerDeg,
      maxAccel: preset.accel * usPerDeg,
      /* A servo asked for more than it can do lags and catches up. The drawing goes
       * soft; it does not become a different drawing. */
      overrun: "degrades",
      derate: 1.0,
    },

    caps: {
      corners: true,
      mappingOnBoard: true,
      pulseWindow: true,
      dither: true,
      backlash: false,
      coilRelease: false,
      pullOut: false,
      /* A servo has no ramp of its own to bypass: the board interpolates a span, it
       * does not pace a step clock. */
      firmwareRampBypassed: false,
      lead: true,
    },

    forward(pair: AxisPair, cal?: Calibration | null): Point {
      const t1 = usToAngle(pair.a, c.homeA, c.trimA, c.invA);
      const t2 = usToAngle(pair.b, c.homeB, c.trimB, c.invB);
      if (cal) {
        const p = cal.inverse(t1, t2);
        if (p) return p;
      }
      return anglesToMm({ t1, t2 }, g);
    },

    inverse(p: Point, cal?: Calibration | null): AxisPair {
      const a = cal ? cal.forward(p) : mmToAngles(p, g);
      return {
        a: angleToUs(a.t1, c.homeA, c.trimA, c.invA),
        b: angleToUs(a.t2, c.homeB, c.trimB, c.invB),
      };
    },

    sensitivity(from: Point, to: Point, cal?: Calibration | null): number {
      const ds = Math.hypot(to.x - from.x, to.y - from.y);
      if (ds < 1e-9) return 0;
      const A = this.inverse(from, cal);
      const B = this.inverse(to, cal);
      /* The busier axis, not the norm. Two independent axes each have their own
       * limit, and it is the one doing the most work that binds. */
      return Math.max(Math.abs(B.a - A.a), Math.abs(B.b - A.b)) / ds;
    },

    arcLength(from: AxisPair, to: AxisPair): number {
      return Math.max(Math.abs(to.a - from.a), Math.abs(to.b - from.b));
    },

    sampleStepMm(near: Point, cal?: Calibration | null): number {
      /*
       * One deadband step in target millimetres, halved, or thirded when dither is
       * carrying the sub-quantum detail.
       *
       * The command chain is already eight times finer than the servo: a one
       * microsecond pulse change is about 0.24 mm on the target against a 1.91 mm
       * deadband. So this is not about resolving what the servo can do. It is about
       * not throwing detail away in the source before the planner ever sees it.
       */
      const kx = this.sensitivity(near, { x: near.x + 1, y: near.y }, cal);
      const ky = this.sensitivity(near, { x: near.x, y: near.y + 1 }, cal);
      const k = Math.max(kx, ky);
      const oneStepMm = k > 1e-9 ? preset.deadband / k : 1;
      const raw = c.dither ? oneStepMm / 3 : oneStepMm / 2;
      return Math.min(3, Math.max(0.08, raw));
    },

    quantise(pair: AxisPair): AxisPair {
      /*
       * Integer microseconds are the physical floor. Dither exists to get below it
       * and it lives on the board, applied to the live command at every write, so it
       * is deliberately not applied here: the planner's number stays exactly where
       * the planner put it and the carrier rides on top.
       */
      return { a: Math.round(clampUs(pair.a)), b: Math.round(clampUs(pair.b)) };
    },

    actuator(): ActuatorModel {
      return createServoActuator(preset, c);
    },

    matches(hello: string, config: Readonly<Record<string, string>>): boolean {
      if (/^READY LASER RIG\b/.test(hello)) return true;
      if (/^BEAM\b/.test(hello) && config["profile"] === "washer-servo") return true;
      /* A board that reports a pulse window and no step rate is a servo rig even if
       * the hello line was missed on a mid-session reconnect. */
      return config["min"] !== undefined && config["max"] !== undefined && config["rate"] === undefined;
    },
  };
}

/*
 * The servo error model.
 *
 * Four things shape how a hobby servo really moves, and the first version of this
 * model had one of them: frame, it latches a new command once per 20 ms and ignores
 * the rest; deadband, inside a few microseconds of error it simply does not move;
 * accel, the little motor and its gearbox take time to get going; backlash,
 * reversing direction eats the gear slop before anything moves. All four show up in
 * a plot. The deadband is what turns a slow curve into stair steps, and the
 * backlash is what makes a retraced line miss its own path.
 *
 * Deadband is hysteresis, not quantisation: below some error the motor is simply
 * off, so it stops up to half a deadband short of the command on whichever side it
 * approached from. That is why a retraced line misses itself.
 */
function createServoActuator(preset: ServoPreset, c: WasherConfig): ActuatorModel {
  const usPerDeg = 1 / degPerUs(c);
  const slewUs = preset.slew * usPerDeg;
  const accelUs = preset.accel * usPerDeg;
  const bandUs = preset.band * usPerDeg;
  const lashUs = preset.lash * usPerDeg;
  const frameSec = 1 / Math.max(1, preset.frame);

  /*
   * Dither, exactly as the firmware does it.
   *
   * Amplitude is three quarters of the deadband and the phase flips once per servo
   * frame, applied to the LIVE command at every write rather than to a frozen
   * snapshot. Freezing it was a real bug once: it quietly dropped the interpolator
   * to the frame rate whenever dither was on, so the one setting meant to make lines
   * finer was making them steppier.
   *
   * It is symmetric about the command on purpose. Quantising onto a deadband sized
   * grid was tried first and is worse than nothing: it is not symmetric, so the
   * servo follows the near side of the grid and not the far, and the average walks
   * toward whichever grid line is closer.
   *
   * Gated on a deadband worth breaking, matching the firmware's own guard.
   */
  const ditherOn = c.dither && preset.deadband >= 2;
  const ditherAmp = Math.round(preset.deadband * 0.75);

  interface AxisState {
    cur: number;
    latched: number;
    vel: number;
    lash: number;
    dir: number;
  }
  const mk = (v: number): AxisState => ({ cur: v, latched: v, vel: 0, lash: 0, dir: 0 });

  let a = mk(c.homeA);
  let b = mk(c.homeB);
  let frameAcc = 0;
  let ditherAcc = 0;
  let ditherPhase = 1;

  const advance = (s: AxisState, dt: number) => {
    const err = s.latched - s.cur;
    if (Math.abs(err) < preset.deadband) {
      /* Bled rather than zeroed: the motor is off, not braked. Deadband is
       * hysteresis and not quantisation, so it stops up to half a deadband short on
       * whichever side it approached from. That is why a retraced line misses
       * itself, and it is what dither exists to break. */
      s.vel *= 0.5;
      return;
    }
    const want = Math.max(-slewUs, Math.min(slewUs, (err / bandUs) * slewUs));
    const dv = Math.max(-accelUs * dt, Math.min(accelUs * dt, want - s.vel));
    s.vel += dv;

    const stepv = s.vel * dt;
    const dir = Math.sign(stepv);
    if (dir && s.dir && dir !== s.dir) s.lash = lashUs;
    if (dir) s.dir = dir;

    if (s.lash > 0) {
      const eat = Math.min(s.lash, Math.abs(stepv));
      s.lash -= eat;
      s.cur += dir * (Math.abs(stepv) - eat);
    } else {
      s.cur += stepv;
    }
  };

  return {
    reset(av: number, bv: number) {
      a = mk(av);
      b = mk(bv);
      frameAcc = 0;
      ditherAcc = 0;
      ditherPhase = 1;
    },
    step(dt: number, cmdA: number, cmdB: number): AxisPair {
      let ca = cmdA;
      let cb = cmdB;

      if (ditherOn) {
        ditherAcc += dt;
        if (ditherAcc >= frameSec) {
          ditherAcc %= frameSec;
          ditherPhase = -ditherPhase;
        }
        ca = clampUsFor(c, ca + ditherPhase * ditherAmp);
        cb = clampUsFor(c, cb + ditherPhase * ditherAmp);
      }

      /* The servo latches one position per frame and ignores the rest. This is why a
       * job cannot carry more detail than frameHz times its duration, whatever the
       * planner does. */
      frameAcc += dt;
      if (frameAcc >= frameSec) {
        frameAcc %= frameSec;
        a.latched = ca;
        b.latched = cb;
      }
      advance(a, dt);
      advance(b, dt);
      return { a: a.cur, b: b.cur };
    },
  };
}

function clampUsFor(c: WasherConfig, v: number): number {
  return Math.min(c.maxUs, Math.max(c.minUs, v));
}

/**
 * How much detail this machine can actually put on the target, and what that means
 * for the thing you are trying to draw.
 *
 * The deadband is angular, so its size on the target scales with the throw and so
 * does the drawing: the ratio is what matters and it is fixed by the geometry. At
 * the shipped defaults one deadband is about 1.9 mm on a 120 mm field, which is 63
 * resolvable steps across the whole field. Ten characters of text therefore get
 * about six steps of width each, and six steps is not a letter.
 *
 * This is the number the app should show before someone spends a session wondering
 * why their text came out as a scribble.
 */
export interface ServoResolution {
  /** One deadband, in target millimetres. */
  deadbandMm: number;
  /** One commandable microsecond, in target millimetres. */
  quantumMm: number;
  /** Resolvable steps across the field. */
  stepsAcrossField: number;
  /** Dither reduces the effective hysteresis to roughly this. */
  effectiveMm: number;
}

export function servoResolution(
  profile: MachineProfile,
  fieldMm: number,
  preset: ServoPreset,
  dither: boolean,
  /** Directional compensation strength, as a fraction of one deadband. */
  backlashComp = 0,
): ServoResolution {
  const gain = profile.sensitivity({ x: 0, y: 0 }, { x: 1, y: 0 });
  const deadbandMm = gain > 1e-9 ? preset.deadband / gain : 0;
  const quantumMm = gain > 1e-9 ? 1 / gain : 0;
  /*
   * Placement uncertainty. Which term decides it depends on what is being done
   * about the deadband, because the deadband stops being the binding constraint
   * once it is cancelled rather than merely averaged.
   *
   * UNCOMPENSATED it is the full deadband and not half of it. Half is the average
   * error; what decides whether a shape reads is the SPREAD. A stroke approached
   * from the left stops short on the left, the same stroke approached from the
   * right stops short on the right, and the gap between those is a whole deadband.
   * That is the doubling on a retraced line.
   *
   * DITHERED, the hysteresis is broken by keeping the servo hunting and the bench
   * figure is about 0.35 mm of symmetric wobble where there was 0.94 mm of
   * direction dependent error, a little over a third.
   *
   * COMPENSATED, the directional term is gone and what is left is how finely a
   * position can be ASKED for. The wire carries whole microseconds, so the command
   * grid is one quantum however good the servo is, and measurement puts the
   * residual at about two of them: 0.47, 0.49, 0.53 and 0.46 mm for the four
   * presets against a 0.239 mm quantum, essentially flat across a deadband range of
   * four to one. The deadband term is kept as a floor so a truly coarse servo is
   * not promised a resolution its own dead zone cannot deliver.
   *
   * The practical consequence is worth stating plainly: once compensation is on,
   * a better servo buys very little, because the limit has moved to the pulse
   * resolution. Going below it means sub-microsecond commands, which neither the
   * wire format nor writeMicroseconds can express today.
   */
  const compensated = backlashComp > 0;
  /*
   * The command grid floors every strategy, not just compensation. A position can
   * only be asked for in whole microseconds, so no amount of cleverness about the
   * deadband gets below it, and a model that lets one strategy through the floor
   * will recommend a servo upgrade that cannot pay. The dither factor in particular
   * was calibrated on the 9g servo and, unfloored, claimed 0.18 mm for a digital
   * one where measurement puts the error at 1.35.
   */
  const floorMm = quantumMm * 2;
  const strategyMm = compensated
    ? deadbandMm * 0.25
    : dither
      ? deadbandMm * 0.37
      : deadbandMm;
  const effectiveMm = Math.max(compensated || dither ? floorMm : 0, strategyMm);
  return {
    deadbandMm,
    quantumMm,
    stepsAcrossField: deadbandMm > 1e-9 ? fieldMm / deadbandMm : 0,
    effectiveMm,
  };
}
