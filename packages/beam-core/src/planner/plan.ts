import type { AxisPair, Calibration, MachineProfile, Point } from "../types.js";
import { dedupeQuantised, limitFromGain, type PlannedPoint } from "./guards.js";
import {
  copyStrokes,
  dedupeChain,
  densifyChain,
  filletChain,
  mergeStrokes,
  optimizePath,
  refineCurves,
  type Stroke,
} from "./path.js";
import {
  ACC_SHARE,
  DEDUPE_EPS_MM,
  DENSE_MM,
  DOT_HOLD_SEC,
  JOINTOL_MM,
  JUNCTION_FLOOR_PULL_IN,
  OPTION_BOUNDS,
  PLAN_DEFAULTS,
  SETTLE_AFTER_MM,
} from "./tuning.js";

/* ============================================================================
   THE MOTION PLANNER

   The first version of this planned each stroke as its own chain, and every chain
   started and ended at rest. For a line of text that is seventeen full stops,
   seventeen dwells and seventeen accelerations, with a travel move between each that
   also decelerated to zero. Every one of those is a visible hesitation, and the ones
   where a glyph's strokes meet at a shared point were stopping for no reason at all.

   So the job is planned as ONE continuous path. Travel is not a different kind of
   motion, it is just a stretch where the beam happens to be off, and it gets the same
   velocity planning as everything else. The pipeline:

     refine     put the curves back that the source threw away
     merge      join strokes that share an endpoint, so a glyph drawn as several
                strokes becomes one chain
     order      nearest neighbour, reversing where it helps
     stitch     lace the whole design into a single point array with a per-segment
                beam flag
     fillet     round every interior corner, including the ones where a travel meets
                a stroke, and never one where the beam gate changes
     limit      per segment: feed or travel speed, capped by what the machine can
                actually slew through this bit of the geometry
     junction   corner speed from a deviation tolerance, floored where the machine
                has a pull-in rate
     profile    one forward and one backward pass over the whole array, so look-ahead
                crosses stroke boundaries
     dwell      insert a rest ONLY before lighting the beam after a long reposition,
                where a real servo would still be ringing

   The result has stops only where the geometry forces one. A line of text that used
   to stop seventeen times now runs as a single continuous move.

   THE PLANNER NEVER LEARNS WHICH MACHINE IT IS DRIVING. There is no microsecond and
   no half step anywhere in this file. Gains come from profile.sensitivity, distance
   in machine units from profile.arcLength, sampling from profile.sampleStepMm, the
   commandable grid from profile.quantise, and the ceilings from profile.limits. That
   is the whole point of MachineProfile and it is worth defending: the moment a unit
   leaks in here, one of the two rigs is being planned for the other one's hardware.
   ============================================================================ */

/* ------------------------------------------------------------------ options -- */

/**
 * What a caller may set. Everything is optional; `resolvePlanOptions` fills the rest
 * in from the machine profile, which is where the per-machine answers live.
 */
export interface PlanOptions {
  /** mm/s while the beam is on. */
  feedMmS?: number | undefined;
  /** mm/s while it is off. */
  travelMmS?: number | undefined;
  /**
   * Drawing rate in AXIS UNITS per second, which is the unit the stepper rig was
   * tuned in. See INV-81: the machine paces its dominant axis, so a diagonal runs at
   * up to root two the linear feed in millimetres per second, deliberately, with no
   * cross axis normalisation. Where both a millimetre feed and an axis rate apply,
   * the planner takes the minimum and neither is converted through the other.
   */
  drawAxisRate?: number | undefined;
  travelAxisRate?: number | undefined;
  accelMmS2?: number | undefined;
  cornerMm?: number | undefined;
  junctionDeviationMm?: number | undefined;
  tolMm?: number | undefined;
  jerkSec?: number | undefined;
  settleMs?: number | undefined;
  settleAfterMm?: number | undefined;
  denseMm?: number | undefined;
  joinTolMm?: number | undefined;
  /**
   * Slowest speed a junction is worth being taken at, in axis units per second.
   * Defaults per profile, and the default is the interesting part: see
   * JUNCTION_FLOOR_PULL_IN. Zero means "decelerate to a genuine stop at a reversal",
   * which is what a servo wants.
   */
  junctionFloorAxisRate?: number | undefined;
  refine?: boolean | undefined;
  merge?: boolean | undefined;
  optimise?: boolean | undefined;
  /** Reversing a stroke is allowed while ordering. Off for a raster, where it shows. */
  allowReverse?: boolean | undefined;
  /** Where the beam parks, and where ordering starts from. */
  origin?: Point | undefined;
  cal?: Calibration | null | undefined;
  /** Live speed override. Scales timeline spans only. See INV-85. */
  speed?: number | undefined;
}

