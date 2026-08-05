import type { ActuatorModel, AxisPair, Calibration, MachineProfile, Point } from "../types.js";
import { sampleAt, type PlanPoint, type Timeline } from "../planner/plan.js";
import { applyBacklash } from "../planner/backlash.js";

/*
 * Replay a plan through the machine's own error model.
 *
 * The preview is only worth looking at if it replays what the hardware will really
 * do rather than the ideal path. Both original projects learned that separately and
 * both ended up drawing two paths on top of each other: the plan, and the trace.
 *
 * What the trace shows is different on each rig, and that is the point of running it
 * through MachineProfile.actuator rather than through one shared model:
 *
 *   servo     deadband turns a slow curve into stair steps, the 50 Hz frame latch
 *             quantises when a new command is even seen, the proportional inner loop
 *             rounds every arrival, and gear slop makes a retraced line miss its own
 *             path
 *   stepper   a hysteresis band of width slack, inside which the shaft moves and the
 *             mirror does not. Comp equal to slack cancels out; comp of zero against
 *             real slack produces the classic doubled line, and comp larger than
 *             slack overshoots the other way
 *
 * The loop is a deterministic fixed rate loop, not a wall clock one. INV-70: every
 * assertion about it counts steps, not milliseconds, so a port to setInterval or to
 * requestAnimationFrame cannot reproduce it.
 */

export interface SimOptions {
  /**
   * Axis units of directional compensation, normally the profile's `backlashAxis`
   * times whatever strength is configured. See planner/backlash.ts: it is worth
   * more than every other knob on the servo rig put together.
   */
  backlash?: number | undefined;
  /**
   * Seconds per simulation step. The default resolves a 50 Hz servo frame twenty
   * times over, which is enough to see the latch and the deadband without producing
   * an array nobody can draw.
   */
  dtSec?: number | undefined;
  /**
   * Hard cap on samples. A twenty minute job at one millisecond would be a million
   * points and a browser tab that stops responding. Hitting it sets `truncated`, and
   * a truncated preview says so rather than quietly showing half a drawing.
   */
  maxSamples?: number | undefined;
  /**
   * Feed the actuator the interpolated command rather than a step and hold.
   *
   * True by default, and it is the faithful choice on both rigs: the servo firmware
   * interpolates a span between two commanded pulses, and the stepper firmware runs
   * Bresenham between two commanded step pairs. A step and hold command stream is
   * what the machine would see if the board did neither, which is worth being able to
   * look at, so it stays switchable.
   */
  interpolate?: boolean | undefined;
  cal?: Calibration | null | undefined;
}

export interface SimSample {
  /** Seconds from the start of the job. */
  readonly t: number;
  /** What the machine was told, in axis units. */
  readonly cmd: AxisPair;
  /** Where the machine actually is, in axis units. Fractional: this is the mirror. */
  readonly actual: AxisPair;
  /** Where the beam really lands, target millimetres. */
  readonly at: Point;
  /** Where the plan wanted it at this instant, target millimetres. */
  readonly ideal: Point;
  readonly laser: boolean;
}

export interface SimResult {
  readonly samples: readonly SimSample[];
  /**
   * The honest error metric, millimetres.
   *
   * A uniform offset just shifts the whole drawing and does not matter. What matters
   * is the spread: strokes drawn left to right landing somewhere different from
   * strokes drawn right to left. So the mean error is subtracted and the worst
   * residual reported, which is the doubling you actually see on the wall.
   */
  readonly spreadMm: number;
  /** Worst absolute deviation from the plan, millimetres, mean included. */
  readonly worstMm: number;
  /** Mean absolute deviation, millimetres. */
  readonly meanMm: number;
  readonly dtSec: number;
  readonly truncated: boolean;
}

const DEFAULT_DT = 0.001;
const DEFAULT_MAX_SAMPLES = 200_000;

/** Index of the last plan point at or before t. The walk is forward, so no search. */
function advance(plan: readonly PlanPoint[], i: number, t: number): number {
  let k = i;
  while (k + 1 < plan.length && plan[k + 1]!.t <= t) k++;
  return k;
}

/**
 * Run a plan through the machine and produce the traced path.
 *
 * The command stream is the EMITTED plan, not the ideal path: quantised axis pairs on
 * the machine's own grid, which is all the hardware ever sees. Comparing the trace
 * against the ideal path is then a like for like question, because every loss between
 * the two is a loss the machine really imposes.
 */
