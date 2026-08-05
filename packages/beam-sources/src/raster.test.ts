import { describe, expect, it } from "vitest";
import type { GrayImage } from "./index.js";
import { rasterToStrokes } from "./raster.js";

/*
 * The rasteriser takes a buffer, so the fixture is a buffer. No canvas, no image
 * decode, no jsdom: eight by four pixels written by hand, which is also small enough
 * that the expected runs can be worked out on paper and checked against.
 */

function gray(width: number, height: number, fill: number): GrayImage {
  return { width, height, data: new Uint8Array(width * height).fill(fill) };
}

/** A white image with columns 2..5 painted black on every row. */
function bandedImage(): GrayImage {
  const img = gray(8, 4, 255);
  for (let y = 0; y < 4; y++) {
    for (let x = 2; x <= 5; x++) img.data[y * 8 + x] = 0;
  }
  return img;
}

const OPTS = {
  widthMm: 8,
  heightMm: 4,
  pitchMm: 1,
  resolutionMm: 1,
};

describe("rasterToStrokes", () => {
  it("emits one run per row for a solid vertical band", () => {
    const res = rasterToStrokes(bandedImage(), OPTS);
    /* rows = floor(4 / 1) = 4, and the loop is inclusive, so five scan lines. */
    expect(res.strokes.length).toBe(5);
    for (const s of res.strokes) expect(s.length).toBe(2);
  });

  it("alternates direction row by row, which is the serpentine", () => {
    const res = rasterToStrokes(bandedImage(), OPTS);
    res.strokes.forEach((s, i) => {
      const a = s[0]!;
      const b = s[1]!;
      if (i % 2 === 0) expect(b.x).toBeGreaterThan(a.x);
      else expect(b.x).toBeLessThan(a.x);
    });
  });

  it("keeps every row on its own horizontal line, descending", () => {
    const res = rasterToStrokes(bandedImage(), OPTS);
    let prev = Infinity;
    for (const s of res.strokes) {
      expect(s[0]!.y).toBe(s[1]!.y);
      expect(s[0]!.y).toBeLessThan(prev);
      prev = s[0]!.y;
    }
  });

  it("sets noReorder, because reordering undoes the serpentine", () => {
    expect(rasterToStrokes(bandedImage(), OPTS).noReorder).toBe(true);
  });

  it("hands consecutive rows to each other, not back across the field", () => {
    /* The measurable consequence of the serpentine: the gap from the end of one row
     * to the start of the next is one pitch, not one pitch plus the whole width. */
    const res = rasterToStrokes(bandedImage(), OPTS);
    for (let i = 1; i < res.strokes.length; i++) {
      const end = res.strokes[i - 1]![1]!;
      const next = res.strokes[i]![0]!;
      expect(Math.hypot(next.x - end.x, next.y - end.y)).toBeLessThan(1.001);
    }
  });

  it("inverts which side of the threshold draws", () => {
    const img = bandedImage();
    const normal = rasterToStrokes(img, OPTS);
    const inverted = rasterToStrokes(img, { ...OPTS, invert: true });
    /* The band is one run per row. Its complement is the two margins, so inverting
     * turns five strokes into ten and puts them where the band was not. */
    expect(normal.strokes.length).toBe(5);
    expect(inverted.strokes.length).toBe(10);
    expect(inverted.strokes[0]![0]!.x).not.toBe(normal.strokes[0]![0]!.x);
  });

  it("drops runs shorter than the minimum", () => {
    const img = gray(8, 4, 255);
    for (let y = 0; y < 4; y++) img.data[y * 8 + 3] = 0;
    const kept = rasterToStrokes(img, { ...OPTS, minRunMm: 0.4 });
    const dropped = rasterToStrokes(img, { ...OPTS, minRunMm: 10 });
    expect(kept.strokes.length).toBeGreaterThan(0);
    expect(dropped.strokes.length).toBe(0);
  });

  it("closes a run that reaches the right edge", () => {
    const img = gray(8, 4, 255);
    for (let y = 0; y < 4; y++) {
      for (let x = 5; x < 8; x++) img.data[y * 8 + x] = 0;
    }
    const res = rasterToStrokes(img, OPTS);
    expect(res.strokes.length).toBe(5);
    for (const s of res.strokes) {
      const right = Math.max(s[0]!.x, s[1]!.x);
      expect(right).toBeCloseTo(4, 6);
    }
  });

  it("fits inside the box without distorting", () => {
    /* A tall image in a wide box is limited by the box height, and the drawn width
     * follows from the aspect ratio rather than filling the box. */
    const img = gray(4, 16, 0);
    const res = rasterToStrokes(img, { ...OPTS, widthMm: 40, heightMm: 20, pitchMm: 2 });
    const w = res.bbox.maxX - res.bbox.minX;
    expect(w).toBeLessThanOrEqual(20 * (4 / 16) + 1e-9);
  });

  it("returns nothing rather than throwing on a degenerate image", () => {
    const res = rasterToStrokes({ width: 0, height: 0, data: new Uint8Array(0) }, OPTS);
    expect(res.strokes.length).toBe(0);
    expect(res.noReorder).toBe(true);
  });
});