export interface ResolvedPlanOptions {
  readonly feedMmS: number;
  readonly travelMmS: number;
  readonly drawAxisRate: number;
  readonly travelAxisRate: number;
  readonly accelMmS2: number;
  readonly cornerMm: number;
  readonly junctionDeviationMm: number;
  readonly tolMm: number;
  readonly jerkSec: number;
  readonly settleMs: number;
  readonly settleAfterMm: number;
  readonly denseMm: number;
  readonly joinTolMm: number;
  readonly junctionFloorAxisRate: number;
  readonly refine: boolean;
  readonly merge: boolean;
  readonly optimise: boolean;
  readonly allowReverse: boolean;
  readonly origin: Point;
  readonly cal: Calibration | null;
  readonly speed: number;
  /**
   * The hard ceiling, axis units per second: maxRate times derate.
   *
   * This is applied on top of whatever the caller asked for and cannot be raised by
   * an option, because on a machine whose overrun mode is "destroys" the first rate
   * past pull-out is the last one whose geometry is real. A stepper past pull-out
   * loses steps silently: there is no error, no missing packet and no way to detect
   * it from the host, only a drawing that is wrong from that point onward.
   */
  readonly axisRateCeiling: number;
}

const bounded = (v: number, [lo, hi]: readonly [number, number]): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : hi;

export function resolvePlanOptions(
  profile: MachineProfile,
  options: PlanOptions = {},
): ResolvedPlanOptions {
  const ceiling = Math.max(
    OPTION_BOUNDS.axisRate[0],
    profile.limits.maxRate * profile.limits.derate,
  );
  const rate = (v: number | undefined) => Math.min(ceiling, bounded(v ?? ceiling, OPTION_BOUNDS.axisRate));
  return {
    feedMmS: bounded(options.feedMmS ?? PLAN_DEFAULTS.feedMmS, OPTION_BOUNDS.feedMmS),
    travelMmS: bounded(options.travelMmS ?? PLAN_DEFAULTS.travelMmS, OPTION_BOUNDS.feedMmS),
    drawAxisRate: rate(options.drawAxisRate),
    travelAxisRate: rate(options.travelAxisRate),
    accelMmS2: bounded(options.accelMmS2 ?? PLAN_DEFAULTS.accelMmS2, OPTION_BOUNDS.accelMmS2),
    cornerMm: Math.max(0, options.cornerMm ?? PLAN_DEFAULTS.cornerMm),
    junctionDeviationMm: Math.max(
      1e-4,
      options.junctionDeviationMm ?? PLAN_DEFAULTS.junctionDeviationMm,
    ),
    tolMm: bounded(options.tolMm ?? PLAN_DEFAULTS.tolMm, OPTION_BOUNDS.tolMm),
    jerkSec: Math.max(0, options.jerkSec ?? PLAN_DEFAULTS.jerkSec),
    settleMs: Math.max(0, options.settleMs ?? PLAN_DEFAULTS.settleMs),
    settleAfterMm: Math.max(0, options.settleAfterMm ?? SETTLE_AFTER_MM),
    denseMm: bounded(options.denseMm ?? DENSE_MM, OPTION_BOUNDS.denseMm),
    joinTolMm: Math.max(0, options.joinTolMm ?? JOINTOL_MM),
    /*
     * The junction floor is PROFILE SUPPLIED, because the two rigs disagree about
     * what a reversal costs. A machine with a pull-out rate worth hunting for also
     * has a pull-in rate below which slowing down buys nothing; a servo has neither,
     * and arriving at a reversal with speed on is what makes its gear slop knock.
     */
    junctionFloorAxisRate: Math.max(
      0,
      options.junctionFloorAxisRate ?? (profile.caps.pullOut ? JUNCTION_FLOOR_PULL_IN : 0),
    ),
    refine: options.refine ?? true,
    merge: options.merge ?? true,
    optimise: options.optimise ?? true,
    allowReverse: options.allowReverse ?? true,
    origin: options.origin ? { x: options.origin.x, y: options.origin.y } : { x: 0, y: 0 },
    cal: options.cal ?? null,
    speed: Math.max(0.01, Math.min(100, options.speed ?? PLAN_DEFAULTS.speed)),
    axisRateCeiling: ceiling,
  };
}

