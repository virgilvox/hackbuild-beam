/*
 * SINGLE STROKE PLOTTER FONT
 *
 * Centreline strokes, not outlines, so the beam draws each glyph in one pass
 * instead of tracing both edges of it. Coordinates are y up: baseline y = 0, cap
 * height y = 14, lower case x-height 9, descender -4.5.
 *
 * Glyphs are PATHS, not polygons. M and L are what they look like; Q is a quadratic
 * with one control point. Declaring a curve as a curve means the plotter flattens it
 * exactly to whatever tolerance is set, instead of the arrangement this replaced,
 * where curves were stored as coarse polygons and a spline guessed them back. That
 * guess was wrong in a way you could see: it bulges outside the polygon it
 * interpolates, so a letter O came out 2.4 mm wider than designed at a 37 mm cap and
 * round letters looked visibly fatter than straight ones.
 *
 * Two consequences follow from storing curves as curves, and both matter.
 *
 * The tolerance is applied in TARGET MILLIMETRES, not in font units, so a glyph gets
 * the number of points its final size needs. The same letter at 10 mm and at 200 mm
 * is flattened to the same accuracy on the wall rather than to the same point count.
 *
 * And a corner is a corner because the design says so. There is no angle threshold
 * deciding which vertices were meant to be round, which is what the polygon path had
 * to do and what made it guess wrong on nearly half the alphabet.
 */

import type { Point } from "@virgilvox/beam-core";
import type { SourceResult, Stroke } from "./index.js";
import { bboxOf } from "./ops.js";
import { SERVO_GLYPHS, SERVO_METRICS } from "./font-servo.js";

export interface GlyphDef {
  /** Advance width in font units, before tracking. */
  readonly advance: number;
  /** Path data in the M / L / Q subset. */
  readonly d: string;
}

export interface FontMetrics {
  readonly cap: number;
  readonly xHeight: number;
  readonly descender: number;
  readonly spaceAdvance: number;
  readonly lineGap: number;
}

export const FONT_METRICS: FontMetrics = {
  cap: 14,
  xHeight: 9,
  descender: -4.5,
  spaceAdvance: 6,
  lineGap: 8,
};

