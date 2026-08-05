import { describe, expect, it } from "vitest";
import { STAR_INNER_RADIUS, buildShape, circle, grid, spiral, star, type ShapeKind } from "./shapes.js";

const KINDS: ShapeKind[] = ["circle", "star", "spiral", "grid"];

describe("shapes", () => {
  it("produce finite points and land on the requested size", () => {
    for (const kind of KINDS) {
      const res = buildShape(kind, { sizeMm: 80 });
      expect(res.strokes.length, kind).toBeGreaterThan(0);
      for (const s of res.strokes) {
        for (const p of s) {
          expect(Number.isFinite(p.x), kind).toBe(true);
          expect(Number.isFinite(p.y), kind).toBe(true);
        }
      }
      const w = res.bbox.maxX - res.bbox.minX;
      const h = res.bbox.maxY - res.bbox.minY;
      expect(Math.max(w, h), kind).toBeCloseTo(80, 9);
    }
  });

  it("centre on the origin", () => {
    for (const kind of KINDS) {
      const b = buildShape(kind).bbox;
      expect(b.minX + b.maxX, kind).toBeCloseTo(0, 9);
      expect(b.minY + b.maxY, kind).toBeCloseTo(0, 9);
    }
  });
});

describe("circle", () => {
  it("is round", () => {
    const s = circle({ sizeMm: 100 }).strokes[0]!;
    for (const p of s) expect(Math.hypot(p.x, p.y)).toBeCloseTo(50, 9);
  });

  it("closes", () => {
    const s = circle().strokes[0]!;
    expect(s[0]!.x).toBeCloseTo(s[s.length - 1]!.x, 9);
    expect(s[0]!.y).toBeCloseTo(s[s.length - 1]!.y, 9);
  });

  it("gains points with detail", () => {
    expect(circle({ detail: 5 }).strokes[0]!.length).toBeGreaterThan(
      circle({ detail: 0 }).strokes[0]!.length,
    );
  });
});

describe("star", () => {
  /* A star is not symmetric about its bbox centre, so radii are measured from the
   * mean of the five outer vertices, which is the star's own centre. */
  function centre(s: ReadonlyArray<{ x: number; y: number }>): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (let i = 0; i < 10; i += 2) {
      x += s[i]!.x;
      y += s[i]!.y;
    }
    return { x: x / 5, y: y / 5 };
  }

  it("alternates outer and inner radius at 0.42", () => {
    /* Not the geometric 0.382 of a true pentagram: at that figure the points are so
     * thin that a real beam width closes them up and the star reads as a blob. */
    const s = star({ sizeMm: 100 }).strokes[0]!;
    const c = centre(s);
    const outer = Math.hypot(s[0]!.x - c.x, s[0]!.y - c.y);
    const inner = Math.hypot(s[1]!.x - c.x, s[1]!.y - c.y);
    expect(inner / outer).toBeCloseTo(STAR_INNER_RADIUS, 9);
  });

  it("has eleven points, closing on the first", () => {
    const s = star().strokes[0]!;
    expect(s.length).toBe(11);
    expect(s[0]!.x).toBeCloseTo(s[10]!.x, 9);
    expect(s[0]!.y).toBeCloseTo(s[10]!.y, 9);
  });

  it("puts a point at the top, in y-up coordinates", () => {
    /* The shipped tool's quarter turn is the right sign for a y-down canvas, so the
     * star it draws on the wall has a point at the bottom. Everything in this
     * package is y up, and this is the test that keeps the sign that way. */
    const s = star({ sizeMm: 100 }).strokes[0]!;
    const c = centre(s);
    expect(s[0]!.x - c.x).toBeCloseTo(0, 9);
    expect(s[0]!.y - c.y).toBeGreaterThan(0);
  });
});

describe("spiral", () => {
  it("grows monotonically from its own centre", () => {
    /* The spiral starts at its centre, and centerFit moves that centre off the
     * origin because the figure's bbox is not centred on it. */
    const s = spiral({ sizeMm: 100 }).strokes[0]!;
    const c = s[0]!;
    let prev = -1;
    for (const p of s) {
      const r = Math.hypot(p.x - c.x, p.y - c.y);
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = r;
    }
    expect(prev).toBeGreaterThan(40);
  });
});

describe("grid", () => {
  it("is a full set of verticals and horizontals", () => {
    const res = grid({ detail: 1 });
    /* n = 4 + detail, inclusive, and one vertical plus one horizontal per station. */
    expect(res.strokes.length).toBe(2 * (4 + 1 + 1));
    for (const s of res.strokes) expect(s.length).toBe(2);
  });

  it("gains lines with detail", () => {
    expect(grid({ detail: 8 }).strokes.length).toBeGreaterThan(grid({ detail: 0 }).strokes.length);
  });
});