/* ----------------------------------------------------------------- timeline -- */

/** A stretch of continuous motion with a velocity profile over it. */
export interface ChainMove {
  readonly kind: "chain";
  readonly pts: readonly Point[];
  /** `pen[i]` gates the segment from `pts[i]` to `pts[i + 1]`. Length is pts.length - 1. */
  readonly pen: readonly boolean[];
  /** Cumulative seconds at each vertex, relative to the move's own start. */
  readonly t: Float64Array;
  /** mm/s at each vertex. */
  readonly v: Float64Array;
  readonly t0: number;
  readonly dur: number;
  readonly len: number;
  readonly drawLen: number;
  readonly travLen: number;
  readonly peak: number;
}

/** A rest: a settle before the beam lights, or a lone dot being burned. */
export interface HoldMove {
  readonly kind: "hold";
  readonly at: Point;
  readonly laser: boolean;
  readonly t0: number;
  readonly dur: number;
}

export type Move = ChainMove | HoldMove;

/**
 * One commandable point, with how long the machine should take to leave it.
 *
 * This is what goes on the wire. The axis pair is integral and on the machine's own
 * grid, the gate is the one that holds for the whole span (INV-30), and `durMs` is a
 * whole millisecond with the rounding residual carried forward (INV-29).
 */
export interface PlanPoint {
  readonly axis: AxisPair;
  readonly laser: boolean;
  /** Seconds from the start of the job, unscaled by the speed override. */
  readonly t: number;
  /** Whole milliseconds to the next point, residual corrected and speed scaled. */
  readonly durMs: number;
}

export interface Timeline {
  readonly moves: readonly Move[];
  /** Seconds. Unscaled: the speed override lives in the emitted durations. */
  readonly dur: number;
  readonly drawLen: number;
  readonly travLen: number;
  /** Fastest drawn speed anywhere in the job, mm/s. */
  readonly peak: number;
  /**
   * Every instant the beam changes state, ascending. Exact, never sampled.
   *
   * Timeline seconds, like `dur` and like `sampleAt`, so unscaled by the speed
   * override. A player running at a speed other than 1 divides. The emitted
   * durations in `plan` are the ones that already carry it.
   */
  readonly gates: readonly number[];
  /** The commandable plan: what the machine is actually told to do. */
  readonly plan: readonly PlanPoint[];
  /** Total distance in axis units, from profile.arcLength over the emitted plan. */
  readonly axisLen: number;
  readonly options: ResolvedPlanOptions;
}

/* ------------------------------------------------------- the velocity profile -- */

/**
 * One velocity profile for a whole chain.
 *
 * Everything the machine contributes arrives through the profile:
 *
 *   gain      profile.sensitivity, axis units per millimetre on the busier axis,
 *             evaluated as a secant across this segment and through whatever
 *             calibration is active, so the measured quad participates in the speed
 *             limits and not only in the aiming
 *   ceiling   profile.limits.maxRate times derate, in axis units per second
 *   accel     profile.limits.maxAccel, in axis units per second squared
 *
 * The real limit is angular, not linear. A machine turns so many axis units a second,
 * and because the target map is a tangent relationship the same mm/s costs different
 * axis units per second depending on where you are. Converting the ceiling into an
 * mm/s cap for this specific bit of path is what makes it impossible for the planner
 * to ask for motion the hardware cannot deliver.
 */