export const GLYPHS: Readonly<Record<string, GlyphDef>> = {
  "A": { advance: 11, d: "M0.5 0L5.5 14L10.5 0 M2.5 5L8.5 5" },
  "B": { advance: 11, d: "M1 0L1 14L5.5 14Q8.6 14 8.6 10.6Q8.6 7.4 5.5 7.4L1 7.4 M1 7.4L6 7.4Q9.2 7.4 9.2 3.7Q9.2 0 6 0L1 0" },
  "C": { advance: 11, d: "M9.2 11.4Q9.2 14 5.4 14Q1 14 1 7Q1 0 5.4 0Q9.2 0 9.2 2.6" },
  "D": { advance: 11, d: "M1 0L1 14L5 14Q9.6 14 9.6 7Q9.6 0 5 0L1 0" },
  "E": { advance: 10, d: "M9 14L1 14L1 0L9 0 M1 7L6.8 7" },
  "F": { advance: 10, d: "M9 14L1 14L1 0 M1 7L6.8 7" },
  "G": { advance: 11, d: "M9.2 11.4Q9.2 14 5.4 14Q1 14 1 7Q1 0 5.4 0Q9.2 0 9.2 3.4L9.2 6.2L6.2 6.2" },
  "H": { advance: 11, d: "M1 0L1 14 M9 0L9 14 M1 7L9 7" },
  "I": { advance: 4, d: "M2 0L2 14" },
  "J": { advance: 9, d: "M7 14L7 3.6Q7 0 4 0Q1 0 1 3" },
  "K": { advance: 11, d: "M1 0L1 14 M9 14L1 6.4 M3.5 8.8L9.2 0" },
  "L": { advance: 10, d: "M1 14L1 0L8.6 0" },
  "M": { advance: 13, d: "M1 0L1 14L6 4L11 14L11 0" },
  "N": { advance: 11, d: "M1 0L1 14L9 0L9 14" },
  "O": { advance: 12, d: "M5.5 14Q1 14 1 7Q1 0 5.5 0Q10 0 10 7Q10 14 5.5 14" },
  "P": { advance: 11, d: "M1 0L1 14L6 14Q9.2 14 9.2 10.5Q9.2 7 6 7L1 7" },
  "Q": { advance: 12, d: "M5.5 14Q1 14 1 7Q1 0 5.5 0Q10 0 10 7Q10 14 5.5 14 M6.6 3.6L10.6 -1" },
  "R": { advance: 11, d: "M1 0L1 14L6 14Q9.2 14 9.2 10.5Q9.2 7 6 7L1 7 M5.2 7L9.4 0" },
  "S": { advance: 11, d: "M9.2 11.6Q9.2 14 5.1 14Q1 14 1 11Q1 8.2 5.1 7.5Q9.2 6.8 9.2 3.6Q9.2 0 5.1 0Q1 0 1 2.4" },
  "T": { advance: 10, d: "M0.6 14L9.4 14 M5 14L5 0" },
  "U": { advance: 11, d: "M1 14L1 4Q1 0 5 0Q9 0 9 4L9 14" },
  "V": { advance: 10, d: "M0.6 14L5 0L9.4 14" },
  "W": { advance: 13, d: "M0.6 14L3.6 0L6.5 9.6L9.4 0L12.4 14" },
  "X": { advance: 11, d: "M1 14L9 0 M9 14L1 0" },
  "Y": { advance: 11, d: "M1 14L5 7L9 14 M5 7L5 0" },
  "Z": { advance: 11, d: "M1 14L9 14L1 0L9 0" },
  "a": { advance: 10, d: "M8 9L8 0 M8 6.4Q8 9 4.5 9Q1 9 1 4.5Q1 0 4.5 0Q8 0 8 2.6" },
  "b": { advance: 10, d: "M1 14L1 0 M1 4.5Q1 9 4.5 9Q8 9 8 4.5Q8 0 4.5 0Q1 0 1 4.5" },
  "c": { advance: 10, d: "M8 6.8Q8 9 4.5 9Q1 9 1 4.5Q1 0 4.5 0Q8 0 8 2.2" },
  "d": { advance: 10, d: "M8 14L8 0 M8 4.5Q8 9 4.5 9Q1 9 1 4.5Q1 0 4.5 0Q8 0 8 4.5" },
  "e": { advance: 10, d: "M1 4.4L8 4.4Q8 9 4.5 9Q1 9 1 4.5Q1 0 4.5 0Q7.3 0 8 1.8" },
  "f": { advance: 7, d: "M6.4 14Q3.4 14 3.4 11L3.4 0 M1.2 9L6 9" },
  "g": { advance: 10, d: "M8 9L8 -1Q8 -4.5 4.5 -4.5Q2 -4.5 1.3 -3 M8 4.5Q8 9 4.5 9Q1 9 1 4.5Q1 0 4.5 0Q8 0 8 4.5" },
  "h": { advance: 10, d: "M1 14L1 0 M1 5Q1 9 4.5 9Q8 9 8 5L8 0" },
  "i": { advance: 4, d: "M2 9L2 0 M2 12.4L2 13.2" },
  "j": { advance: 5, d: "M3 9L3 -1Q3 -4.5 0.6 -4.5 M3 12.4L3 13.2" },
  "k": { advance: 9, d: "M1 14L1 0 M7.6 9L1 3.4 M3.2 5.2L8.2 0" },
  "l": { advance: 5, d: "M1.6 14L1.6 2Q1.6 0 3.6 0" },
  "m": { advance: 13, d: "M1 9L1 0 M1 5.4Q1 9 3.6 9Q6 9 6 5.4L6 0 M6 5.4Q6 9 8.6 9Q11 9 11 5.4L11 0" },
  "n": { advance: 10, d: "M1 9L1 0 M1 5Q1 9 4.5 9Q8 9 8 5L8 0" },
  "o": { advance: 10, d: "M4.5 9Q1 9 1 4.5Q1 0 4.5 0Q8 0 8 4.5Q8 9 4.5 9" },
  "p": { advance: 10, d: "M1 9L1 -4.5 M1 4.5Q1 9 4.5 9Q8 9 8 4.5Q8 0 4.5 0Q1 0 1 4.5" },
  "q": { advance: 10, d: "M8 9L8 -4.5 M8 4.5Q8 9 4.5 9Q1 9 1 4.5Q1 0 4.5 0Q8 0 8 4.5" },
  "r": { advance: 8, d: "M1 9L1 0 M1 5.4Q1 9 4.4 9Q6.4 9 7 8" },
  "s": { advance: 9, d: "M7.6 7.4Q7.6 9 4.3 9Q1.1 9 1.1 7Q1.1 5.1 4.3 4.7Q7.6 4.3 7.6 2.2Q7.6 0 4.3 0Q1.1 0 1.1 1.5" },
  "t": { advance: 7, d: "M3.4 14L3.4 2Q3.4 0 5.4 0 M1.2 9L6 9" },
  "u": { advance: 10, d: "M1 9L1 4Q1 0 4.5 0Q8 0 8 4L8 9 M8 4L8 0" },
  "v": { advance: 9, d: "M1 9L4.5 0L8 9" },
  "w": { advance: 11, d: "M1 9L3 0L5.5 6.2L8 0L10 9" },
  "x": { advance: 9, d: "M1 9L8 0 M8 9L1 0" },
  "y": { advance: 9, d: "M1 9L4.5 0 M8 9L4.5 0L2.4 -4.5" },
  "z": { advance: 9, d: "M1 9L8 9L1 0L8 0" },
  "0": { advance: 11, d: "M5 14Q1 14 1 7Q1 0 5 0Q9 0 9 7Q9 14 5 14 M3.2 3.6L6.8 10.4" },
  "1": { advance: 8, d: "M1.6 11.4L4.6 14L4.6 0 M1.8 0L7.4 0" },
  "2": { advance: 11, d: "M1 11.4Q1 14 5 14Q8.9 14 8.9 10.6Q8.9 8.2 1 0L9.2 0" },
  "3": { advance: 11, d: "M1 12.4Q2 14 5 14Q8.7 14 8.7 11Q8.7 8 5 7.5Q8.9 7.1 8.9 3.6Q8.9 0 5 0Q1.7 0 1 1.6" },
  "4": { advance: 11, d: "M6.9 0L6.9 14L1 4.4L9.5 4.4" },
  "5": { advance: 11, d: "M8.6 14L2 14L1.5 8.2Q3 9.2 5 9.2Q9 9.2 9 4.6Q9 0 5 0Q1.6 0 1 2" },
  "6": { advance: 11, d: "M8.6 12.4Q7.6 14 5 14Q1 14 1 7Q1 0 5 0Q9 0 9 4Q9 8 5 8Q1.8 8 1 5.4" },
  "7": { advance: 10, d: "M1 14L9 14L4 0" },
  "8": { advance: 11, d: "M5 7.5Q1.3 7.5 1.3 10.7Q1.3 14 5 14Q8.7 14 8.7 10.7Q8.7 7.5 5 7.5Q1 7.5 1 3.7Q1 0 5 0Q9 0 9 3.7Q9 7.5 5 7.5" },
  "9": { advance: 11, d: "M1.4 1.6Q2.4 0 5 0Q9 0 9 7Q9 14 5 14Q1 14 1 10Q1 6 5 6Q8.2 6 9 8.6" },
  ".": { advance: 5, d: "M2 0L2.6 0" },
  ",": { advance: 5, d: "M2.6 0.6L2.6 0Q2.6 -1.6 1.4 -2.4" },
  ":": { advance: 5, d: "M2 0L2.6 0 M2 7L2.6 7" },
  ";": { advance: 5, d: "M2 7L2.6 7 M2.6 0.6L2.6 0Q2.6 -1.6 1.4 -2.4" },
  "-": { advance: 9, d: "M1.4 7L7.6 7" },
  "_": { advance: 10, d: "M0.6 -2.5L9.4 -2.5" },
  "!": { advance: 5, d: "M2.3 14L2.3 4 M2.3 0L2.9 0" },
  "?": { advance: 10, d: "M1 11.4Q1 14 4.6 14Q8 14 8 11Q8 8.2 4.6 7.4L4.6 4.6 M4.6 0L5.2 0" },
  "'": { advance: 4, d: "M2 14L2 10.6" },
  "\"": { advance: 6, d: "M1.6 14L1.6 10.6 M4.4 14L4.4 10.6" },
  "/": { advance: 9, d: "M1 -1.5L8 15" },
  "\\": { advance: 9, d: "M1 15L8 -1.5" },
  "|": { advance: 5, d: "M2.4 -1.5L2.4 15" },
  "+": { advance: 11, d: "M5.2 2.4L5.2 11.6 M0.6 7L9.8 7" },
  "=": { advance: 11, d: "M0.6 9.2L9.8 9.2 M0.6 4.8L9.8 4.8" },
  "*": { advance: 9, d: "M4.2 12.6L4.2 5.4 M1.1 11L7.3 7 M7.3 11L1.1 7" },
  "#": { advance: 12, d: "M3.4 0L4.8 14 M7.2 0L8.6 14 M1 4.6L10.4 4.6 M1.4 9.4L10.8 9.4" },
  "(": { advance: 6, d: "M4.6 15Q1 11 1 6.8Q1 2.6 4.6 -1.5" },
  ")": { advance: 6, d: "M1.4 15Q5 11 5 6.8Q5 2.6 1.4 -1.5" },
  "[": { advance: 6, d: "M4.6 15L1.6 15L1.6 -1.5L4.6 -1.5" },
  "]": { advance: 6, d: "M1.4 15L4.4 15L4.4 -1.5L1.4 -1.5" },
  "{": { advance: 7, d: "M5 15Q3 15 3 12.4L3 8.6Q3 7 1 7Q3 7 3 5.4L3 1.6Q3 -1.5 5 -1.5" },
  "}": { advance: 7, d: "M2 15Q4 15 4 12.4L4 8.6Q4 7 6 7Q4 7 4 5.4L4 1.6Q4 -1.5 2 -1.5" },
  "<": { advance: 10, d: "M8.4 12L1.4 7L8.4 2" },
  ">": { advance: 10, d: "M1.6 12L8.6 7L1.6 2" },
  "%": { advance: 13, d: "M1.4 0L11.2 14 M3 14Q1 14 1 11.8Q1 9.6 3 9.6Q5 9.6 5 11.8Q5 14 3 14 M9.6 4.4Q7.6 4.4 7.6 2.2Q7.6 0 9.6 0Q11.6 0 11.6 2.2Q11.6 4.4 9.6 4.4" },
  "&": { advance: 13, d: "M11.4 0L4 0Q1 0 1 3Q1 5.6 4.4 7.4Q7.4 9 7.4 11.4Q7.4 14 5 14Q2.8 14 2.8 11.8Q2.8 9.4 6 6.4Q9.4 3.2 11.4 5.6" },
  "@": { advance: 14, d: "M9.6 5Q9.6 3 7.6 3Q5.6 3 5.6 5.6Q5.6 8.2 7.8 8.2Q9.6 8.2 9.6 5.6L9.6 3.4Q9.6 8.2 12 8.2Q13 8.2 13 5.6Q13 0 7 0Q1 0 1 6.4Q1 14 7.4 14Q11 14 12.4 12" },
  "$": { advance: 11, d: "M8.6 11.6Q8.6 13.6 5 13.6Q1.4 13.6 1.4 11Q1.4 8.4 5 7.6Q8.6 6.8 8.6 4Q8.6 1.4 5 1.4Q1.4 1.4 1.4 3.4 M5 15L5 0" },
  "^": { advance: 10, d: "M1.2 9.6L5 14L8.8 9.6" },
  "~": { advance: 11, d: "M1 6.4Q2.4 8.6 4.4 7.4Q6.4 6.2 7.8 7.4" },
  "`": { advance: 5, d: "M1.4 14L3.4 11.8" },
};

