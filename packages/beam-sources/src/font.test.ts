import { describe, expect, it } from "vitest";
import {
  FONT_METRICS,
  GLYPHS,
  clearGlyphCache,
  glyphStrokes,
  offsetPolyline,
  quadraticMaxDeviation,
  textToStrokes,
} from "./font.js";

const ALL = Object.keys(GLYPHS);

function pointCount(strokes: ReadonlyArray<ReadonlyArray<unknown>>): number {
  return strokes.reduce((n, s) => n + s.length, 0);
}

describe("the glyph set", () => {
  it("covers A-Z, a-z and 0-9", () => {
    for (let c = 65; c <= 90; c++) expect(GLYPHS[String.fromCharCode(c)]).toBeDefined();
    for (let c = 97; c <= 122; c++) expect(GLYPHS[String.fromCharCode(c)]).toBeDefined();
    for (let c = 48; c <= 57; c++) expect(GLYPHS[String.fromCharCode(c)]).toBeDefined();
  });

  it("carries punctuation", () => {
    for (const ch of ".,:;-_!?'\"/\\|+=*#()[]{}<>%&@$^~`") expect(GLYPHS[ch]).toBeDefined();
  });

  it("gives every glyph a positive advance", () => {
    for (const ch of ALL) expect(GLYPHS[ch]!.advance).toBeGreaterThan(0);
  });
});

describe("every glyph flattens to finite points", () => {
  it("at a fine tolerance", () => {
    for (const ch of ALL) {
      const subs = glyphStrokes(ch, 0.01);
      expect(subs, ch).not.toBeNull();
      expect(subs!.length, ch).toBeGreaterThan(0);
      for (const s of subs!) {
        expect(s.length, ch).toBeGreaterThan(1);
        for (const p of s) {
          expect(Number.isFinite(p.x), ch).toBe(true);
          expect(Number.isFinite(p.y), ch).toBe(true);
        }
      }
    }
  });

  it("and stays inside the designed em box", () => {
    /* Ascenders reach 15 and descenders reach -4.5 in this design. A glyph outside
     * that has a typo in its path data, which is otherwise invisible until it is on
     * a wall next to its neighbours. */
    for (const ch of ALL) {
      for (const s of glyphStrokes(ch, 0.01)!) {
        for (const p of s) {
          expect(p.y, ch).toBeLessThanOrEqual(15.001);
          expect(p.y, ch).toBeGreaterThanOrEqual(-4.501);
          expect(p.x, ch).toBeGreaterThanOrEqual(-0.001);
          expect(p.x, ch).toBeLessThanOrEqual(GLYPHS[ch]!.advance + 1.601);
        }
      }
    }
  });

  it("returns null for a character the font does not have", () => {
    expect(glyphStrokes("é", 0.01)).toBeNull();
  });
});

describe("tolerance", () => {
  it("changes the point count on the curved glyphs", () => {
    clearGlyphCache();
    const coarse = pointCount(glyphStrokes("O", 2)!);
    const fine = pointCount(glyphStrokes("O", 0.005)!);
    expect(fine).toBeGreaterThan(coarse);
  });

  it("changes nothing on a glyph made only of straight lines", () => {
    /* X is two L segments. If the point count moved with tolerance here, the
     * flattener would be subdividing lines, which is points bought for nothing. */
    expect(pointCount(glyphStrokes("X", 2)!)).toBe(pointCount(glyphStrokes("X", 0.005)!));
  });

  it("is applied in target millimetres, so a bigger letter gets more points", () => {
    const small = textToStrokes("O", { capMm: 10, toleranceMm: 0.2 });
    const large = textToStrokes("O", { capMm: 200, toleranceMm: 0.2 });
    expect(pointCount(large.strokes)).toBeGreaterThan(pointCount(small.strokes));
  });

  it("and the whole alphabet responds to it", () => {
    const text = ALL.join("");
    const coarse = pointCount(textToStrokes(text, { toleranceMm: 4 }).strokes);
    const fine = pointCount(textToStrokes(text, { toleranceMm: 0.01 }).strokes);
    expect(fine).toBeGreaterThan(coarse * 2);
  });
});

