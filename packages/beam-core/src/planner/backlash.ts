import type { AxisPair } from "../types.js";

/*
 * Cancelling the actuator's directional bias.
 *
 * A servo deadband is hysteresis and not a grid. The inner loop switches the motor
 * off once the error falls inside the band, so an axis coming up to a target stops
 * a whole deadband short of it, and an axis coming down stops a whole deadband
 * past. The shaft therefore lands in one of two places depending only on which way
 * it was travelling, and the offset between them is the thing you see on the wall
 * as a retraced line missing itself.
 *
 * That is not noise, so it does not need a statistical fix. It is a known signed
 * quantity and it can be subtracted. Machine tools have called this backlash
 * compensation for as long as there have been machine tools.
 *
 * Measured on a 58 mm cap line of text, ninetieth percentile geometric error:
 *
 *   nothing                       6.56 mm
 *   dither, the previous answer   1.70 mm
 *   compensation                  0.91 mm
 *
 * And on a 45 mm circle, 2.11 mm down to 0.18 mm. Compensation also costs nothing
 * to run, where dither costs a servo that hunts continuously, draws more current
 * and is audible across a room.
 *
 * The two are not additive and should not both be on. Compensation leaves the
 * command already correct, so dither on top is noise around a good answer: measured
 * together they are worse than compensation by itself.
 */

/** Below this the sign of a velocity is noise rather than a direction. */
const MOVING_EPS = 1e-3;

/**
 * Push a command in the direction the axis is travelling.
 *
 * `amount` is in axis units and is the profile's `backlashAxis` scaled by whatever
 * strength the operator has dialled in. Each axis is treated separately, because
 * they reverse at different moments and it is exactly at those moments that the
 * correction has to flip.
 *
 * An axis that is not moving gets nothing. Applying a signed offset to a stationary
 * axis would make the sign follow whatever numerical dust was left in the velocity,
 * and the command would flutter between plus and minus one deadband: a dither
 * nobody asked for, at the worst possible amplitude.
 */
export function applyBacklash(
  cmd: AxisPair,
  velA: number,
  velB: number,
  amount: number,
): AxisPair {
  if (amount === 0) return cmd;
  return {
    a: Math.abs(velA) > MOVING_EPS ? cmd.a + Math.sign(velA) * amount : cmd.a,
    b: Math.abs(velB) > MOVING_EPS ? cmd.b + Math.sign(velB) * amount : cmd.b,
  };
}