/**
 * A quadratic's furthest point from its chord is at the parameter midpoint, and it
 * sits exactly half way from the control point to the chord's midpoint. That gives
 * the maximum deviation in closed form, with no sampling and no bound to be
 * conservative about, which is why the flattener below does not need a fudge factor.
 */
export function quadraticMaxDeviation(p0: Point, p1: Point, p2: Point): number {
  const mx = (p0.x + p2.x) / 2;
  const my = (p0.y + p2.y) / 2;
  return Math.hypot(p1.x - mx, p1.y - my) / 2;
}

/**
 * Recursion depth cap. At 16 levels a subdivision has cut the curve into 65536
 * pieces, which no tolerance a plotter can express will ever need, and the cap is
 * what stops a degenerate control point turning a glyph into a hang.
 */
const MAX_FLATTEN_DEPTH = 16;

/** de Casteljau bisection. Appends every point after p0, so the caller keeps its pen. */
export function flattenQuadratic(
  p0: Point,
  p1: Point,
  p2: Point,
  out: Point[],
  tol: number,
  depth = 0,
): void {
  if (depth >= MAX_FLATTEN_DEPTH || quadraticMaxDeviation(p0, p1, p2) <= tol) {
    out.push(p2);
    return;
  }
  const a = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const b = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  flattenQuadratic(p0, a, m, out, tol, depth + 1);
  flattenQuadratic(m, b, p2, out, tol, depth + 1);
}