export function planChainPen(
  pts: readonly Point[],
  pen: readonly boolean[],
  profile: MachineProfile,
  o: ResolvedPlanOptions,
  forceStop: ReadonlySet<number> | null,
  t0: number,
): ChainMove {
  const n = pts.length;
  if (n < 2) {
    return {
      kind: "chain",
      pts: pts.map((p) => ({ x: p.x, y: p.y })),
      pen: pen.slice(0, Math.max(0, n - 1)),
      t: new Float64Array(n),
      v: new Float64Array(n),
      t0,
      dur: 0,
      len: 0,
      drawLen: 0,
      travLen: 0,
      peak: 0,
    };
  }

  const ds = new Float64Array(n - 1);
  const v = new Float64Array(n);
  let len = 0;
  let drawLen = 0;
  let travLen = 0;

  for (let i = 0; i < n - 1; i++) {
    ds[i] = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
    len += ds[i]!;
    if (pen[i]) drawLen += ds[i]!;
    else travLen += ds[i]!;
  }

  /* Per segment ceilings, all of them from the machine rather than from the target
   * geometry. The gain is cached because sensitivity runs the inverse map twice and
   * the sweeps below read it repeatedly. */
  const gain = new Float64Array(n - 1);
  const cap = new Float64Array(n - 1);
  const acc = new Float64Array(n - 1);
  const floor = new Float64Array(n - 1);
  const accelAxis = profile.limits.maxAccel;
  for (let i = 0; i < n - 1; i++) {
    const k = profile.sensitivity(pts[i]!, pts[i + 1]!, o.cal);
    gain[i] = k;
    /* INV-80. limitFromGain answers Infinity where the gain vanishes, which Math.min
     * absorbs. NaN would poison every cap, both sweeps and the timing integration,
     * and the job would never advance. */
    const vLim = limitFromGain(o.axisRateCeiling, k);
    const aLim = limitFromGain(accelAxis, k);
    /* INV-81. The operator's rate is in the machine's own unit, so it is converted
     * to mm/s here at the local gain and never the other way round. */
    const rateLim = limitFromGain(pen[i] ? o.drawAxisRate : o.travelAxisRate, k);
    cap[i] = Math.min(pen[i] ? o.feedMmS : o.travelMmS, vLim, rateLim);
    acc[i] = Math.min(o.accelMmS2, aLim * ACC_SHARE);
    /*
     * The pull-in floor, clamped to this segment's own cap so a slow segment is never
     * sped up to meet it. Where the gain vanishes limitFromGain answers Infinity and
     * the clamp turns that into the cap, which is the honest reading: a segment with
     * no axis motion has no pull-in constraint to satisfy.
     */
    floor[i] =
      o.junctionFloorAxisRate > 0
        ? Math.min(cap[i]!, limitFromGain(o.junctionFloorAxisRate, k))
        : 0;
  }

  /* A vertex can be no faster than either segment touching it. */
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? cap[i - 1]! : Infinity;
    const b = i < n - 1 ? cap[i]! : Infinity;
    v[i] = Math.min(a, b);
  }

  /*
   * Sustained curvature, which junction deviation alone does not catch.
   *
   * A filleted corner or a round letter is an arc made of many small segments, and
   * each individual turn is gentle enough that the junction rule waves it through.
   * Followed at speed, though, that arc demands a continuous centripetal acceleration
   * of v squared over the radius, every millimetre of the way round. On a 9g servo
   * that is what turns an O into a wobble. Limit the speed so the arc costs no more
   * axis acceleration than the machine has to give.
   */
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    if (ab < 1e-9 || bc < 1e-9 || ca < 1e-9) continue;
    const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (cross < 1e-12) continue; // straight, no curvature
    const R = (ab * bc * ca) / (2 * cross); // circumradius
    const k = profile.sensitivity(a, c, o.cal) || gain[i - 1]!;
    if (!(k > 1e-9)) continue;
    const vc = Math.sqrt((accelAxis * ACC_SHARE * R) / k);
    if (vc < v[i]!) v[i] = vc;
  }

  /* Junction deviation: how fast may the beam round this corner while straying no
   * more than jd millimetres from the programmed vertex. */
  for (let i = 1; i < n - 1; i++) {
    const d1x = pts[i]!.x - pts[i - 1]!.x;
    const d1y = pts[i]!.y - pts[i - 1]!.y;
    const d2x = pts[i + 1]!.x - pts[i]!.x;
    const d2y = pts[i + 1]!.y - pts[i]!.y;
    const l1 = Math.hypot(d1x, d1y);
    const l2 = Math.hypot(d2x, d2y);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const cosT = Math.max(-1, Math.min(1, -(d1x * d2x + d1y * d2y) / (l1 * l2)));
    const sinH = Math.sqrt(0.5 * (1 - cosT));
    if (sinH > 0.9999) continue; // dead straight
    const vj = Math.sqrt((o.accelMmS2 * o.junctionDeviationMm * sinH) / (1 - sinH));
    if (vj < v[i]!) v[i] = vj;
  }

  /*
   * The floor, applied after every limit that can drive a vertex toward zero.
   *
   * On a servo this is a no-op, because the floor is zero and a reversal really does
   * want a full stop. On a stepper it is what stops the planner spending time it
   * cannot spend usefully: below the pull-in rate the motor is already in the regime
   * where a step either lands or does not, and going slower buys no accuracy.
   */
  const floorAt = (i: number): number => {
    const a = i > 0 ? floor[i - 1]! : Infinity;
    const b = i < n - 1 ? floor[i]! : Infinity;
    return Math.min(a, b);
  };
  if (o.junctionFloorAxisRate > 0) {
    for (let i = 1; i < n - 1; i++) v[i] = Math.max(v[i]!, floorAt(i));
  }
  v[0] = floorAt(0);
  v[n - 1] = Math.min(v[n - 1]!, floorAt(n - 1));
  if (forceStop) for (const i of forceStop) if (i > 0 && i < n - 1) v[i] = 0;

  const sweep = () => {
    for (let i = n - 2; i >= 0; i--) {
      /* Can we still stop. */
      const m = Math.sqrt(v[i + 1]! * v[i + 1]! + 2 * acc[i]! * ds[i]!);
      if (m < v[i]!) v[i] = m;
    }
    for (let i = 1; i < n; i++) {
      /* Can we get up to it. */
      const m = Math.sqrt(v[i - 1]! * v[i - 1]! + 2 * acc[i - 1]! * ds[i - 1]!);
      if (m < v[i]!) v[i] = m;
    }
  };
  sweep();

  /*
   * Jerk smoothing.
   *
   * The profile above is trapezoidal, which means acceleration steps from zero to its
   * limit instantly at every transition. A galvo does not care. A 9g servo has gear
   * backlash, and an instant acceleration step takes up that slack with a knock you
   * can hear and see as a wobble at the start of every stroke.
   *
   * Rather than build a full jerk limited planner, round the corners of the velocity
   * profile itself: take a running average over a window and keep whichever is lower.
   * That only ever reduces speed, so the result cannot become infeasible, and
   * re-running the accel sweep afterwards restores the limits exactly.
   *
   * The window is the distance covered during the jerk time, so the smoothing lasts
   * the same wall clock duration however fast the job is running.
   */
  if (o.jerkSec > 0 && n > 8) {
    const win = Math.max(2, Math.min(40, Math.round(((o.jerkSec * o.feedMmS) / o.denseMm) * 0.5)));
    const env = Float64Array.from(v);
    const ps = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) ps[i + 1] = ps[i]! + env[i]!;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - win);
      const b = Math.min(n - 1, i + win);
      const avg = (ps[b + 1]! - ps[a]!) / (b - a + 1);
      if (avg < v[i]!) v[i] = avg; // only ever slower, so never infeasible
    }
    if (o.junctionFloorAxisRate > 0) {
      for (let i = 1; i < n - 1; i++) v[i] = Math.max(v[i]!, floorAt(i));
    }
    v[0] = floorAt(0);
    v[n - 1] = Math.min(v[n - 1]!, floorAt(n - 1));
    if (forceStop) for (const i of forceStop) if (i > 0 && i < n - 1) v[i] = 0;
    sweep(); // restore the acceleration limits exactly
  }

  const t = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n - 1; i++) {
    const vs = v[i]! + v[i + 1]!;
    t[i + 1] = t[i]! + (vs > 1e-9 ? (2 * ds[i]!) / vs : 0);
    if (pen[i] && v[i]! > peak) peak = v[i]!;
  }

  return {
    kind: "chain",
    pts: pts.map((p) => ({ x: p.x, y: p.y })),
    pen: pen.slice(0, n - 1),
    t,
    v,
    t0,
    dur: t[n - 1]!,
    len,
    drawLen,
    travLen,
    peak,
  };
}