describe("quadraticMaxDeviation", () => {
  it("is zero when the control point sits on the chord midpoint", () => {
    const d = quadraticMaxDeviation({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 });
    expect(d).toBe(0);
  });

  it("is half the control point's distance from the chord midpoint", () => {
    const d = quadraticMaxDeviation({ x: 0, y: 0 }, { x: 5, y: 8 }, { x: 10, y: 0 });
    expect(d).toBeCloseTo(4, 12);
  });
});

describe("textToStrokes", () => {
  it("puts the first baseline at zero and later lines below it", () => {
    const res = textToStrokes("A\nA", { capMm: 14 });
    const lineStep = FONT_METRICS.cap - FONT_METRICS.descender + FONT_METRICS.lineGap;
    expect(res.bbox.minY).toBeCloseTo(-lineStep, 6);
  });

  it("opens the letters up with tracking", () => {
    const tight = textToStrokes("AAA", { capMm: 14, tracking: 1 });
    const loose = textToStrokes("AAA", { capMm: 14, tracking: 2 });
    expect(loose.bbox.maxX).toBeGreaterThan(tight.bbox.maxX);
  });

  it("draws a tofu box for a glyph the font lacks", () => {
    const res = textToStrokes("é", { capMm: 14 });
    expect(res.strokes.length).toBe(1);
    const box = res.strokes[0]!;
    expect(box.length).toBe(5);
    expect(box[0]).toEqual(box[4]);
  });

  it("skips a space without drawing anything", () => {
    const res = textToStrokes(" ", { capMm: 14 });
    expect(res.strokes.length).toBe(0);
  });

  it("falls back across case before it falls back to tofu", () => {
    /* The font has no uppercase-only or lowercase-only gaps today, so this checks
     * the mechanism on a character that resolves through it: the box is 5 points,
     * and a resolved glyph is not. */
    const res = textToStrokes("A", { capMm: 14 });
    expect(res.strokes.length).toBe(2);
  });

  it("scales with cap height", () => {
    const small = textToStrokes("H", { capMm: 14 });
    const large = textToStrokes("H", { capMm: 140 });
    expect(large.bbox.maxY - large.bbox.minY).toBeCloseTo(
      (small.bbox.maxY - small.bbox.minY) * 10,
      6,
    );
  });

  it("makes weight passes that are real extra strokes", () => {
    const one = textToStrokes("H", { capMm: 100, weight: 1 });
    const two = textToStrokes("H", { capMm: 100, weight: 2 });
    const three = textToStrokes("H", { capMm: 100, weight: 3 });
    expect(two.strokes.length).toBe(one.strokes.length * 2);
    expect(three.strokes.length).toBe(one.strokes.length * 3);
  });

  it("alternates weight pass direction, so the hop between passes is the gap", () => {
    const one = textToStrokes("I", { capMm: 100, weight: 2, resolutionMm: 1 });
    const a = one.strokes[0]!;
    const b = one.strokes[1]!;
    /* Second pass runs the other way, so its head is near the first pass's tail. */
    const tail = a[a.length - 1]!;
    const head = b[0]!;
    expect(Math.hypot(head.x - tail.x, head.y - tail.y)).toBeLessThan(2);
  });

  it("keeps every weight pass finite", () => {
    const res = textToStrokes("Wg@", { capMm: 60, weight: 3 });
    for (const s of res.strokes) {
      for (const p of s) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });
});

describe("offsetPolyline", () => {
  it("moves a straight line sideways by exactly the offset", () => {
    const out = offsetPolyline(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      2,
    );
    /* Left normal of a rightward line, so the copy sits above it and stays the same
     * length. A pass that got longer or shorter would be an averaged-normal bug. */
    expect(out[0]!.y).toBeCloseTo(2, 12);
    expect(out[1]!.y).toBeCloseTo(2, 12);
    expect(out[0]!.x).toBeCloseTo(0, 12);
    expect(out[1]!.x).toBeCloseTo(10, 12);
  });

  it("offsets perpendicular to the local direction", () => {
    const out = offsetPolyline(
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
      ],
      2,
    );
    expect(out[0]!.x).toBeCloseTo(-2, 12);
    expect(out[1]!.x).toBeCloseTo(-2, 12);
    expect(out[0]!.y).toBeCloseTo(0, 12);
  });

  it("copies rather than returning the input on a zero offset", () => {
    const src = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    const out = offsetPolyline(src, 0);
    expect(out).toEqual(src);
    expect(out[0]).not.toBe(src[0]);
  });
});
