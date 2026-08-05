import type { Calibration, Point } from "../types.js";

/*
 * Four corner bilinear calibration, ported from WASHER.
 *
 * A bilinear map warps the design into the measured corner quad, which corrects for
 * an off axis or non square mount far better than the ideal model. It is strictly
 * less general than the projective homography DETENT uses, and the PRD carries the
 * open question of whether WASHER should move to that. Both ship, defaulted per
 * profile, so the two can be compared on the bench against the same corners rather
 * than argued about.
 *
 * The one thing this must not do is be applied in only half the system. WASHER
 * shipped for a while with the aiming path calibrated and the preview path not, so
 * the moment you captured four corners the sim was drawing through a different
 * mapping than the one the beam was being aimed with, and the picture came out
 * warped against the design. INV-01 and INV-03 exist because of that.
 */

/** Captured corner angles, radians, in the order TL, TR, BL, BR. */
export interface CornerAngles {
  tl: { t1: number; t2: number };
  tr: { t1: number; t2: number };
  bl: { t1: number; t2: number };
  br: { t1: number; t2: number };
}

export interface BilinearField {
  width: number;
  height: number;
}

export function createBilinearCalibration(c: CornerAngles, field: BilinearField): Calibration {
  const forward = (p: Point) => {
    const u = (p.x + field.width / 2) / field.width; // 0 left, 1 right
    const v = (p.y + field.height / 2) / field.height; // 0 bottom, 1 top

    const w00 = (1 - u) * (1 - v);
    const w10 = u * (1 - v);
    const w01 = (1 - u) * v;
    const w11 = u * v;

    return {
      t1: w00 * c.bl.t1 + w10 * c.br.t1 + w01 * c.tl.t1 + w11 * c.tr.t1,
      t2: w00 * c.bl.t2 + w10 * c.br.t2 + w01 * c.tl.t2 + w11 * c.tr.t2,
    };
  };

  return {
    kind: "bilinear",
    forward,

    /*
     * There is no closed form inverse of a bilinear map, so this is Newton on the
     * two dimensional residual, seeded at the centre of the quad.
     *
     * The clamps on u and v let an aim outside the quad extrapolate instead of
     * diverging, which matters because the jog pad can and does point outside the
     * captured field. Returning null on a non-finite result lets the caller fall
     * back to the ideal model rather than aiming somewhere arbitrary.
     */
    inverse(t1: number, t2: number): Point | null {
      let u = 0.5;
      let v = 0.5;

      for (let i = 0; i < 6; i++) {
        const got = forward({ x: (u - 0.5) * field.width, y: (v - 0.5) * field.height });
        const f1 = got.t1 - t1;
        const f2 = got.t2 - t2;

        const d1u = (1 - v) * (c.br.t1 - c.bl.t1) + v * (c.tr.t1 - c.tl.t1);
        const d1v = (1 - u) * (c.tl.t1 - c.bl.t1) + u * (c.tr.t1 - c.br.t1);
        const d2u = (1 - v) * (c.br.t2 - c.bl.t2) + v * (c.tr.t2 - c.tl.t2);
        const d2v = (1 - u) * (c.tl.t2 - c.bl.t2) + u * (c.tr.t2 - c.br.t2);

        const det = d1u * d2v - d1v * d2u;
        if (Math.abs(det) < 1e-12) break;

        u -= (d2v * f1 - d1v * f2) / det;
        v -= (-d2u * f1 + d1u * f2) / det;

        if (!Number.isFinite(u) || !Number.isFinite(v)) return null;

        u = Math.min(2.5, Math.max(-1.5, u));
        v = Math.min(2.5, Math.max(-1.5, v));

        if (Math.abs(f1) < 1e-7 && Math.abs(f2) < 1e-7) break;
      }

      return { x: (u - 0.5) * field.width, y: (v - 0.5) * field.height };
    },
  };
}
