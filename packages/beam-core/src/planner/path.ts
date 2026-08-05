import type { Point } from "../types.js";
import { CORNER_DEG, CORNER_FRAC, FLAT_TOL_MM, JOINTOL_MM } from "./tuning.js";

/*
 * The geometry half of the pipeline: everything that happens in target millimetres
 * before a velocity profile exists.
 *
 *   refineCurves   put the curves back that the source threw away
 *   mergeStrokes   join strokes that share an endpoint
 *   optimizePath   order the strokes so travel is short
 *   filletChain    round interior corners, never a beam gate change
 *   dedupeChain    collapse vertices that sit on top of each other
 *   densifyChain   resample at the resolution the machine can actually draw
 *
 * All of it is machine independent except the sampling step, which is why
 * densifyChain takes the step as a function of position rather than a constant: the
 * machine answers that question through MachineProfile.sampleStepMm.
 */

/** A source stroke. One point is a dot; two or more is a path. */
export type Stroke = readonly Point[];

const clampN = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const copy = (p: Point): Point => ({ x: p.x, y: p.y });
const dist = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Copy a stroke list so nothing downstream mutates a caller's arrays. */
export function copyStrokes(strokes: readonly Stroke[]): Point[][] {
  return strokes.map((s) => s.map(copy));
}

/** Turn at b, in degrees. Zero is straight on, 180 is a reversal. */
export function turnAngleDeg(a: Point, b: Point, c: Point): number {
  const v1x = b.x - a.x;
  const v1y = b.y - a.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const l1 = Math.hypot(v1x, v1y);
  const l2 = Math.hypot(v2x, v2y);
  if (l1 < 1e-9 || l2 < 1e-9) return 0;
  return (Math.acos(clampN((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1)) * 180) / Math.PI;
}

/**
 * Centripetal Catmull-Rom, evaluated between p1 and p2.
 *
 * Centripetal parameterisation rather than uniform, because uniform overshoots and
 * can loop back on itself where the spacing between control points changes sharply,
 * which font data does constantly.
 */
export function crPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const d = (a: Point, b: Point) => Math.pow(dist(a, b), 0.5);
  const t0 = 0;
  const t1 = t0 + d(p0, p1);
  const t2 = t1 + d(p1, p2);
  const t3 = t2 + d(p2, p3);
  if (t1 <= t0 || t2 <= t1 || t3 <= t2) {
    /* Coincident control points: fall back to the straight chord rather than
     * dividing by a zero knot span. */
    return { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
  }
  const L = (a: Point, b: Point, f: number): Point => ({
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
  });
  const tt = t1 + (t2 - t1) * t;
  const A1 = L(p0, p1, (tt - t0) / (t1 - t0));
  const A2 = L(p1, p2, (tt - t1) / (t2 - t1));
  const A3 = L(p2, p3, (tt - t2) / (t3 - t2));
  const B1 = L(A1, A2, (tt - t0) / (t2 - t0));
  const B2 = L(A2, A3, (tt - t1) / (t3 - t1));
  return L(B1, B2, (tt - t1) / (t2 - t1));
}

/** Perpendicular distance from q to the segment ab. Used all over the geometry chain. */
export function ptSegDist(q: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return Math.hypot(q.x - a.x, q.y - a.y);
  let t = ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t));
}

/**
 * Flatten one spline span by bisection.
 *
 * Keep splitting while the curve's midpoint sits further off the chord than the
 * tolerance allows. Points land where the shape needs them instead of at a fixed
 * spacing, so a tight bowl gets many and a lazy sweep gets few, and a source that is
 * already smooth passes straight through because its first midpoint test passes.
 */
function crFlatten(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t0: number,
  t1: number,
  a: Point,
  b: Point,
  out: Point[],
  tol: number,
  depth: number,
): void {
  const tm = (t0 + t1) / 2;
  const m = crPoint(p0, p1, p2, p3, tm);
  if (depth >= 12 || ptSegDist(m, a, b) <= tol) {
    out.push(copy(b));
    return;
  }
  crFlatten(p0, p1, p2, p3, t0, tm, a, m, out, tol, depth + 1);
  crFlatten(p0, p1, p2, p3, tm, t1, m, b, out, tol, depth + 1);
}

function refineRun(run: readonly Point[], tol: number, closed: boolean): Point[] {
  if (run.length < 3) return run.map(copy);
  const at = (i: number): Point => {
    if (closed) return run[((i % run.length) + run.length) % run.length]!;
    return run[clampN(i, 0, run.length - 1)]!;
  };
  const out: Point[] = [copy(run[0]!)];
  for (let i = 0; i < run.length - 1; i++) {
    crFlatten(at(i - 1), run[i]!, run[i + 1]!, at(i + 2), 0, 1, run[i]!, run[i + 1]!, out, tol, 0);
  }
  return out;
}

