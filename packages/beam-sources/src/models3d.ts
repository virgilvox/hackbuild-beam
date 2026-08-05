/*
 * 3D AND 4D WIREFRAMES.
 *
 * Wireframes are what a beam draws well: no fills to hatch, no hidden surface
 * removal to get wrong, and a shape that reads instantly as three dimensional
 * because the eye supplies the depth from the projection alone.
 *
 * Everything here produces model space geometry, is rotated, is projected to 2D, and
 * is then normalised and scaled to the target. The rotation angles are inputs rather
 * than state, so an animated version is a caller calling this once per frame with a
 * different angle, and nothing here has to know that time exists.
 */

import type { Point } from "@virgilvox/beam-core";
import type { SourceResult, Stroke } from "./index.js";
import { bboxOf, centerFit, scaleToField } from "./ops.js";

export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];

export interface Wireframe {
  /** Vertices, 3 or 4 components depending on `dim`. */
  readonly v: ReadonlyArray<readonly number[]>;
  /** Edges as index pairs into `v`. */
  readonly e: ReadonlyArray<readonly [number, number]>;
  readonly dim: 3 | 4;
}

/**
 * Hypercube edge enumeration, and it is the same three lines in any dimension.
 *
 * Vertices are the bit patterns of 0..2^n-1 mapped to -1 and +1 per axis, and two
 * vertices share an edge exactly when their patterns differ in one bit. Walking bit
 * b upward from each vertex that does not already have it set visits every edge
 * exactly once, so there is no dedupe pass and no chance of a doubled edge.
 */
function hypercube(dim: 3 | 4): Wireframe {
  const n = 1 << dim;
  const v: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p: number[] = [];
    for (let d = 0; d < dim; d++) p.push(i & (1 << d) ? 1 : -1);
    v.push(p);
  }
  const e: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    for (let b = 1; b < n; b <<= 1) if (!(i & b)) e.push([i, i | b]);
  }
  return { v, e, dim };
}

export function modelCube(): Wireframe {
  return hypercube(3);
}

export function modelTesseract(): Wireframe {
  return hypercube(4);
}

function dist3(a: readonly number[], b: readonly number[]): number {
  const x = a[0]! - b[0]!;
  const y = a[1]! - b[1]!;
  const z = a[2]! - b[2]!;
  return Math.sqrt(x * x + y * y + z * z);
}

/** Coincidence tolerance for the edge search below. Vertices are order 1, so this is loose. */
const EDGE_EPSILON = 1e-6;

/**
 * ICOSAHEDRON.
 *
 * The twelve vertices are the cyclic permutations of (0, +/-1, +/-phi). Edges are not
 * enumerated by hand: they are found as every pair of vertices at the MINIMUM
 * non-zero distance, which is correct because an icosahedron is vertex transitive and
 * every edge therefore has the same length. Thirty edges fall out of a search that
 * cannot get the connectivity wrong the way a hand written table can.
 *
 * The final divide by phi normalises the circumradius so this solid arrives at the
 * same nominal size as the cube rather than a third larger.
 */
export function modelIcosahedron(): Wireframe {
  const phi = (1 + Math.sqrt(5)) / 2;
  const v: number[][] = [];
  for (const s1 of [-1, 1]) {
    for (const s2 of [-phi, phi]) {
      v.push([0, s1, s2]);
      v.push([s1, s2, 0]);
      v.push([s2, 0, s1]);
    }
  }
  const n = v.length;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dist3(v[i]!, v[j]!);
      if (d > EDGE_EPSILON && d < best) best = d;
    }
  }
  const e: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(dist3(v[i]!, v[j]!) - best) < EDGE_EPSILON) e.push([i, j]);
    }
  }
  return { v: v.map((q) => q.map((k) => k / phi)), e, dim: 3 };
}

/* -------------------------------------------------------------- open curves */

/**
 * TORUS KNOT, p = 2, q = 3.
 *
 * One continuous stroke, which is why it plots so much faster than a solid of
 * comparable point count: there is exactly one beam-off travel in the whole figure.
 */