/**
 * Parallel copy of a polyline, offset by d along the averaged segment normals.
 *
 * Miter-perfect offsetting is overkill at sub-millimetre distances: averaged normals
 * stay inside the flattening tolerance everywhere a glyph bends, and a glyph that
 * bends harder than that has a corner, where a true miter would spike outward and
 * make the weight pass wider than the letter.
 */
export function offsetPolyline(pts: readonly Point[], d: number): Point[] {
  if (!d || pts.length < 2) return pts.map((p) => ({ x: p.x, y: p.y }));
  const n = pts.length;
  const out: Point[] = new Array<Point>(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(n - 1, i + 1)]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const p = pts[i]!;
    out[i] = { x: p.x - (dy / len) * d, y: p.y + (dx / len) * d };
  }
  return out;
}

/*
 * Flattening the same glyph at the same tolerance is pure, and a line of text asks
 * for it once per repeated character. The cache is cleared wholesale rather than
 * evicted by age: the key space is glyph times tolerance, a tolerance change
 * invalidates every entry at once, and an LRU would be more machinery than the
 * problem has.
 */
const GLYPH_CACHE = new Map<string, Stroke[]>();
const GLYPH_CACHE_MAX = 400;

const PATH_TOKENS = /[MLQ]|-?\d*\.?\d+/g;