/* --------------------------------------------------------------- the gates -- */

/**
 * Every instant the beam changes state, worked out from the timeline itself rather
 * than by sampling it.
 *
 * SAMPLING WAS THE BUG, and it is worth stating plainly because the sampled version
 * looks right and is cheaper. The emitter used to decide whether a segment spanned a
 * gate change by comparing the state at its two ends, and a stroke shorter than the
 * segment it sat inside reads the same at both: off before, off after, with the whole
 * stroke invisible in between. The full stop in a line of text is exactly that
 * stroke. It survived only because a separate check happened to sample the middle,
 * which put the beam eight milliseconds from where it belonged instead of losing it
 * altogether.
 *
 * The transitions are known exactly, so there is no reason to go looking.
 */
export function gateTable(moves: readonly Move[]): number[] {
  const gates: number[] = [];
  let prev: boolean | null = null;
  for (const m of moves) {
    if (m.kind === "hold") {
      if (prev !== null && m.laser !== prev) gates.push(m.t0);
      prev = m.laser;
    } else {
      for (let i = 0; i < m.pen.length; i++) {
        const s = m.pen[i]!;
        if (prev !== null && s !== prev) gates.push(m.t0 + m.t[i]!);
        prev = s;
      }
    }
  }
  return gates;
}

/** The first gate strictly after t, or Infinity. Binary search. */
export function nextGate(tl: Timeline, t: number): number {
  const g = tl.gates;
  if (!g.length) return Infinity;
  let lo = 0;
  let hi = g.length - 1;
  let ans = Infinity;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (g[m]! > t + 1e-9) {
      ans = g[m]!;
      hi = m - 1;
    } else {
      lo = m + 1;
    }
  }
  return ans;
}