export function curveKnot(detail: number): Vec3[][] {
  const n = 60 + detail * 50;
  const p = 2;
  const q = 3;
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = 1 + 0.45 * Math.cos(q * t);
    pts.push([r * Math.cos(p * t), r * Math.sin(p * t), 0.45 * Math.sin(q * t)]);
  }
  return [pts];
}

/**
 * 3D LISSAJOUS at 3:4:5 with irrational-looking phase offsets.
 *
 * The offsets are what stop the figure degenerating into a flat plane curve: at zero
 * phase the three sines line up at t = 0 and the whole thing collapses onto a
 * symmetric shape with far less apparent depth.
 */
export function curveLissajous(detail: number): Vec3[][] {
  const n = 200 + detail * 140;
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([Math.sin(3 * t), Math.sin(4 * t + 1.1), Math.sin(5 * t + 0.4)]);
  }
  return [pts];
}

/**
 * SPHERE as latitude rings plus longitude arcs.
 *
 * Rings run 1..rings-1 rather than 0..rings, because the two end rings are the poles
 * and a pole ring is a zero radius circle: a stroke of many points all at the same
 * place, which the dedupe pass downstream would collapse to nothing anyway after the
 * planner had already spent its time on it.
 */
export function curveSphere(detail: number): Vec3[][] {
  const rings = 3 + detail;
  const segs = 12 + detail * 8;
  const out: Vec3[][] = [];
  for (let r = 1; r < rings; r++) {
    const phi = (Math.PI * r) / rings;
    const pts: Vec3[] = [];
    for (let i = 0; i <= segs; i++) {
      const th = (i / segs) * Math.PI * 2;
      pts.push([Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)]);
    }
    out.push(pts);
  }
  for (let m = 0; m < rings + 1; m++) {
    const th = (Math.PI * m) / (rings + 1);
    const pts: Vec3[] = [];
    for (let i = 0; i <= segs; i++) {
      const phi = (i / segs) * Math.PI * 2;
      pts.push([Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)]);
    }
    out.push(pts);
  }
  return out;
}

/* -------------------------------------------------------- rotation and camera */

/**
 * Roll, then yaw, then pitch, in that order and about the world axes.
 *
 * The order is fixed rather than configurable because the three sliders in front of
 * a user have to mean the same thing every time they are touched, and any Euler
 * order does that as long as it never changes. Roll first is what makes the roll
 * slider feel like it spins the object in the picture plane, which is what it looks
 * like it should do.
 */
export function rot3(p: Vec3, yaw: number, pitch: number, roll: number): Vec3 {
  let [x, y, z] = p;
  let c = Math.cos(roll);
  let s = Math.sin(roll);
  [x, y] = [x * c - y * s, x * s + y * c];
  c = Math.cos(yaw);
  s = Math.sin(yaw);
  [x, z] = [x * c - z * s, x * s + z * c];
  c = Math.cos(pitch);
  s = Math.sin(pitch);
  [y, z] = [y * c - z * s, y * s + z * c];
  return [x, y, z];
}

/**
 * A double rotation in 4D: the xw plane at `ang` and the yw plane at 0.63 of it.
 *
 * Two planes rather than one, at an incommensurable ratio, is what makes a tesseract
 * look like it is turning inside out instead of merely spinning. A single plane
 * rotation is periodic and the eye reads it as a rigid 3D object with an odd shape;
 * the second rotation is what makes the projection breathe.
 */
export const TESSERACT_ROT_RATIO = 0.63;

export function rot4(p: Vec4, ang: number): Vec4 {
  let [x, y, , w] = p;
  /* z is untouched: both planes involve w, which is what keeps the 3D shadow of the
   * rotation from simply spinning about an ordinary axis. */
  const z = p[2];
  let c = Math.cos(ang);
  let s = Math.sin(ang);
  [x, w] = [x * c - w * s, x * s + w * c];
  c = Math.cos(ang * TESSERACT_ROT_RATIO);
  s = Math.sin(ang * TESSERACT_ROT_RATIO);
  [y, w] = [y * c - w * s, y * s + w * c];
  return [x, y, z, w];
}