/**
 * Flatten one glyph to polylines in FONT UNITS, at a tolerance also expressed in
 * font units. Returns null for a character the font does not have, which is what the
 * tofu box in `textToStrokes` keys off.
 */
export function glyphStrokes(
  ch: string,
  tol: number,
  glyphs: Readonly<Record<string, GlyphDef>> = GLYPHS,
): Stroke[] | null {
  /* The face is part of the cache key. Two faces share glyph names by definition,
   * so keying on the character alone hands the servo face's B back for the default
   * face's B, which shows up as one letter in the wrong proportions. */
  const key = `${glyphs === GLYPHS ? "d" : "s"}|${ch}|${tol.toFixed(4)}`;
  const hit = GLYPH_CACHE.get(key);
  if (hit) return hit;
  const def = glyphs[ch];
  if (!def) return null;

  const toks = def.d.match(PATH_TOKENS) ?? [];
  const subs: Stroke[] = [];
  let cur: Point[] | null = null;
  let i = 0;
  while (i < toks.length) {
    const c = toks[i]!;
    if (c === "M") {
      if (cur && cur.length > 1) subs.push(cur);
      cur = [{ x: Number(toks[i + 1]), y: Number(toks[i + 2]) }];
      i += 3;
    } else if (c === "L" && cur) {
      cur.push({ x: Number(toks[i + 1]), y: Number(toks[i + 2]) });
      i += 3;
    } else if (c === "Q" && cur) {
      const ctrl = { x: Number(toks[i + 1]), y: Number(toks[i + 2]) };
      const end = { x: Number(toks[i + 3]), y: Number(toks[i + 4]) };
      flattenQuadratic(cur[cur.length - 1]!, ctrl, end, cur, tol, 0);
      i += 5;
    } else i++;
  }
  if (cur && cur.length > 1) subs.push(cur);

  if (GLYPH_CACHE.size > GLYPH_CACHE_MAX) GLYPH_CACHE.clear();
  GLYPH_CACHE.set(key, subs);
  return subs;
}

