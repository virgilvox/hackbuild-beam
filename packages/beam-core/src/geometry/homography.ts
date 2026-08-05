import type { Calibration, Point } from "../types.js";
import { anglesToUV, uvToAngles } from "./gimbal.js";

/*
 * Four corner projective calibration, ported from DETENT.
 *
 * The fit is millimetres to tangent space, not millimetres to axis units. That is
 * what makes it linear enough for four points to determine it: in (u, v) the ideal
 * model is near-linear in target mm, so everything a real installation does wrong
 * (rotation, keystone from an off axis mount, a wrong throw estimate, mirrors not
 * quite square) shows up as a projective distortion that a homography absorbs
 * exactly. With corners captured, the measured map wins. Without, fall back to
 * ideal.
 */

export type Homography8 = readonly [number, number, number, number, number, number, number, number];
export type Homography9 = readonly [number, number, number, number, number, number, number, number, number];

export interface Correspondence {
  /** Where the point is on the target plane. */
  mm: Point;
  /** Where the machine had to point to hit it, in tangent space. */
  uv: { u: number; v: number };
}

/**
 * Solve the eight unknowns of a projective map from four correspondences.
 *
 * Plain Gaussian elimination with partial pivoting, then full Gauss-Jordan so the
 * back substitution is a single divide. An 8x8 is nothing.
 *
 * Returns null when the corners are collinear or otherwise degenerate. Rejecting is
 * the right answer: a degenerate solve produces a map that looks plausible and aims
 * a live beam somewhere else.
 */
export function solveHomography(pts: readonly Correspondence[]): Homography8 | null {
  if (pts.length !== 4) return null;

  const A: number[][] = [];
  const b: number[] = [];
  for (const { mm, uv } of pts) {
    A.push([mm.x, mm.y, 1, 0, 0, 0, -uv.u * mm.x, -uv.u * mm.y]);
    b.push(uv.u);
    A.push([0, 0, 0, mm.x, mm.y, 1, -uv.v * mm.x, -uv.v * mm.y]);
    b.push(uv.v);
  }

  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) {
      if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    }
    /* The degeneracy guard. Below this the corners do not determine a map. */
    if (Math.abs(A[piv]![c]!) < 1e-14) return null;

    [A[c], A[piv]] = [A[piv]!, A[c]!];
    [b[c], b[piv]] = [b[piv]!, b[c]!];

    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      if (f === 0) continue;
      for (let k = c; k < 8; k++) A[r]![k]! -= f * A[c]![k]!;
      b[r]! -= f * b[c]!;
    }
  }

  return b.map((v, i) => v / A[i]![i]!) as unknown as Homography8;
}

/**
 * Adjugate inverse of [[h0 h1 h2],[h3 h4 h5],[h6 h7 1]].
 *
 * INV-05: this stays unnormalised on purpose. Scale is irrelevant because the
 * result is only ever used projectively, and normalising by the last entry to
 * "match" the forward form's trailing 1 works fine for a well conditioned H and
 * blows up where that entry approaches zero.
 */
export function invertHomography(h: Homography8): Homography9 {
  const [a, b, c, d, e, f, g, hh] = h;
  const i = 1;
  return [
    e * i - f * hh,
    -(b * i - c * hh),
    b * f - c * e,
    -(d * i - f * g),
    a * i - c * g,
    -(a * f - c * d),
    d * hh - e * g,
    -(a * hh - b * g),
    a * e - b * d,
  ];
}

/**
 * The two divide guards use different epsilons and different forms, and the
 * asymmetry is deliberate rather than drift: the forward map's denominator is
 * normalised to a trailing 1, so 1e-6 is a sensible floor, while the inverse
 * carries the adjugate's arbitrary scale and needs to go much smaller. Both
 * preserve sign, so a point just outside the quad extrapolates in the direction it
 * was heading rather than flipping to the far side of the field.
 *
 * The DETENT browser app's inverse guard is not sign preserving today. That is
 * recorded as a defect to fix on port, not a behavior to reproduce.
 */
function guard(w: number, eps: number): number {
  if (Math.abs(w) < eps) return w < 0 ? -eps : eps;
  return w;
}

export function createHomographyCalibration(h: Homography8): Calibration {
  const hinv = invertHomography(h);

  return {
    kind: "homography",

    forward(p: Point) {
      const w = guard(h[6] * p.x + h[7] * p.y + 1, 1e-6);
      const u = (h[0] * p.x + h[1] * p.y + h[2]) / w;
      const v = (h[3] * p.x + h[4] * p.y + h[5]) / w;
      return uvToAngles({ u, v });
    },

    inverse(t1: number, t2: number): Point | null {
      const { u, v } = anglesToUV({ t1, t2 });
      const w = guard(hinv[6] * u + hinv[7] * v + hinv[8], 1e-9);
      const x = (hinv[0] * u + hinv[1] * v + hinv[2]) / w;
      const y = (hinv[3] * u + hinv[4] * v + hinv[5]) / w;
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    },
  };
}

/**
 * The honest check: push each corner back through the solved map and see how far it
 * lands from what was actually measured, in millimetres on the target rather than
 * in steps or in tangent units. Under about 0.3 mm is a clean capture on the bench
 * geometry.
 *
 * Both sides are converted back through the same solved map, so the number is a
 * real distance on the wall and it captures the quantisation too.
 */
export function cornerResidualMm(
  h: Homography8,
  corners: readonly Correspondence[],
  toMm: (uv: { u: number; v: number }) => Point,
): number {
  const cal = createHomographyCalibration(h);
  let worst = 0;
  for (const c of corners) {
    const got = anglesToUV(cal.forward(c.mm));
    const a = toMm(got);
    const b = toMm(c.uv);
    worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
  }
  return worst;
}

/**
 * Aspect of the physical quad, from the corner deflection tangents. If it disagrees
 * with the configured field width to height, the drawing will squash or clip to
 * match, and the app offers to fit the field height to the quad instead.
 *
 * Corners are ordered TL, TR, BR, BL.
 */
export function quadAspect(corners: readonly { u: number; v: number }[]): number {
  if (corners.length !== 4) return 0;
  const [tl, tr, br, bl] = corners as [
    { u: number; v: number },
    { u: number; v: number },
    { u: number; v: number },
    { u: number; v: number },
  ];
  const uw = (Math.abs(tr.u - tl.u) + Math.abs(br.u - bl.u)) / 2;
  const vh = (Math.abs(tl.v - bl.v) + Math.abs(tr.v - br.v)) / 2;
  return vh > 1e-9 ? uw / vh : 0;
}
