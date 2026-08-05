import { describe, expect, it } from "vitest";
import { SERVO_GLYPHS, SERVO_METRICS } from "./font-servo.js";
import { FONT_METRICS, GLYPHS, textToStrokes } from "./font.js";
import { bboxOf } from "./ops.js";

/*
 * The condensed face exists for one measurable reason, so that reason is what gets
 * tested. It is not a style: on a machine that misses by a fixed number of
 * millimetres, the only lever on legibility is cap height, and the only thing a
 * font controls is how much width a character costs.
 */

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function widthPerCap(text: string, face: "default" | "servo"): number {
  const r = textToStrokes(text, { capMm: 100, tracking: 1, toleranceMm: 0.2, face });
  const b = bboxOf(r.strokes);
  return (b.maxX - b.minX) / 100;
}

describe("the condensed face buys cap height", () => {
  it("is materially narrower than the default face", () => {
    /* Width is the whole point. A line of text one third shorter fits at a cap
     * height about a half larger, which is the entire quality argument. */
    for (const text of ["HACK.BUILD", "HELLO WORLD", "BEAM CONTROL"]) {
      const ratio = widthPerCap(text, "servo") / widthPerCap(text, "default");
      expect(ratio).toBeLessThan(0.8);
    }
  });

  it("keeps the same cap so the two faces are comparable without a scale factor", () => {
    expect(SERVO_METRICS.cap).toBe(FONT_METRICS.cap);
  });

  it("actually renders at the cap height it is given", () => {
    /* The bug that prompted all of this: a cap height control that did not set the
     * cap height. A capital has to be exactly as tall as it says. */
    for (const cap of [10, 40, 120]) {
      const r = textToStrokes("HH", { capMm: cap, tracking: 1, toleranceMm: 0.05, face: "servo" });
      const b = bboxOf(r.strokes);
      expect(b.maxY - b.minY).toBeCloseTo(cap, 1);
    }
  });
});

describe("the glyph set is fit to plot", () => {
  it("covers the alphabet and digits", () => {
    for (const ch of ALPHA) expect(SERVO_GLYPHS[ch], ch).toBeDefined();
  });

  it("draws no glyph with a zero length stroke", () => {
    /*
     * A dot written as a point is a mark the machine may never make: below about a
     * deadband the servo can sit in its dead zone and simply not move, so the
     * full stop is missing rather than small. Every stroke must have real travel.
     */
    for (const [ch, def] of Object.entries(SERVO_GLYPHS)) {
      if (!def.d) continue;
      const r = textToStrokes(ch, { capMm: 100, tracking: 1, toleranceMm: 0.2, face: "servo" });
      for (const st of r.strokes) {
        let len = 0;
        for (let i = 1; i < st.length; i++) {
          len += Math.hypot(st[i]!.x - st[i - 1]!.x, st[i]!.y - st[i - 1]!.y);
        }
        expect(len, `${ch} has a zero length stroke`).toBeGreaterThan(0.5);
      }
    }
  });

  it("uses no more strokes per glyph than the default face", () => {
    /*
     * Every pen down starts from rest and has to break out of the deadband, so a
     * stroke start is the worst part of a stroke. The condensed face is allowed to
     * match the default face's stroke count but never to exceed it.
     */
    for (const ch of ALPHA) {
      if (!GLYPHS[ch]) continue;
      const a = textToStrokes(ch, { capMm: 100, toleranceMm: 0.2, face: "default" }).strokes.length;
      const b = textToStrokes(ch, { capMm: 100, toleranceMm: 0.2, face: "servo" }).strokes.length;
      expect(b, `${ch}: servo ${b} strokes vs default ${a}`).toBeLessThanOrEqual(a);
    }
  });

  it("draws B, D, G, P and S without lifting", () => {
    /* The letters where a continuous path is available and the conventional
     * construction throws it away by retracing the spine. */
    for (const ch of "BDGPS") {
      const r = textToStrokes(ch, { capMm: 100, toleranceMm: 0.2, face: "servo" });
      expect(r.strokes.length, `${ch} should be one stroke`).toBe(1);
    }
  });

  it("stays inside its own advance, so letters do not collide", () => {
    for (const [ch, def] of Object.entries(SERVO_GLYPHS)) {
      if (!def.d) continue;
      const r = textToStrokes(ch, { capMm: 14, tracking: 1, toleranceMm: 0.05, face: "servo" });
      const b = bboxOf(r.strokes);
      /* A hair of overhang is normal on round letters that overshoot their box. */
      expect(b.maxX, `${ch} overruns its advance`).toBeLessThanOrEqual(def.advance + 1.1);
    }
  });
});
