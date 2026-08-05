import type { AxisPair, MachineProfile, Point } from "../types.js";

/*
 * The two guards the merged planner cannot ship without.
 *
 * Both exist in the shipped tools and both are easy to lose in a port, because
 * neither looks like it is doing anything. They are here, alone in their own module
 * with their own tests, precisely so that a planner written later has to reach for
 * them rather than rediscover them.
 *
 * The failure they prevent is not subtle. It is a job that never advances.
 */

/** Below this a gain is treated as zero rather than divided by. */
export const GAIN_EPSILON = 1e-9;

/**
 * A speed limit derived from a gain, with the divide guarded.
 *
 * INV-80. Where the gain is negligible the axis is not the binding constraint, so
 * the honest answer is "no limit from this axis" and that is `Infinity`, which
 * `Math.min` absorbs harmlessly. Returning `NaN` instead poisons every subsequent
 * `Math.min`, because `Math.min(400, NaN)` is `NaN`, and the poison spreads through
 * the forward sweep, the backward sweep and the timing integration until the whole
 * job is `NaN` and never advances.
 *
 * The shipped servo tool does exactly this:
 *   const k = degPerMm(a, b); return k < 1e-9 ? Infinity : SERVO.slew / k;
 */
export function limitFromGain(limit: number, gain: number): number {
  return gain < GAIN_EPSILON ? Infinity : limit / gain;
}

/**
 * Drop consecutive samples that land on the same commandable position.
 *
 * INV-79. This must run AFTER quantisation and it must compare INTEGER axis values,
 * not millimetre proximity.
 *
 * The reason it is not optional: a path densified at one quantum produces
 * consecutive samples that round to the same axis pair perhaps one time in three on
 * an off-axis stroke. Each of those is a zero length axis segment, and a zero length
 * axis segment is a division by zero in the speed cap.
 *
 * A millimetre-space dedupe does not substitute. The shipped stepper tool dedupes at
 * 0.02 mm in millimetre space AND on integer step equality after rounding, because
 * its quantum is 0.55 mm and the millimetre pass cannot see the collision.
 *
 * The beam gate is preserved across a collapse: two samples at the same position
 * with different gate states are a real pen up or pen down event at one coordinate,
 * which is how a dot is drawn, and collapsing them would delete it.
 */
export interface PlannedPoint {
  axis: AxisPair;
  laser: boolean;
}

export function dedupeQuantised(points: readonly PlannedPoint[]): PlannedPoint[] {
  const out: PlannedPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.axis.a === p.axis.a && last.axis.b === p.axis.b && last.laser === p.laser) {
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * Densify a millimetre segment at the machine's own sampling step, then quantise and
 * dedupe. This is the boundary the planner crosses exactly once: millimetres above
 * it, axis units below it.
 */
export function quantisePath(
  points: readonly Point[],
  laser: readonly boolean[],
  profile: MachineProfile,
  cal?: Parameters<MachineProfile["inverse"]>[1],
): PlannedPoint[] {
  const raw: PlannedPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    raw.push({ axis: profile.quantise(profile.inverse(p, cal)), laser: laser[i] ?? false });
  }
  return dedupeQuantised(raw);
}
