import { DEG_PER_STEP, TICK_HZ } from "../constants.js";
import { anglesToMm, mmToAngles } from "../geometry/gimbal.js";
import type {
  ActuatorModel,
  AxisPair,
  Calibration,
  GimbalGeometry,
  MachineProfile,
  Point,
} from "../types.js";

/*
 * detent-28byj: two 28BYJ-48 steppers on ULN2003 boards driving two mirrors, plus a
 * 405nm diode, on an ESP32-C3 SuperMini. Axis unit is half steps.
 *
 * The geometry is the shared gimbal with vOffMm = 0, because the beam axis already
 * passes through the field centre. sepMm is the X mirror pivot to Y mirror pivot
 * distance and it is why the first axis's lever arm is throw + sep while the second
 * stays at throw.
 *
 * Resolution is fixed by the gearbox. ULN2003 has no current control, so half step
 * is the floor and there is no microstepping to reach for. That is why subQuantum
 * is "none" here and "dither" on the servo rig.
 */

export interface DetentConfig {
  throwMm: number;
  sepMm: number;
  fieldW: number;
  fieldH: number;
  /** Draw and travel rates in half steps per second. */
  rate: number;
  rateTravel: number;
  /** Measured pull-out rate if a stall hunt has been run, else null. */
  stallRate: number | null;
  minA: number;
  maxA: number;
  minB: number;
  maxB: number;
  limitsOn: boolean;
  /** Backlash the board takes up, in steps. */
  lashA: number;
  lashB: number;
  /** Backlash the gearbox actually has, measured with the lash gauge. */
  slackA: number;
  slackB: number;
}

export const DETENT_DEFAULTS: DetentConfig = {
  throwMm: 150,
  sepMm: 22,
  fieldW: 120,
  fieldH: 120,
  rate: 400,
  rateTravel: 500,
  stallRate: null,
  minA: -2000,
  maxA: 2000,
  minB: -2000,
  maxB: 2000,
  /* Off by default. The firmware comment is the reason: "0 = free jog, which is how
   * you find the edges." */
  limitsOn: false,
  lashA: 0,
  lashB: 0,
  slackA: 0,
  slackB: 0,
};

const RAD = 180 / Math.PI;

/**
 * Above roughly 1000 half steps per second a 28BYJ-48 starts skipping, and a
 * skipped step is geometry that is silently gone. The bench procedure is the stall
 * hunt: walk the rate up, watch where the home blink stops coming back to the same
 * place, and derate. 0.7 is the STALL HUNT figure.
 *
 * Open question recorded in the PRD: the manual gives 70 percent for STALL HUNT and
 * 60 percent for the older RAMP pattern. This profile carries one number and it is
 * the one the working tool prints.
 */
export const PULL_OUT_DERATE = 0.7;
export const PULL_OUT_ASSUMED = 1000;