/** Exposed so a test can prove the cache is not what makes tolerance look effective. */
export function clearGlyphCache(): void {
  GLYPH_CACHE.clear();
}

/**
 * Flattening error is spent from the same budget as everything else downstream, so
 * it takes a fraction of it rather than all of it. Sixty percent leaves room for the
 * quantiser, which is the other thing that moves a point off the ideal path.
 */
export const FLATTEN_TOLERANCE_FRACTION = 0.6;

/** Tofu advance in font units. Wide enough to read as a box and not as a letter. */
const TOFU_ADVANCE = 9;

export interface TextOptions {
  /** Cap height on the target, millimetres. This is what sets the overall size. */
  capMm?: number;
  /** Advance multiplier. 1 is the designed spacing; above 1 opens the letters up. */
  tracking?: number;
  /** Path tolerance on the target, millimetres. The plan's tolerance, not a fraction of it. */
  toleranceMm?: number;
  /**
   * Weight passes: 1, 2 or 3. Weight is LITERAL extra strokes, parallel passes a
   * fraction of a resolution step apart, so the beam genuinely covers more of the
   * target instead of retracing one skeleton line at a higher power.
   */
  weight?: number;
  /**
   * What one commandable step is worth on the target, millimetres. Sets the gap
   * between weight passes: closer than this and the passes land on the same
   * commandable positions and the letter is no fatter for twice the work.
   */
  resolutionMm?: number;
  /**
   * Which face to cut the text from.
   *
   * "servo" is condensed, and condensed is not a style preference on a machine with
   * a fixed absolute error: a narrower line fits at a larger cap height, and cap
   * height is the denominator that error is divided by. See font-servo.ts.
   */
  face?: "default" | "servo";
}

/* Weight gap bounds, millimetres. Below 0.35 the passes are inside a typical beam
 * width and merge into one line; above 1.0 they read as separate outlines rather
 * than as a bolder stroke. Both ends were found on the wall. */