/**
 * The 4D to 3D perspective plane, in the same units as the tesseract's own vertices,
 * which run from -1 to +1 in w.
 *
 * 2.6 is close enough that the inner cell is visibly smaller than the outer one, which
 * is the entire visual point, and far enough that the divisor never approaches zero.
 * The double rotation mixes x and y into w, so w does not stay inside [-1, 1]: its
 * worst case is sqrt(3), which leaves the divisor above 0.86 and the projection
 * finite at every angle. At a w plane of 1.0 a vertex would pass straight through the
 * eye point and throw the drawing to infinity mid-animation.
 */
export const TESSERACT_W_PLANE = 2.6;

/**
 * Model space to 2D, weak perspective. `cam` is the eye distance in the same
 * arbitrary units as the 100x model scale it divides against, so a larger `cam` is a
 * longer lens and a flatter picture.
 */
export const MODEL_SCALE = 100;

export function project(p: Vec3, cam: number): Point {
  const k = cam / (cam + p[2] * MODEL_SCALE);
  return { x: p[0] * MODEL_SCALE * k, y: p[1] * MODEL_SCALE * k };
}

export type ModelKind = "cube" | "tesseract" | "ico" | "knot" | "lissa" | "sphere";

export interface Model3dOptions {
  yaw?: number;
  pitch?: number;
  roll?: number;
  /** Eye distance. Around 400 is a natural looking lens on a unit model. */
  cam?: number;
  /** Extra subdivision for the sampled curves. Ignored by the polyhedra. */
  detail?: number;
  /** The 4D rotation angle, for the tesseract only. */
  spin?: number;
  /** Size of the finished drawing on the target, millimetres, on its larger span. */
  sizeMm?: number;
}

/**
 * Build one model, projected, normalised and scaled to the target in millimetres.
 *
 * Each edge of a polyhedron becomes its OWN stroke, deliberately. Chaining edges into
 * a tour is what `orderStrokes` does, and it does it against the actual projected
 * positions, which is the only place the answer is known: an edge tour computed in
 * model space is a tour of the wrong distances once the projection has squashed one
 * axis.
 */
export function build3d(kind: ModelKind, opts: Model3dOptions = {}): SourceResult {
  const yaw = opts.yaw ?? 0;
  const pitch = opts.pitch ?? 0;
  const roll = opts.roll ?? 0;
  const cam = opts.cam ?? 400;
  const detail = opts.detail ?? 1;
  const spin = opts.spin ?? 0;
  const sizeMm = opts.sizeMm ?? 100;

  let polys: Vec3[][];
  if (kind === "knot") polys = curveKnot(detail);
  else if (kind === "lissa") polys = curveLissajous(detail);
  else if (kind === "sphere") polys = curveSphere(detail);
  else {
    const model =
      kind === "tesseract" ? modelTesseract() : kind === "ico" ? modelIcosahedron() : modelCube();
    let v3: Vec3[];
    if (model.dim === 4) {
      v3 = model.v.map((p) => {
        const q = rot4([p[0]!, p[1]!, p[2]!, p[3]!], spin * 0.7 + roll);
        const k = TESSERACT_W_PLANE / (TESSERACT_W_PLANE + q[3]);
        return [q[0] * k, q[1] * k, q[2] * k] as Vec3;
      });
    } else {
      v3 = model.v.map((p) => [p[0]!, p[1]!, p[2]!] as Vec3);
    }
    polys = model.e.map(([a, b]) => [v3[a]!, v3[b]!]);
  }

  const flat: Stroke[] = polys.map((poly) => poly.map((p) => project(rot3(p, yaw, pitch, roll), cam)));
  const strokes = scaleToField(centerFit(flat), sizeMm, 100);
  return { strokes, bbox: bboxOf(strokes) };
}