/* -------------------------------------------------------------- the emitter -- */

/**
 * Cross the boundary from millimetres to axis units exactly once, here.
 *
 * This is planner/guards.ts quantisePath with the index kept, because the timeline
 * needs to know WHEN each surviving point happens and quantisePath answers only what
 * survives. The dedupe itself is the guard, unmodified: INV-79, integer axis
 * equality, after rounding, with a gate change at one position preserved because that
 * is how a dot is drawn.
 *
 * INV-29: durations carry a residual across points so millisecond rounding never
 * accumulates. Rounding each one independently lost up to half a millisecond a time,
 * and across several hundred points that random walk put the beam gate as much as 15
 * ms from where the plan wanted it.
 *
 * INV-85: the speed override divides the span. Getting the division the wrong way
 * round turns the speed slider into a tempo bug.
 */
function emitPlan(
  moves: readonly Move[],
  dur: number,
  profile: MachineProfile,
  o: ResolvedPlanOptions,
): PlanPoint[] {
  const pts: Point[] = [];
  const gate: boolean[] = [];
  const at: number[] = [];
  for (const m of moves) {
    if (m.kind === "hold") {
      pts.push(m.at);
      gate.push(m.laser);
      at.push(m.t0);
      continue;
    }
    for (let i = 0; i < m.pts.length; i++) {
      pts.push(m.pts[i]!);
      /* INV-30: the gate a segment carries is the one at its start, held for the
       * segment's whole duration. The final vertex has no segment of its own, so it
       * keeps the last one's state rather than inventing one. */
      gate.push(i < m.pen.length ? m.pen[i]! : (m.pen[m.pen.length - 1] ?? false));
      at.push(m.t0 + m.t[i]!);
    }
  }

  const raw: PlannedPoint[] = pts.map((p, i) => ({
    axis: profile.quantise(profile.inverse(p, o.cal)),
    laser: gate[i]!,
  }));
  const kept = dedupeQuantised(raw);

  /* Recover the time of each surviving point. `kept` is a subsequence of `raw` in
   * order, and a point is kept exactly when it differs from the last kept one, so the
   * first raw match after the previous match is the point that was kept. */
  const keptAt: number[] = [];
  let j = 0;
  for (let i = 0; i < raw.length && j < kept.length; i++) {
    const r = raw[i]!;
    const k = kept[j]!;
    if (r.axis.a === k.axis.a && r.axis.b === k.axis.b && r.laser === k.laser) {
      keptAt.push(at[i]!);
      j++;
    }
  }

  const out: PlanPoint[] = [];
  let residual = 0;
  for (let i = 0; i < kept.length; i++) {
    const start = keptAt[i]!;
    const end = i + 1 < kept.length ? keptAt[i + 1]! : dur;
    const exact = ((end - start) * 1000) / o.speed + residual;
    const ms = Math.max(0, Math.round(exact));
    residual = exact - ms;
    out.push({ axis: kept[i]!.axis, laser: kept[i]!.laser, t: start, durMs: ms });
  }
  return out;
}