const WEIGHT_GAP_MIN = 0.35;
const WEIGHT_GAP_MAX = 1.0;
const WEIGHT_GAP_FRACTION = 0.6;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Resolve a character to a glyph the font actually has.
 *
 * The font is mixed case, but a mixed case font with a gap reads worse than a
 * consistent one, so a missing lower case letter falls back to its capital and vice
 * versa before it falls back to tofu.
 */
function resolveGlyph(
  chRaw: string,
  glyphs: Readonly<Record<string, GlyphDef>> = GLYPHS,
): string | null {
  if (glyphs[chRaw]) return chRaw;
  const up = chRaw.toUpperCase();
  if (glyphs[up]) return up;
  const lo = chRaw.toLowerCase();
  if (glyphs[lo]) return lo;
  return null;
}

/**
 * Text to strokes, in target millimetres, y up, first line's baseline at y = 0 and
 * the pen starting at x = 0. Subsequent lines run downward.
 */
export function textToStrokes(text: string, opts: TextOptions = {}): SourceResult {
  const capMm = opts.capMm ?? 100;
  const tracking = opts.tracking ?? 1;
  const toleranceMm = opts.toleranceMm ?? 0.2;
  const weight = Math.max(1, Math.round(opts.weight ?? 1));
  const resolutionMm = opts.resolutionMm ?? 1;

  const glyphs = opts.face === "servo" ? SERVO_GLYPHS : GLYPHS;
  const metrics = opts.face === "servo" ? SERVO_METRICS : FONT_METRICS;

  const sc = capMm / metrics.cap;
  const lineStep = (metrics.cap - metrics.descender + metrics.lineGap) * sc;
  /* The tolerance arrives in millimetres on the target and the flattener works in
   * font units, so it is divided by the scale rather than used directly. This is the
   * whole reason a 200 mm letter gets more points than a 10 mm one. */
  const tol = Math.max(1e-4, (toleranceMm * FLATTEN_TOLERANCE_FRACTION) / Math.max(sc, 1e-6));

  const strokes: Stroke[] = [];
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const baseY = -li * lineStep;
    let penX = 0;
    for (const chRaw of line) {
      if (chRaw === " ") {
        penX += metrics.spaceAdvance * tracking;
        continue;
      }
      const ch = resolveGlyph(chRaw, glyphs);
      if (ch === null) {
        /* A box, so a glyph the font lacks is obvious on the wall rather than absent.
         * Silently skipping it is how a missing character becomes a spacing bug
         * nobody can see the cause of. */
        const x0 = penX + 1;
        const x1 = penX + TOFU_ADVANCE - 2;
        strokes.push(
          [
            [x0, 0],
            [x1, 0],
            [x1, metrics.cap],
            [x0, metrics.cap],
            [x0, 0],
          ].map(([x, y]) => ({ x: x! * sc, y: baseY + y! * sc })),
        );
        penX += TOFU_ADVANCE * tracking;
        continue;
      }
      const def = glyphs[ch]!;
      const subs = glyphStrokes(ch, tol, glyphs);
      if (subs) {
        for (const gs of subs) {
          strokes.push(gs.map((p) => ({ x: (penX + p.x) * sc, y: baseY + p.y * sc })));
        }
      }
      penX += def.advance * tracking;
    }
  }

  if (weight <= 1) return { strokes, bbox: bboxOf(strokes) };

  /* Passes alternate direction, which keeps the beam-off hop between one pass and
   * the next down to the offset gap instead of the whole length of the stroke. */
  const gap = clamp(resolutionMm * WEIGHT_GAP_FRACTION, WEIGHT_GAP_MIN, WEIGHT_GAP_MAX);
  const offsets = weight === 2 ? [-gap / 2, gap / 2] : [-gap, 0, gap];
  const fat: Stroke[] = [];
  for (const s of strokes) {
    offsets.forEach((d, i) => {
      const o = offsetPolyline(s, d);
      fat.push(i % 2 ? o.slice().reverse() : o);
    });
  }
  return { strokes: fat, bbox: bboxOf(fat) };
}
