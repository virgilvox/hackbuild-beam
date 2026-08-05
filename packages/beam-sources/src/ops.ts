/*
 * The three things every source needs after it has produced geometry: know how big
 * it is, put it where it belongs, and draw it in an order that does not waste the
 * beam-off travel.
 *
 * These are separate from the sources on purpose. Both shipped tools called
 * `centerFit` at the bottom of every generator, which meant a source could not be
 * used at its natural size without unpicking the normalisation it had already
 * applied. Here a source returns what it drew and the caller composes.
 */

import type { Point } from "@virgilvox/beam-core";
import type { Stroke } from "./index.js";

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** An empty stroke set has no extent, and reporting zeroes keeps callers branch free. */
export const EMPTY_BBOX: Bbox = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

export function bboxOf(strokes: readonly Stroke[]): Bbox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    for (const p of s) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { ...EMPTY_BBOX };
  return { minX, minY, maxX, maxY };
}

export function bboxWidth(b: Bbox): number {
  return b.maxX - b.minX;
}

export function bboxHeight(b: Bbox): number {
  return b.maxY - b.minY;
}

export function bboxCentre(b: Bbox): Point {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/**
 * Centre on the origin and normalise so the LARGER of the two spans is exactly 1.
 *
 * The single span, rather than one scale per axis, is what keeps a circle a circle.
 * Both shipped tools do this and both then multiply by a field fraction, so a "50
 * percent" design is half the short side of the target however tall or wide the
 * design happened to be.
 *
 * An empty or single-point input is returned unchanged rather than divided by a
 * zero span.
 */
export function centerFit(strokes: readonly Stroke[]): Stroke[] {
  const b = bboxOf(strokes);
  if (b.maxX < b.minX) return strokes.map((s) => s.map((p) => ({ x: p.x, y: p.y })));
  const c = bboxCentre(b);
  const span = Math.max(bboxWidth(b), bboxHeight(b)) || 1;
  return strokes.map((s) => s.map((p) => ({ x: (p.x - c.x) / span, y: (p.y - c.y) / span })));
}

/**
 * Normalised units to target millimetres.
 *
 * `minFieldMm` is the SHORT side of the drawable field, not the diagonal and not the
 * width. A design scaled against the long side runs off the top of a landscape
 * target at any percentage above about seventy, which is not what a percentage
 * control is understood to mean.
 */
export function scaleToField(
  strokes: readonly Stroke[],
  minFieldMm: number,
  percent: number,
): Stroke[] {
  const k = (minFieldMm * percent) / 100;
  return strokes.map((s) => s.map((p) => ({ x: p.x * k, y: p.y * k })));
}

/** Translate, for placing a design that is already at its natural size. */
export function translateStrokes(strokes: readonly Stroke[], dx: number, dy: number): Stroke[] {
  return strokes.map((s) => s.map((p) => ({ x: p.x + dx, y: p.y + dy })));
}

export interface OrderOptions {
  /**
   * Approach every stroke from its head, never from its tail.
   *
   * Reversing a stroke to save travel is free on a servo and is not free on a
   * stepper: the two directions differ by the gear backlash, so a design whose
   * strokes were drawn in whichever direction was nearest has some of its lines
   * offset from the others by the slack. Where repeatability matters more than
   * time, this trades one for the other.
   */
  unidirectional?: boolean;
  /** Where the beam is parked before the job starts. Both tools use the field centre. */
  start?: Point;
}

/**
 * Greedy nearest neighbour with optional reversal. Not optimal, and it does not
 * need to be: it is O(n^2) on stroke count rather than on point count, and it turns
 * an SVG that arrived in document order into one that does not cross the field
 * between every pair of letters.
 *
 * Comparison is on squared distance because the square root is monotonic and this
 * loop runs n^2 times.
 */
export function orderStrokes(strokes: readonly Stroke[], opts: OrderOptions = {}): Stroke[] {
  const uni = opts.unidirectional ?? false;
  if (strokes.length === 0) return [];
  const remaining: Stroke[] = strokes.map((s) => s.slice());
  const out: Stroke[] = [];
  let cur: Point = opts.start ?? { x: 0, y: 0 };
  while (remaining.length > 0) {
    let best = 0;
    let bestD = Infinity;
    let flip = false;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i]!;
      if (s.length === 0) continue;
      const head = s[0]!;
      const tail = s[s.length - 1]!;
      const dh = (head.x - cur.x) ** 2 + (head.y - cur.y) ** 2;
      if (dh < bestD) {
        bestD = dh;
        best = i;
        flip = false;
      }
      if (!uni) {
        const dt = (tail.x - cur.x) ** 2 + (tail.y - cur.y) ** 2;
        if (dt < bestD) {
          bestD = dt;
          best = i;
          flip = true;
        }
      }
    }
    let s = remaining.splice(best, 1)[0]!;
    if (flip) s = s.slice().reverse();
    out.push(s);
    const last = s[s.length - 1];
    if (last) cur = last;
  }
  return out;
}

/** Total beam-off distance, for the readout that tells you whether ordering helped. */
export function travelMm(strokes: readonly Stroke[], start: Point = { x: 0, y: 0 }): number {
  let total = 0;
  let cur = start;
  for (const s of strokes) {
    const head = s[0];
    if (!head) continue;
    total += Math.hypot(head.x - cur.x, head.y - cur.y);
    cur = s[s.length - 1]!;
  }
  return total;
}

/** Convenience for sources that build in tuples and hand back the public shape. */
export function toPoints(pairs: ReadonlyArray<readonly [number, number]>): Stroke {
  return pairs.map(([x, y]) => ({ x, y }));
}