/* ------------------------------------------------------------ the stitching -- */

/**
 * Lace the design into one path and give it a velocity profile.
 *
 * Beam-off runs between strokes become part of the same path, which is what lets the
 * profile look ahead across a stroke boundary instead of stopping at every one. A
 * dwell is inserted only where the beam is about to light after a real reposition.
 */
export function buildTimeline(
  strokes: readonly Stroke[],
  profile: MachineProfile,
  o: ResolvedPlanOptions,
): Timeline {
  const segsPts: Point[] = [];
  const segsPen: boolean[] = [];
  const dwellAt: number[] = [];
  const dots: Point[] = [];
  let cur: Point = { x: o.origin.x, y: o.origin.y };
  let started = false;

  segsPts.push({ x: cur.x, y: cur.y });
  for (const s of strokes) {
    if (!s.length) continue;
    if (s.length === 1) {
      dots.push({ x: s[0]!.x, y: s[0]!.y });
      continue;
    }
    const start = s[0]!;
    const gap = Math.hypot(start.x - cur.x, start.y - cur.y);
    if (gap > 1e-6) {
      /* A gap narrower than the join tolerance is not a reposition, it is two strokes
       * that meet. Drawing across it costs a third of a millimetre and saves gating
       * the beam off and on for nothing. */
      segsPts.push({ x: start.x, y: start.y });
      segsPen.push(started && gap <= o.joinTolMm);
    }
    if (o.settleMs > 0 && gap > o.settleAfterMm) dwellAt.push(segsPts.length - 1);
    for (let i = 1; i < s.length; i++) {
      segsPts.push({ x: s[i]!.x, y: s[i]!.y });
      segsPen.push(true);
    }
    started = true;
    cur = s[s.length - 1]!;
  }

  if (segsPen.length === 0) {
    /* Nothing but dots, or nothing at all. */
    const moves: Move[] = [];
    let total = 0;
    for (const d of dots) {
      moves.push({ kind: "hold", at: d, laser: true, dur: DOT_HOLD_SEC, t0: total });
      total += DOT_HOLD_SEC;
    }
    return finish(moves, total, 0, 0, 0, profile, o);
  }

  /* Round the corners, then resample. Corners where the beam changes state are
   * preserved as hard vertices by filletChain. */
  const clean = dedupeChain(segsPts, segsPen, DEDUPE_EPS_MM);
  const f = filletChain(clean.pts, clean.pen, o.cornerMm);
  const d = densifyChain(f.pts, f.pen, (a) =>
    Math.min(o.denseMm, profile.sampleStepMm(a, o.cal)),
  );

  /* Map the dwell vertices onto the resampled path by position. */
  const stops: number[] = [];
  for (const vi of dwellAt) {
    const p = segsPts[vi];
    if (!p) continue;
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < d.pts.length; i++) {
      const dd = Math.hypot(d.pts[i]!.x - p.x, d.pts[i]!.y - p.y);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    if (best > 0 && bd < 1e-3) stops.push(best);
  }

  /* Split the chain at each dwell so the rest is a real pause in the timeline. */
  const cuts = [...new Set(stops)].sort((a, b) => a - b);
  const moves: Move[] = [];
  let total = 0;
  let drawLen = 0;
  let travLen = 0;
  let peak = 0;
  const emit = (from: number, to: number) => {
    if (to - from < 1) return;
    const m = planChainPen(d.pts.slice(from, to + 1), d.pen.slice(from, to), profile, o, null, total);
    total += m.dur;
    drawLen += m.drawLen;
    travLen += m.travLen;
    if (m.peak > peak) peak = m.peak;
    moves.push(m);
  };
  let from = 0;
  for (const c of cuts) {
    emit(from, c);
    moves.push({
      kind: "hold",
      at: d.pts[c]!,
      dur: o.settleMs / 1000,
      laser: false,
      t0: total,
    });
    total += o.settleMs / 1000;
    from = c;
  }
  emit(from, d.pts.length - 1);

  for (const dot of dots) {
    moves.push({ kind: "hold", at: dot, laser: true, dur: DOT_HOLD_SEC, t0: total });
    total += DOT_HOLD_SEC;
  }

  return finish(moves, total, drawLen, travLen, peak, profile, o);
}