export function createDetent28byj(cfg: Partial<DetentConfig> = {}): MachineProfile {
  const c: DetentConfig = { ...DETENT_DEFAULTS, ...cfg };

  const g: GimbalGeometry = { throwMm: c.throwMm, sepMm: c.sepMm, vOffMm: 0 };

  /*
   * Angle to axis unit. A mirror deflects the beam by twice its own rotation, so the
   * mirror angle is half the beam angle, and that halving is the entire difference
   * between this profile and the servo one below the geometry.
   *
   * Inversion is deliberately absent here. It lives in the firmware phase table,
   * because that way it changes which way the shaft actually turns for every command
   * path (jog, raw steps, and mm moves alike) while the logical step counter keeps
   * following what was asked for. Putting it in the kinematics only ever affected mm
   * moves, which is why jog would not invert.
   */
  const angleToSteps = (t: number) => (t / 2) * RAD / DEG_PER_STEP;
  const stepsToAngle = (s: number) => (s * DEG_PER_STEP * 2) / RAD;

  const ceiling = c.stallRate ?? PULL_OUT_ASSUMED;

  return {
    id: "detent-28byj",
    label: "DETENT: two mirror 28BYJ-48 scanner",
    geometry: g,
    beamAnglePerAxisAngle: 2,

    axis: {
      a: { name: "halfstep", quantum: 1, min: c.minA, max: c.maxA, subQuantum: "none" },
      b: { name: "halfstep", quantum: 1, min: c.minB, max: c.maxB, subQuantum: "none" },
    },

    limits: {
      maxRate: ceiling,
      /*
       * The firmware's own ramp goes from 3x the interval at standstill to 1x over
       * rampSteps, which is a linear rate ramp rather than a constant acceleration.
       * Expressed as an acceleration over the default 150 step ramp at the default
       * 400 steps/s, that is roughly rate^2 / (2 * rampSteps). The planner's own
       * default accel of 3000 sits near it deliberately.
       */
      maxAccel: 3000,
      /*
       * A stepper asked for more than its pull-out rate loses sync, and every step
       * after that point is in the wrong place with no way to know. This is the case
       * the planner keeps a margin for.
       */
      overrun: "destroys",
      derate: PULL_OUT_DERATE,
    },

    caps: {
      corners: true,
      mappingOnBoard: true,
      pulseWindow: false,
      dither: false,
      backlash: true,
      coilRelease: true,
      pullOut: true,
      /* The planned bit turns the firmware's reversal ramp off. The host owns corner
       * deceleration from that moment, and getting it wrong skips steps. */
      firmwareRampBypassed: true,
      lead: false,
    },

    forward(pair: AxisPair, cal?: Calibration | null): Point {
      const t1 = stepsToAngle(pair.a);
      const t2 = stepsToAngle(pair.b);
      if (cal) {
        const p = cal.inverse(t1, t2);
        if (p) return p;
      }
      return anglesToMm({ t1, t2 }, g);
    },

    inverse(p: Point, cal?: Calibration | null): AxisPair {
      const a = cal ? cal.forward(p) : mmToAngles(p, g);
      return { a: angleToSteps(a.t1), b: angleToSteps(a.t2) };
    },

    sensitivity(from: Point, to: Point, cal?: Calibration | null): number {
      const ds = Math.hypot(to.x - from.x, to.y - from.y);
      if (ds < 1e-9) return 0;
      const A = this.inverse(from, cal);
      const B = this.inverse(to, cal);
      /*
       * The busier axis. This is not an approximation on a stepper: the Bresenham
       * interpolator paces on the dominant axis and the minor axis steps on the same
       * tick when the error term crosses, so the dominant axis count IS the segment's
       * cost in ticks. The planner's distance term and the firmware's are the same
       * number.
       */
      return Math.max(Math.abs(B.a - A.a), Math.abs(B.b - A.b)) / ds;
    },

    arcLength(from: AxisPair, to: AxisPair): number {
      /* Exactly the Bresenham dominant axis count, which is the segment's cost in
       * ticks. The planner's distance term and the firmware's are one number. */
      return Math.max(Math.abs(to.a - from.a), Math.abs(to.b - from.b));
    },

    sampleStepMm(near: Point, cal?: Calibration | null): number {
      /*
       * One quantum. Sampling at the step size makes the non-linearity problem
       * disappear by brute force: consecutive commands are one step apart, the
       * board's Bresenham draws a straight line in step space between them, and over
       * one step that deviates from the true mapped path by far less than the
       * quantum. The map is effectively re-projected at every single step.
       *
       * The shipped tool has a recorded sharp edge here and it has two halves: it
       * samples the gain ONCE, at the origin, and it samples it along X ONLY. Under a
       * solved homography that under-samples at the field edge and on the axis that
       * happens to be stretched. Both halves are fixed: this is evaluated at the point
       * in question, and it takes the worst of the two axis probes.
       *
       * Worst rather than average because a step that is too fine costs command count
       * and a step that is too coarse costs geometry, and only one of those is
       * recoverable.
       */
      const kx = this.sensitivity(near, { x: near.x + 1, y: near.y }, cal);
      const ky = this.sensitivity(near, { x: near.x, y: near.y + 1 }, cal);
      const k = Math.max(kx, ky);
      return k > 1e-9 ? 1 / k : 0.1;
    },

    quantise(pair: AxisPair): AxisPair {
      /*
       * Half steps, and there is nothing finer to reach for.
       *
       * INV-65: the firmware rounds with lroundf, which rounds half AWAY from zero,
       * while Math.round rounds half toward positive infinity. They disagree at
       * negative half integers, which is exactly where a symmetric field puts a lot
       * of points. Match the firmware.
       */
      const half = (v: number) => Math.sign(v) * Math.round(Math.abs(v));
      return { a: half(pair.a), b: half(pair.b) };
    },

    actuator(): ActuatorModel {
      return createStepperActuator(c);
    },

    matches(hello: string, config: Readonly<Record<string, string>>): boolean {
      if (/^detent\b/.test(hello)) return true;
      if (/^BEAM\b/.test(hello) && config["profile"] === "detent-28byj") return true;
      /* A board that reports step rates and no pulse window is a stepper rig. */
      return config["rate"] !== undefined && config["min"] === undefined;
    },
  };
}

/*
 * The stepper error model.
 *
 * The firmware injects lash steps whenever a commanded direction reverses; that is
 * a command-stream behavior and it belongs in the reference model, not here. What
 * belongs here is what the real gear train does to the mirror: a hysteresis band of
 * width slack, inside which the shaft moves and the mirror does not.
 *
 * The pairing is the whole point of the preview. Comp equal to slack cancels out.
 * Comp of zero against real slack produces the classic doubled line, and comp
 * larger than slack overshoots the other way. The preview shows what those two
 * disagreeing looks like on the wall.
 *
 * Note what this model does NOT claim: a uniform offset just shifts the whole
 * drawing and does not matter. What matters is the spread, strokes drawn left to
 * right landing somewhere different from strokes drawn right to left, which is the
 * doubling you actually see.
 */
function createStepperActuator(c: DetentConfig): ActuatorModel {
  const halfA = c.slackA / 2;
  const halfB = c.slackB / 2;

  let mirrorA = 0;
  let mirrorB = 0;

  const follow = (shaft: number, mirror: number, half: number) => {
    if (shaft - mirror > half) return shaft - half;
    if (mirror - shaft > half) return shaft + half;
    return mirror;
  };

  return {
    reset(a: number, b: number) {
      mirrorA = a;
      mirrorB = b;
    },
    /*
     * dt is unused: a stepper has no continuous dynamics to integrate at this level.
     * It either took the step or it did not, and whether it did is a pull-out
     * question the planner already answered by staying under the derated ceiling.
     * The reference model in sim/ owns tick pacing, ramp and coil settle.
     */
    step(_dt: number, cmdA: number, cmdB: number): AxisPair {
      mirrorA = follow(cmdA, mirrorA, halfA);
      mirrorB = follow(cmdB, mirrorB, halfB);
      return { a: mirrorA, b: mirrorB };
    },
  };
}

/** Interval in ISR ticks between dominant axis steps, for a given rate. */
export function intervalFor(stepsPerSec: number): number {
  const sps = Math.max(1, stepsPerSec);
  /* INV-64: C integer division truncates toward zero. Math.trunc, never Math.floor. */
  return Math.min(65535, Math.max(1, Math.trunc(TICK_HZ / sps)));
}
