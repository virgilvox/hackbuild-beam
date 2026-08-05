import type { GimbalGeometry, Point } from "../types.js";

/*
 * One gimbal model, two machines.
 *
 * This file is the load bearing claim of the whole repo, so the derivation is
 * written out rather than asserted.
 *
 * WASHER, a servo pan/tilt head, computes its aim like this (laser-rig.html ik):
 *
 *     pan  = atan2(wx, D)
 *     tilt = atan2(wy + vOff, hypot(wx, D))
 *
 * The second rotation uses hypot(wx, D) and not D, and the comment records why:
 * the beam has already been swung out by pan, so the horizontal run to the target
 * plane is the hypotenuse, not the throw.
 *
 * DETENT, a two mirror scanner, computes its aim like this (detent-plot.html
 * mmToUV), working in (u, v) = (tan 2thetaX, tan 2thetaY):
 *
 *     a = atan2(x, throw + sep)
 *     u = tan(a)
 *     v = y * cos(a) / throw
 *
 * Put WASHER into tangent form and the two line up exactly:
 *
 *     tan(pan)  = wx / D                                    since tan(atan2(k, D)) = k / D
 *     tan(tilt) = (wy + vOff) / hypot(wx, D)
 *               = (wy + vOff) * cos(pan) / D                since cos(pan) = D / hypot(wx, D)
 *
 * and DETENT's u expands the same way:
 *
 *     u = tan(atan2(x, throw + sep)) = x / (throw + sep)
 *
 * So both are: one yaw about a first axis, then one lift of the already swung ray
 * onto a plane, with the same cos() slant correction coupling the second axis to
 * the first. WASHER is this model with sep = 0, because a pan/tilt head rotates
 * about one point. DETENT is this model with vOff = 0, because its beam axis
 * already passes through the field centre.
 *
 * Neither rig loses anything to the shared form. What is genuinely different sits
 * below this file: converting an axis angle into that axis's own unit, which is
 * one factor (a mirror doubles the beam angle, a servo horn does not) and one
 * linear map. That lives in the profiles.
 *
 * The (u, v) tangent space matters for a second reason: in it the ideal model is
 * near-linear in target millimetres, which is exactly what lets a four corner
 * homography absorb real world error. Rotation, keystone from an off axis mount, a
 * wrong throw estimate, mirrors not quite square: all of it is a projective
 * distortion in tangent space and almost none of it is in angle space.
 */

/** Tangent-space coordinates, (tan theta1, tan theta2). */
export interface UV {
  u: number;
  v: number;
}

/** Axis angles in radians: theta1 is the first rotation, theta2 the second. */
export interface Angles {
  t1: number;
  t2: number;
}

/**
 * A throw shorter than this is refused rather than divided by. The washer app
 * floors the throw at 40 mm for the same reason: past that the geometry bends so
 * hard at the edges that the corners are unreachable anyway, and the tangents
 * blow up before the user notices the rig is too close.
 */
export const MIN_THROW_MM = 40;

/** Target millimetres to tangent space. Exact for both rigs. */
export function mmToUV(p: Point, g: GimbalGeometry): UV {
  const throwMm = Math.max(g.throwMm, MIN_THROW_MM);
  const first = throwMm + g.sepMm;

  const u = p.x / first;
  /*
   * cos(theta1) from u directly rather than through atan then cos. Same value,
   * one transcendental call instead of two, and it stays exact at u = 0.
   */
  const cosT1 = 1 / Math.sqrt(1 + u * u);
  const v = ((p.y + g.vOffMm) * cosT1) / throwMm;

  return { u, v };
}

/** Tangent space back to target millimetres. The exact inverse of mmToUV. */
export function uvToMm(uv: UV, g: GimbalGeometry): Point {
  const throwMm = Math.max(g.throwMm, MIN_THROW_MM);
  const first = throwMm + g.sepMm;

  const x = first * uv.u;
  const cosT1 = 1 / Math.sqrt(1 + uv.u * uv.u);
  const y = (throwMm * uv.v) / cosT1 - g.vOffMm;

  return { x, y };
}

/**
 * Angles are just the arctangent of tangent space. Kept as named functions
 * because the profiles think in angles and the calibration thinks in tangents,
 * and mixing the two silently is how a map ends up applied twice.
 */
export function uvToAngles(uv: UV): Angles {
  return { t1: Math.atan(uv.u), t2: Math.atan(uv.v) };
}

export function anglesToUV(a: Angles): UV {
  return { u: Math.tan(a.t1), v: Math.tan(a.t2) };
}

export function mmToAngles(p: Point, g: GimbalGeometry): Angles {
  return uvToAngles(mmToUV(p, g));
}

export function anglesToMm(a: Angles, g: GimbalGeometry): Point {
  return uvToMm(anglesToUV(a), g);
}

/**
 * How much of each axis's angular travel the current geometry actually demands to
 * cover a field, in degrees.
 *
 * Short throws buy a big image from a small rig but eat angular range fast. On the
 * servo rig, past 180 degrees of demanded sweep the corners are simply unreachable
 * and the only fixes are backing the rig away or capturing four corners and
 * letting the calibration sort it out. On the stepper rig the same number tells
 * you how wide the case aperture has to be.
 */
export function sweepDeg(
  fieldW: number,
  fieldH: number,
  g: GimbalGeometry,
): { t1: number; t2: number } {
  const RAD = 180 / Math.PI;
  const left = mmToAngles({ x: -fieldW / 2, y: 0 }, g);
  const right = mmToAngles({ x: fieldW / 2, y: 0 }, g);
  const down = mmToAngles({ x: 0, y: -fieldH / 2 }, g);
  const up = mmToAngles({ x: 0, y: fieldH / 2 }, g);

  return {
    t1: Math.abs(right.t1 - left.t1) * RAD,
    t2: Math.abs(up.t2 - down.t2) * RAD,
  };
}