export function simulate(
  tl: Timeline,
  profile: MachineProfile,
  options: SimOptions = {},
): SimResult {
  const dt = Math.max(1e-6, options.dtSec ?? DEFAULT_DT);
  const maxSamples = Math.max(1, Math.trunc(options.maxSamples ?? DEFAULT_MAX_SAMPLES));
  const interpolate = options.interpolate ?? true;
  const cal = options.cal ?? tl.options.cal;
  const plan = tl.plan;

  if (!plan.length) {
    return { samples: [], spreadMm: 0, worstMm: 0, meanMm: 0, dtSec: dt, truncated: false };
  }

  /* Off by default so nothing changes for a caller that has not asked. */
  const backlashAxis = options.backlash ?? 0;

  /*
   * Which way each axis is going, measured over a servo frame.
   *
   * The obvious version, the sign of the step to the next plan point, is wrong and
   * quietly so. Plan points are a millisecond apart and an axis creeping through a
   * shallow curve moves a hundredth of a microsecond between two of them, so the
   * sign is numerical dust and the compensation flips back and forth: a dither, at
   * one whole deadband, exactly where the drawing is most delicate.
   *
   * A distance threshold per step is no better, because no single step clears it
   * and the direction then reads as stationary everywhere.
   *
   * Twenty milliseconds is the honest window: it is one frame of the thing being
   * compensated, and over a frame a moving axis has genuinely moved. Time is
   * monotonic so the lookahead only ever walks forward, which keeps this linear.
   */
  const dirA = new Int8Array(plan.length);
  const dirB = new Int8Array(plan.length);
  if (backlashAxis > 0) {
    const WINDOW = 0.02;
    /* Small enough to catch a slow axis, large enough to reject float dust. */
    const eps = backlashAxis * 0.02;
    let k = 0;
    for (let j = 0; j < plan.length; j++) {
      if (k < j) k = j;
      while (k < plan.length - 1 && plan[k]!.t - plan[j]!.t < WINDOW) k++;
      const da = plan[k]!.axis.a - plan[j]!.axis.a;
      const db = plan[k]!.axis.b - plan[j]!.axis.b;
      dirA[j] = Math.abs(da) > eps ? (da > 0 ? 1 : -1) : 0;
      dirB[j] = Math.abs(db) > eps ? (db > 0 ? 1 : -1) : 0;
    }
  }

  const actuator: ActuatorModel = profile.actuator();
  const first = plan[0]!;
  actuator.reset(first.axis.a, first.axis.b);

  const samples: SimSample[] = [];
  const ex: number[] = [];
  const ey: number[] = [];
  let truncated = false;
  let i = 0;

  /* The timeline's own duration is unscaled; the emitted durations carry the speed
   * override. Replay in emitted time so what is simulated is what is sent. */
  const span = tl.dur / tl.options.speed;

  /* INV-70: the loop counts steps and derives the time, rather than accumulating a
   * float. Accumulation drifts, and a drifting clock in the model is a model whose
   * gap assertions cannot be compared with the firmware's. */
  const steps = Math.max(1, Math.ceil(span / dt));
  for (let k = 0; k <= steps; k++) {
    const t = k * dt;
    if (samples.length >= maxSamples) {
      truncated = true;
      break;
    }
    i = advance(plan, i, t * tl.options.speed);
    const here = plan[i]!;
    const next = plan[i + 1];

    let cmd: AxisPair = here.axis;
    if (interpolate && next) {
      const startSec = here.t / tl.options.speed;
      const endSec = next.t / tl.options.speed;
      const spanSec = endSec - startSec;
      const f = spanSec > 1e-12 ? Math.max(0, Math.min(1, (t - startSec) / spanSec)) : 0;
      cmd = profile.quantise({
        a: here.axis.a + (next.axis.a - here.axis.a) * f,
        b: here.axis.b + (next.axis.b - here.axis.b) * f,
      });
    }

    /*
     * The same correction the wire carries, applied here so the preview predicts
     * what the machine will really do rather than what an uncompensated one would.
     * If these two ever diverge the app is confidently showing the wrong drawing.
     */
    const comp = applyBacklash(cmd, dirA[i]!, dirB[i]!, backlashAxis);
    const actual = actuator.step(dt, comp.a, comp.b);
    const at = profile.forward(actual, cal);
    const ideal = sampleAt(tl, t * tl.options.speed).at;
    samples.push({
      t,
      cmd: { a: cmd.a, b: cmd.b },
      actual: { a: actual.a, b: actual.b },
      at,
      ideal,
      laser: here.laser,
    });
    ex.push(at.x - ideal.x);
    ey.push(at.y - ideal.y);
  }

  let mx = 0;
  let my = 0;
  let worst = 0;
  let sum = 0;
  for (let k = 0; k < ex.length; k++) {
    mx += ex[k]!;
    my += ey[k]!;
    const d = Math.hypot(ex[k]!, ey[k]!);
    sum += d;
    if (d > worst) worst = d;
  }
  const n = Math.max(1, ex.length);
  mx /= n;
  my /= n;
  let spread = 0;
  for (let k = 0; k < ex.length; k++) {
    const d = Math.hypot(ex[k]! - mx, ey[k]! - my);
    if (d > spread) spread = d;
  }

  return {
    samples,
    spreadMm: spread,
    worstMm: worst,
    meanMm: sum / n,
    dtSec: dt,
    truncated,
  };
}

/**
 * The traced path split into drawn runs, ready to stroke on a canvas.
 *
 * A single polyline through every sample would draw the travel moves too, which is
 * the one thing a preview must never do: it is the difference between "this is what
 * the machine will draw" and "this is where the machine will point".
 */
export function tracedRuns(result: SimResult): Point[][] {
  const runs: Point[][] = [];
  let cur: Point[] | null = null;
  for (const s of result.samples) {
    if (!s.laser) {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = [];
      runs.push(cur);
    }
    cur.push(s.at);
  }
  return runs.filter((r) => r.length > 1);
}
