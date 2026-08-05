/*
 * 2D PRIMITIVES.
 *
 * The four shapes that exist so there is always something to draw: a circle to check
 * the mapping is round, a star to check the corners are sharp, a spiral to watch a
 * continuously curving path, and a grid to see the whole field at once.
 *
 * All four are built in unit coordinates and then normalised through `centerFit`
 * before scaling, so the size argument means the same thing for all of them
 * regardless of how each one happens to be parameterised.
 */

import type { Point } from "@virgilvox/beam-core";
import type { SourceResult, Stroke } from "./index.js";
import { bboxOf, centerFit, scaleToField } from "./ops.js";

export type ShapeKind = "circle" | "star" | "spiral" | "grid";

export interface ShapeOptions {
  /** Extra subdivision. Adds points to the curves and rows to the grid. */
  detail?: number;
  /** Size of the finished drawing on the target, millimetres, on its larger span. */
  sizeMm?: number;
}

/**
 * Star inner radius, as a fraction of the outer.
 *
 * 0.42 is the conventional five pointed star, and it is not the geometrically
 * "correct" 0.382 that a pentagram's self intersection gives. The exact figure makes
 * points so thin that on a target the beam width closes them up and the star reads as
 * a blob with five bumps. 0.42 is the value that still looks like a star once drawn
 * with a real beam.
 */
export const STAR_INNER_RADIUS = 0.42;

/** Points on the star. Five, because a star has five points. */
const STAR_POINTS = 5;

/** Turns in the spiral. Six fills the field without the arms closing up. */
const SPIRAL_TURNS = 6;

function unitShape(kind: ShapeKind, detail: number): Stroke[] {
  const out: Stroke[] = [];
  if (kind === "circle") {
    const n = 60 + detail * 40;
    const p: Point[] = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      p.push({ x: Math.cos(t), y: Math.sin(t) });
    }
    out.push(p);
  } else if (kind === "star") {
    const p: Point[] = [];
    const n = STAR_POINTS * 2;
    for (let i = 0; i <= n; i++) {
      /* A quarter turn FORWARD puts a point at the top, which is the only
       * orientation anybody recognises as a star.
       *
       * The shipped tool turns back a quarter instead, which is the correct sign in
       * a y-down canvas and the wrong one here: its own preview then flips y, so the
       * star it draws on the wall has a point at the bottom. Nobody caught it,
       * because an upside down five pointed star still reads as a star until you put
       * it next to the right way up. Every coordinate in this package is y up, so the
       * sign follows that. */
      const t = (i / n) * Math.PI * 2 + Math.PI / 2;
      const r = i % 2 ? STAR_INNER_RADIUS : 1;
      p.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
    }
    out.push(p);
  } else if (kind === "spiral") {
    const n = 200 + detail * 120;
    const p: Point[] = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2 * SPIRAL_TURNS;
      const r = i / n;
      p.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
    }
    out.push(p);
  } else {
    /* Every line is its own stroke, verticals then horizontals interleaved. The
     * travel optimiser turns that into a boustrophedon by itself, and it does a
     * better job of it than a hand written order because it also knows where the
     * beam was parked before the job started. */
    const n = 4 + detail;
    for (let i = 0; i <= n; i++) {
      const t = -1 + (2 * i) / n;
      out.push([
        { x: t, y: -1 },
        { x: t, y: 1 },
      ]);
      out.push([
        { x: -1, y: t },
        { x: 1, y: t },
      ]);
    }
  }
  return out;
}

/** One of the four primitives, in target millimetres, y up, centred on the origin. */
export function buildShape(kind: ShapeKind, opts: ShapeOptions = {}): SourceResult {
  const detail = opts.detail ?? 1;
  const sizeMm = opts.sizeMm ?? 100;
  const strokes = scaleToField(centerFit(unitShape(kind, detail)), sizeMm, 100);
  return { strokes, bbox: bboxOf(strokes) };
}

export function circle(opts: ShapeOptions = {}): SourceResult {
  return buildShape("circle", opts);
}

export function star(opts: ShapeOptions = {}): SourceResult {
  return buildShape("star", opts);
}

export function spiral(opts: ShapeOptions = {}): SourceResult {
  return buildShape("spiral", opts);
}

export function grid(opts: ShapeOptions = {}): SourceResult {
  return buildShape("grid", opts);
}