/**
 * Put the curves back.
 *
 * The stroke font stores a letter O as an eight sided polygon. At a 37 mm cap height
 * that is a full millimetre of faceting on every curve, which is three times worse
 * than the servo's own accuracy: the plot was never limited by the hardware, it was
 * limited by the shape it was handed. Densifying does not help and cannot, because
 * adding points along a flat facet keeps the facet.
 *
 * So split each stroke at its genuine corners, then run a centripetal Catmull-Rom
 * through each smooth run and resample it at the resolution the rig can actually
 * draw. Corners stay corners: the crossbar of an H, the apex of an A and the stem of
 * a B are all sharp turns and must not be rounded into the letterform.
 *
 * Sources that are already dense pass through untouched: a segment shorter than the
 * sample step is left exactly where it is, so freehand strokes, sampled SVG paths and
 * image raster lines are unaffected.
 */
export function refineCurves(strokes: readonly Stroke[], tol: number): Point[][] {
  const out: Point[][] = [];
  for (const s of strokes) {
    if (s.length < 3) {
      out.push(s.map(copy));
      continue;
    }
    const n = s.length;
    const closed = dist(s[0]!, s[n - 1]!) < 1e-6;
    /* Mark the genuine corners; everything between them is a curve. */
    const corner = new Array<boolean>(n).fill(false);
    corner[0] = corner[n - 1] = !closed;
    for (let i = 1; i < n - 1; i++) {
      if (turnAngleDeg(s[i - 1]!, s[i]!, s[i + 1]!) > CORNER_DEG) corner[i] = true;
    }
    if (closed && turnAngleDeg(s[n - 2]!, s[0]!, s[1]!) > CORNER_DEG) {
      corner[0] = corner[n - 1] = true;
    }

    let run: Point[] = [s[0]!];
    let res: Point[] = [];
    for (let i = 1; i < n; i++) {
      run.push(s[i]!);
      if (corner[i] || i === n - 1) {
        const r = refineRun(run, tol, closed && !corner[0] && run.length === n);
        if (res.length) r.shift();
        res = res.concat(r);
        run = [s[i]!];
      }
    }
    out.push(res.length >= 2 ? res : s.map(copy));
  }
  return out;
}

/**
 * Join strokes that share an endpoint.
 *
 * Font glyphs arrive as separate strokes even where they are one continuous pen
 * movement. B is two strokes meeting at the same point; a planner that treats them
 * separately stops dead there, dwells, and starts again. Joining them first means the
 * corner gets rounded and driven through like any other corner.
 */
export function mergeStrokes(strokes: readonly Stroke[], joinTol: number = JOINTOL_MM): Point[][] {
  const pool = strokes.filter((s) => s.length >= 2).map((s) => s.map(copy));
  const near = (a: Point, b: Point) => dist(a, b) <= joinTol;
  const out: Point[][] = [];
  while (pool.length) {
    const chain = pool.shift()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i]!;
        const head = chain[0]!;
        const tail = chain[chain.length - 1]!;
        if (near(tail, s[0]!)) {
          chain.push(...s.slice(1));
        } else if (near(tail, s[s.length - 1]!)) {
          chain.push(...s.slice(0, -1).reverse());
        } else if (near(head, s[s.length - 1]!)) {
          chain.unshift(...s.slice(0, -1));
        } else if (near(head, s[0]!)) {
          chain.unshift(...s.slice(1).reverse());
        } else {
          continue;
        }
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push(chain);
  }
  return out;
}

/**
 * Greedy nearest neighbour from the parking position, reversing a stroke where that
 * end is closer.
 *
 * Under three strokes there is nothing to order, and the copy is not worth making.
 * Both shipped tools take the same shortcut, and both start the walk from the origin
 * because that is where the beam actually parks.
 */
export function optimizePath(
  strokes: readonly Stroke[],
  origin: Point = { x: 0, y: 0 },
  allowReverse = true,
): Point[][] {
  if (strokes.length < 3) return strokes.map((s) => s.map(copy));
  const remaining = strokes.map((s) => s.map(copy));
  const out: Point[][] = [];
  let cur = copy(origin);
  const d2 = (a: Point, b: Point) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  };
  while (remaining.length) {
    let best = 0;
    let bestRev = false;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i]!;
      const dHead = d2(cur, s[0]!);
      const dTail = d2(cur, s[s.length - 1]!);
      if (dHead < bestD) {
        bestD = dHead;
        best = i;
        bestRev = false;
      }
      if (allowReverse && dTail < bestD) {
        bestD = dTail;
        best = i;
        bestRev = true;
      }
    }
    const s = remaining.splice(best, 1)[0]!;
    if (bestRev) s.reverse();
    out.push(s);
    cur = s[s.length - 1]!;
  }
  return out;
}

/** A millimetre path with a beam gate per segment. `pen[i]` gates `pts[i]` to `pts[i+1]`. */
export interface GatedPath {
  pts: Point[];
  pen: boolean[];
}

