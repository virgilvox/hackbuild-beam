import type { AxisPair, Calibration, MachineProfile } from "../types.js";
import { sampleAt, type Timeline } from "./plan.js";
import { applyBacklash } from "./backlash.js";

/*
 * Turning a plan into what actually goes on the wire.
 *
 * This is the half that was missing, and it is the half that decides whether a
 * servo rig draws a line or a staircase. The planner produces a continuous timeline
 * that tracks the strokes to a fraction of a millimetre. Sending that as a stream of
 * raw positions throws almost all of it away: the board receives points with no
 * velocity, its cubic collapses to a chord between each pair, and every acceleration
 * ramp the planner computed becomes a sequence of straight lurches.
 *
 * The board is not a position follower. It plays each segment from its ACTUAL
 * position and ACTUAL velocity to the endpoint pair it was given, so position and
 * velocity are both continuous across every boundary. Feed it endpoint velocities
 * and a whole acceleration phase fits in one segment. Feed it bare positions and you
 * are asking a cubic interpolator to reproduce a curve using only its endpoints.
 *
 * So spans here run long on purpose, up to 150 ms, and they are chosen by measuring
 * the error of the curve the board will really play rather than by a clock.
 */

export interface EmitOptions {
  cal?: Calibration | null | undefined;
  /** Board negotiated the hermite format. Without it, velocities are not sent. */
  hermite?: boolean | undefined;
  /** Millimetres on the target. The same tolerance that flattens curves. */
  tolMm?: number | undefined;
  /** Live speed override. Scales the timeline, never the wire duration. */
  speed?: number | undefined;
  /**
   * Axis units of directional compensation baked into the emitted positions.
   *
   * Done here rather than in the firmware so it works against a board that has not
   * been reflashed, which is most of them. The cost of doing it here is that the
   * board interpolates between endpoints, so a correction that flips inside a
   * segment is smoothed across it instead of switching cleanly. In practice a
   * velocity reversal is a curvature event and the fitter has already split there,
   * so the endpoints land close to where the flip belongs.
   */
  backlash?: number | undefined;
}

/** One segment as it will go on the wire, in this machine's own axis units. */
export interface EmittedSegment {
  a: number;
  b: number;
  laser: boolean;
  durMs: number;
  /** Arrival velocity, sixteenths of an axis unit per millisecond. Hermite only. */
  velA: number;
  velB: number;
}

export interface EmitResult {
  segments: EmittedSegment[];
  /** Segments merged into a neighbour because they were a dwell on the same pair. */
  merged: number;
  /** Worst playback error accepted, millimetres. The honest quality number. */
  worstMm: number;
}

/*
 * Span caps, straight from the bench.
 *
 * Hermite spans run long because the cubic reproduces the planner's ramps exactly,
 * so a whole acceleration phase fits in one segment and the split points fall only
 * where the path genuinely curves or a gate changes. Legacy spans are short because
 * a chord is all the board can draw.
 *
 * The distance cap is not about accuracy, it is about loss: a long merged segment
 * that goes missing leaves the board interpolating straight from one side of an arc
 * to the other, so the cap bounds how much geometry any single packet carries.
 */
const SPAN_MAX_MS_HERMITE = 150;
const SPAN_MAX_MS_LEGACY = 60;
const SPAN_MIN_MS = 8;
const MERGE_MAX_MS_HERMITE = 200;
const MERGE_MAX_MS_LEGACY = 90;
const FIT_ROUNDS = 8;

/** Velocity resolution on the wire: int8 in sixteenths of an axis unit per ms. */
const VEL_SCALE = 16;
const VEL_LIMIT = 127;

/** Centred difference. Exact for the constant acceleration ramps the planner emits. */
const VEL_EPS_SEC = 0.004;

function axisAt(tl: Timeline, t: number, profile: MachineProfile, cal: Calibration | null | undefined): AxisPair {
  return profile.inverse(sampleAt(tl, Math.min(tl.dur, Math.max(0, t))).at, cal);
}

/** Axis velocity at an instant, in axis units per millisecond. */
function axisVelAt(
  tl: Timeline,
  t: number,
  profile: MachineProfile,
  cal: Calibration | null | undefined,
): { a: number; b: number } {
  const lo = Math.max(0, t - VEL_EPS_SEC);
  const hi = Math.min(tl.dur, t + VEL_EPS_SEC);
  const span = hi - lo;
  if (span < 1e-9) return { a: 0, b: 0 };
  const p0 = axisAt(tl, lo, profile, cal);
  const p1 = axisAt(tl, hi, profile, cal);
  /* Per millisecond, because that is the unit the wire carries. */
  return { a: (p1.a - p0.a) / (span * 1000), b: (p1.b - p0.b) / (span * 1000) };
}