function finish(
  moves: readonly Move[],
  dur: number,
  drawLen: number,
  travLen: number,
  peak: number,
  profile: MachineProfile,
  o: ResolvedPlanOptions,
): Timeline {
  const plan = emitPlan(moves, dur, profile, o);
  let axisLen = 0;
  for (let i = 1; i < plan.length; i++) {
    axisLen += profile.arcLength(plan[i - 1]!.axis, plan[i]!.axis);
  }
  return {
    moves,
    dur,
    drawLen,
    travLen,
    peak,
    gates: gateTable(moves),
    plan,
    axisLen,
    options: o,
  };
}

/* ------------------------------------------------------------------- public -- */

/**
 * Plan a job.
 *
 * Strokes are in target millimetres, y up, origin at the field centre. A stroke of
 * one point is a dot and is burned as a hold at the end of the job; everything else
 * is a path.
 */
export function planJob(
  strokes: readonly Stroke[],
  profile: MachineProfile,
  options: PlanOptions = {},
): Timeline {
  const o = resolvePlanOptions(profile, options);
  const dots = strokes.filter((s) => s.length === 1).map((s) => [{ x: s[0]!.x, y: s[0]!.y }]);
  let paths: Point[][] = copyStrokes(strokes.filter((s) => s.length >= 2));
  /* Refinement happens first, in target millimetres, so it means what it says
   * regardless of how the design was scaled, and before merging so a join between two
   * strokes stays the corner it usually is. */
  if (o.refine) paths = refineCurves(paths, o.tolMm);
  if (o.merge) paths = mergeStrokes(paths, o.joinTolMm);
  if (o.optimise) paths = optimizePath(paths, o.origin, o.allowReverse);
  return buildTimeline([...paths, ...dots], profile, o);
}

export interface Sample {
  readonly at: Point;
  readonly laser: boolean;
  /** mm/s. */
  readonly v: number;
}

/** Where the plan says the beam is at time t. Binary search, twice. */
export function sampleAt(tl: Timeline, t: number): Sample {
  const mv = tl.moves;
  if (!mv.length) return { at: { x: 0, y: 0 }, laser: false, v: 0 };
  let lo = 0;
  let hi = mv.length - 1;
  let k = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (mv[m]!.t0 <= t) {
      k = m;
      lo = m + 1;
    } else {
      hi = m - 1;
    }
  }
  const m = mv[k]!;
  if (m.kind === "hold") return { at: { x: m.at.x, y: m.at.y }, laser: m.laser, v: 0 };

  const lt = t - m.t0;
  const ts = m.t;
  let a = 0;
  let b = ts.length - 1;
  let i = 0;
  while (a <= b) {
    const c = (a + b) >> 1;
    if (ts[c]! <= lt) {
      i = c;
      a = c + 1;
    } else {
      b = c - 1;
    }
  }
  if (i >= ts.length - 1) {
    const p = m.pts[ts.length - 1]!;
    return {
      at: { x: p.x, y: p.y },
      laser: m.pen[m.pen.length - 1] ?? false,
      v: 0,
    };
  }
  const span = ts[i + 1]! - ts[i]!;
  const f = span > 1e-12 ? (lt - ts[i]!) / span : 0;
  const p0 = m.pts[i]!;
  const p1 = m.pts[i + 1]!;
  return {
    at: { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f },
    laser: m.pen[i] ?? false,
    v: m.v[i]! + (m.v[i + 1]! - m.v[i]!) * f,
  };
}