/**
 * Replace an interior vertex with a quadratic bezier that cuts back along both legs.
 *
 * Collinear vertices are dropped. Closed chains get their seam filleted too, which is
 * what stops the letter O having a flat spot.
 *
 * A CORNER WHERE THE BEAM SWITCHES STATE MUST STAY A REAL VERTEX, or the beam would
 * light part way round the arc and leave a hook on the wall. That is the one rule in
 * here that is not about looks.
 *
 * The flatness test measures this vertex against the last point actually KEPT, not
 * against its neighbour in the input. Testing against the neighbour looks equivalent
 * and is not: on a gently curving run every vertex is nearly straight relative to the
 * one before it, so they were dropped one after another and the output jumped from
 * the start of the curve to the end. A refined letter D collapsed from 106 points to
 * 11, and the bowl became a chord straight through the middle of the letter. Sampled
 * SVG paths and image rasters were being cut the same way.
 */
export function filletChain(pts: readonly Point[], pen: readonly boolean[], r: number): GatedPath {
  const n = pts.length;
  if (n < 3) return { pts: pts.map(copy), pen: pen.slice() };
  const closed = dist(pts[0]!, pts[n - 1]!) < 1e-6;
  const oPts: Point[] = [];
  const oPen: boolean[] = [];

  oPts.push(copy(pts[0]!));
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const kIn = pen[i - 1] ?? false;
    const kOut = pen[i] ?? false;
    let v1x = a.x - b.x;
    let v1y = a.y - b.y;
    let v2x = c.x - b.x;
    let v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-9 || l2 < 1e-9) continue; // duplicate point, drop it
    v1x /= l1;
    v1y /= l1;
    v2x /= l2;
    v2y /= l2;

    if (kIn === kOut) {
      const last = oPts[oPts.length - 1]!;
      if (ptSegDist(b, last, c) < FLAT_TOL_MM) continue; // genuinely on the line
    }
    const cut = Math.min(r, l1 * CORNER_FRAC, l2 * CORNER_FRAC);
    if (r <= 0 || cut < 1e-4 || kIn !== kOut) {
      oPen.push(kIn);
      oPts.push(copy(b));
      continue;
    }

    const p1: Point = { x: b.x + v1x * cut, y: b.y + v1y * cut };
    const p2: Point = { x: b.x + v2x * cut, y: b.y + v2y * cut };
    const steps = Math.max(2, Math.ceil(cut / 0.4));
    oPen.push(kIn);
    oPts.push(p1);
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const mt = 1 - t;
      oPen.push(kIn);
      oPts.push({
        x: mt * mt * p1.x + 2 * mt * t * b.x + t * t * p2.x,
        y: mt * mt * p1.y + 2 * mt * t * b.y + t * t * p2.y,
      });
    }
    oPen.push(kIn);
    oPts.push(p2);
  }
  oPen.push(pen[n - 2] ?? false);
  oPts.push(copy(pts[n - 1]!));
  if (closed && oPts.length > 2) {
    /* Carry the last point onto the first so the seam is continuous. */
    oPts[oPts.length - 1] = copy(oPts[0]!);
  }
  return { pts: oPts, pen: oPen };
}

/**
 * Collapse points that sit on top of each other, keeping the more permissive beam
 * state across the join so a stroke is never clipped by the collapse.
 *
 * This is the millimetre-space dedupe. It does NOT substitute for the integer axis
 * dedupe in planner/guards.ts, and neither substitutes for the other: this one runs
 * on the design geometry where microns of hop confuse the junction rule, and that one
 * runs after quantisation where a 0.02 mm test cannot see a collision that happens at
 * a 0.55 mm quantum. See INV-79.
 */
export function dedupeChain(pts: readonly Point[], penIn: readonly boolean[], eps: number): GatedPath {
  if (pts.length === 0) return { pts: [], pen: [] };
  const pen = Array.from(penIn);
  const oPts: Point[] = [copy(pts[0]!)];
  const oPen: boolean[] = [];
  for (let i = 1; i < pts.length; i++) {
    const last = oPts[oPts.length - 1]!;
    if (dist(pts[i]!, last) < eps) {
      if (oPen.length) oPen[oPen.length - 1] = oPen[oPen.length - 1]! || pen[i - 1]!;
      else if (i < pen.length) pen[i] = pen[i]! || pen[i - 1]!;
      continue;
    }
    oPts.push(copy(pts[i]!));
    oPen.push(pen[i - 1] ?? false);
  }
  return { pts: oPts, pen: oPen };
}

/**
 * Resample the chain so no segment is longer than the step.
 *
 * The step is a function of position, not a constant, because the machine answers
 * that question and its answer varies across the field: under a solved mapping a
 * millimetre near one edge costs several times the axis travel of a millimetre near
 * the centre. Two independent slew limited axes bend a long diagonal into a dogleg;
 * short steps keep that bend under the beam width so the drawn path follows the
 * design.
 */
export function densifyChain(
  pts: readonly Point[],
  pen: readonly boolean[],
  stepAt: (a: Point, b: Point) => number,
): GatedPath {
  if (pts.length === 0) return { pts: [], pen: [] };
  const oPts: Point[] = [copy(pts[0]!)];
  const oPen: boolean[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    const step = Math.max(1e-6, stepAt(a, b));
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) {
      oPts.push({ x: a.x + (dx * k) / n, y: a.y + (dy * k) / n });
      oPen.push(pen[i - 1] ?? false);
    }
  }
  return { pts: oPts, pen: oPen };
}