/** The first gate strictly after t, or Infinity. Gates are exact, never sampled. */
function nextGate(tl: Timeline, t: number): number {
  let lo = 0;
  let hi = tl.gates.length - 1;
  let found = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const g = tl.gates[mid]!;
    if (g > t + 1e-9) {
      found = g;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

/* Cubic Hermite basis. The board evaluates exactly this, so the fit must too. */
function hermite(p0: number, p1: number, v0: number, v1: number, durMs: number, T: number): number {
  const h00 = (2 * T - 3) * T * T + 1;
  const h10 = ((T - 2) * T + 1) * T;
  const h01 = (3 - 2 * T) * T * T;
  const h11 = (T - 1) * T * T;
  return h00 * p0 + h10 * durMs * v0 + h01 * p1 + h11 * durMs * v1;
}

/**
 * How far the curve the board will actually play departs from the plan, in target
 * millimetres, sampled in time at three interior instants.
 *
 * Time sampled and not spatial, because a spatial metric is blind to the thing that
 * matters most. A segment lying along a straight stroke measures zero spatial error
 * no matter how the speed varies inside it, so an acceleration ramp gets flattened
 * to one constant velocity and the lurch at every stroke start is approved by the
 * very check meant to prevent it.
 *
 * Evaluated with the QUANTISED velocities, because those are what ship. Scoring the
 * unrounded ones would approve a segment the board cannot reproduce.
 *
 * Returns Infinity on any gate mismatch, which forces a split: the board holds one
 * beam state for a whole segment, so a segment must never straddle a gate change.
 */
function playbackError(
  tl: Timeline,
  t0: number,
  t1: number,
  from: AxisPair,
  to: AxisPair,
  v0: { a: number; b: number },
  v1: { a: number; b: number },
  profile: MachineProfile,
  cal: Calibration | null | undefined,
  speed: number,
): number {
  const laser = sampleAt(tl, t0).laser;
  if (sampleAt(tl, t1).laser !== laser) return Infinity;

  const durMs = ((t1 - t0) * 1000) / speed;
  if (durMs <= 0) return 0;

  let worst = 0;
  for (const T of [0.25, 0.5, 0.75]) {
    const at = sampleAt(tl, t0 + (t1 - t0) * T);
    if (at.laser !== laser) return Infinity;
    const a = hermite(from.a, to.a, v0.a, v1.a, durMs, T);
    const b = hermite(from.b, to.b, v0.b, v1.b, durMs, T);
    const played = profile.forward({ a, b }, cal);
    const d = Math.hypot(played.x - at.at.x, played.y - at.at.y);
    if (d > worst) worst = d;
  }
  return worst;
}

function quantiseVel(v: number): number {
  return Math.max(-VEL_LIMIT, Math.min(VEL_LIMIT, Math.round(v * VEL_SCALE)));
}

/**
 * Emit a timeline as wire segments.
 *
 * The loop is a fit, not a clock. Each span starts as long as the caps allow, then
 * halves until the curve the board will play is inside tolerance, which means a
 * straight run costs one long segment and a tight corner costs several short ones.
 * That is the whole point: detail is spent where the path actually needs it.
 */
export function emitSegments(
  tl: Timeline,
  profile: MachineProfile,
  options: EmitOptions = {},
): EmitResult {
  const cal = options.cal ?? null;
  const herm = options.hermite ?? false;
  const tolMm = options.tolMm ?? 0.05;
  const speed = Math.max(0.05, options.speed ?? 1);
  const backlash = options.backlash ?? 0;

  const spanMaxMs = herm ? SPAN_MAX_MS_HERMITE : SPAN_MAX_MS_LEGACY;
  const mergeMaxMs = herm ? MERGE_MAX_MS_HERMITE : MERGE_MAX_MS_LEGACY;
  /* Distance cap in axis units, from the machine's own range rather than a
   * millimetre constant, so it means the same thing on both rigs. */
  const spanMaxAxis = Math.max(1, (profile.axis.a.max - profile.axis.a.min) * (herm ? 0.08 : 0.01));

  const out: EmittedSegment[] = [];
  let merged = 0;
  let worstMm = 0;

  /*
   * Durations go on the wire as whole milliseconds, but segments do not land on
   * whole milliseconds: they end where the tolerance or a gate change says. Rounding
   * each one independently loses up to half a millisecond a time, and across several
   * hundred segments that random walk puts the beam gate as much as fifteen
   * milliseconds from where the plan wanted it. Carry the residual.
   */
  let residual = 0;

  let t = 0;
  let vPrev = { a: 0, b: 0 };

  let guard = 0;
  while (t < tl.dur && guard++ < 100_000) {
    const from = axisAt(tl, t, profile, cal);

    let maxSpan = Math.min((spanMaxMs / 1000) * speed, tl.dur - t);
    /* A segment may never straddle a gate change, so clamp to the next one. */
    const gate = nextGate(tl, t);
    if (gate < t + maxSpan) maxSpan = Math.max(gate - t, 1e-6);
    const minSpan = Math.min((SPAN_MIN_MS / 1000) * speed, maxSpan);

    let span = maxSpan;
    let to = axisAt(tl, t + span, profile, cal);
    let vEnd = herm ? axisVelAt(tl, t + span, profile, cal) : { a: 0, b: 0 };
    let err = 0;

    for (let round = 0; round < FIT_ROUNDS; round++) {
      const durMs = ((span * 1000) / speed) || 1;
      /* Legacy playback has no velocities, so the board uses chord tangents at both
       * ends and the cubic collapses to exactly the straight line an old sender
       * expects. Score that, not a curve it will never draw. */
      const v0 = herm
        ? { a: quantiseVel(vPrev.a) / VEL_SCALE, b: quantiseVel(vPrev.b) / VEL_SCALE }
        : { a: (to.a - from.a) / durMs, b: (to.b - from.b) / durMs };
      const v1 = herm
        ? { a: quantiseVel(vEnd.a) / VEL_SCALE, b: quantiseVel(vEnd.b) / VEL_SCALE }
        : v0;

      err = playbackError(tl, t, t + span, from, to, v0, v1, profile, cal, speed);
      const reach = Math.max(Math.abs(to.a - from.a), Math.abs(to.b - from.b));

      if ((err <= tolMm && reach <= spanMaxAxis) || span <= minSpan) break;

      span = Math.max(minSpan, span / 2);
      to = axisAt(tl, t + span, profile, cal);
      if (herm) vEnd = axisVelAt(tl, t + span, profile, cal);
    }

    if (Number.isFinite(err)) worstMm = Math.max(worstMm, err);

    const exactMs = ((span * 1000) / speed) + residual;
    const durMs = Math.max(1, Math.round(exactMs));
    residual = exactMs - durMs;

    /* The gate a segment carries is the one at its START, and the board holds it for
     * the segment's whole duration. */
    const laser = sampleAt(tl, t).laser;
    /*
     * Compensation goes on before quantising, so the correction survives the round
     * to a commandable value rather than being thrown away by it. Applied from the
     * ARRIVAL velocity, because the endpoint is where the axis will actually be
     * when the board lands on this pair.
     */
    /*
     * Direction from the arrival velocity when there is one, and from the chord
     * otherwise. Legacy segments carry no velocity, so reading the sign off vEnd
     * alone would silently disable compensation on exactly the older boards that
     * cannot apply it themselves.
     */
    const dirA = herm ? vEnd.a : to.a - from.a;
    const dirB = herm ? vEnd.b : to.b - from.b;
    const q = profile.quantise(applyBacklash(to, dirA, dirB, backlash));
    const velA = herm ? quantiseVel(vEnd.a) : 0;
    const velB = herm ? quantiseVel(vEnd.b) : 0;

    /*
     * A segment landing on the same commandable pair as the last one is not a new
     * instruction, it is more time on the current one. During a corner, where the
     * beam is barely moving, many ticks collapse into one. The timeline is preserved
     * exactly because the durations add. With velocities in play only true dwells
     * merge, because a moving segment carries a tangent that must not be discarded.
     */
    const last = out[out.length - 1];
    if (
      last &&
      last.a === q.a &&
      last.b === q.b &&
      last.laser === laser &&
      (velA | velB | last.velA | last.velB) === 0 &&
      last.durMs + durMs <= mergeMaxMs
    ) {
      last.durMs += durMs;
      merged++;
    } else {
      out.push({ a: q.a, b: q.b, laser, durMs, velA, velB });
    }

    /* The board departs the next segment from the velocity it really has, so the
     * client's chain state must track the QUANTISED value it was sent, not the
     * unrounded one it computed. */
    vPrev = herm ? { a: velA / VEL_SCALE, b: velB / VEL_SCALE } : { a: 0, b: 0 };
    t += span;
  }

  return { segments: out, merged, worstMm };
}
