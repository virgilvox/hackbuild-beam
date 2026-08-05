import { describe, expect, it } from "vitest";
import {
  TESSERACT_W_PLANE,
  build3d,
  curveKnot,
  curveLissajous,
  curveSphere,
  modelCube,
  modelIcosahedron,
  modelTesseract,
  project,
  rot3,
  rot4,
  type ModelKind,
} from "./models3d.js";

describe("wireframes", () => {
  it("gives a cube 8 vertices and 12 edges", () => {
    const m = modelCube();
    expect(m.v.length).toBe(8);
    expect(m.e.length).toBe(12);
    expect(m.dim).toBe(3);
  });

  it("gives a tesseract 16 vertices and 32 edges", () => {
    const m = modelTesseract();
    expect(m.v.length).toBe(16);
    expect(m.e.length).toBe(32);
    expect(m.dim).toBe(4);
  });

  it("finds all 30 icosahedron edges by minimum distance", () => {
    /* The edge search is the point: an icosahedron is vertex transitive, so every
     * edge has the same length and the connectivity falls out of the geometry
     * instead of a hand written table that can be quietly wrong. */
    const m = modelIcosahedron();
    expect(m.v.length).toBe(12);
    expect(m.e.length).toBe(30);
  });

  it("gives every icosahedron vertex five neighbours", () => {
    const m = modelIcosahedron();
    const degree = new Array<number>(m.v.length).fill(0);
    for (const [a, b] of m.e) {
      degree[a]!++;
      degree[b]!++;
    }
    for (const d of degree) expect(d).toBe(5);
  });

  it("never repeats an edge", () => {
    for (const m of [modelCube(), modelTesseract(), modelIcosahedron()]) {
      const seen = new Set(m.e.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`));
      expect(seen.size).toBe(m.e.length);
    }
  });
});

describe("rotation", () => {
  it("leaves a point alone at zero angles", () => {
    expect(rot3([1, 2, 3], 0, 0, 0)).toEqual([1, 2, 3]);
  });

  it("preserves length", () => {
    const p = rot3([1, 2, 3], 0.4, -0.7, 1.9);
    expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(Math.sqrt(14), 12);
  });

  it("preserves length in four dimensions too", () => {
    const q = rot4([1, 2, 3, 4], 0.8);
    expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(Math.sqrt(30), 12);
  });

  it("leaves z alone under the 4D double rotation", () => {
    /* Both planes involve w, so z is untouched. If it moved, one of the two
     * rotations would be in the wrong plane. */
    expect(rot4([1, 2, 3, 4], 1.3)[2]).toBe(3);
  });
});

describe("project", () => {
  it("shrinks what is further away", () => {
    const near = project([1, 0, -0.5], 400);
    const far = project([1, 0, 0.5], 400);
    expect(near.x).toBeGreaterThan(far.x);
  });

  it("never divides by zero on a tesseract vertex, whatever the spin", () => {
    /* The double rotation mixes x and y into w, so w does not stay inside [-1, 1]:
     * its worst case is sqrt(3). The w plane at 2.6 keeps the divisor above 0.86 at
     * every angle. At a w plane of 1.0 a vertex would pass straight through the eye
     * point and throw the drawing to infinity mid-animation. */
    const verts = modelTesseract().v;
    let worst = Infinity;
    for (let t = 0; t < 40; t += 0.005) {
      for (const p of verts) {
        const q = rot4([p[0]!, p[1]!, p[2]!, p[3]!], t);
        worst = Math.min(worst, TESSERACT_W_PLANE + q[3]);
      }
    }
    expect(worst).toBeGreaterThan(TESSERACT_W_PLANE - Math.sqrt(3));
  });
});

describe("curves", () => {
  it("returns the knot and the lissajous as a single continuous stroke", () => {
    expect(curveKnot(1).length).toBe(1);
    expect(curveLissajous(1).length).toBe(1);
  });

  it("adds points with detail", () => {
    expect(curveKnot(4)[0]!.length).toBeGreaterThan(curveKnot(0)[0]!.length);
    expect(curveSphere(4).length).toBeGreaterThan(curveSphere(0).length);
  });

  it("keeps the sphere off its own poles", () => {
    /* A pole ring is a zero radius circle: many points at one place, which the
     * dedupe pass collapses to nothing after the planner has already paid for it. */
    for (const ring of curveSphere(2)) {
      let span = 0;
      for (const p of ring) span = Math.max(span, Math.hypot(p[0], p[2]));
      expect(span).toBeGreaterThan(1e-3);
    }
  });
});

const KINDS: ModelKind[] = ["cube", "tesseract", "ico", "knot", "lissa", "sphere"];

describe("build3d", () => {
  it("produces finite points for every model", () => {
    for (const kind of KINDS) {
      const res = build3d(kind, { yaw: 0.6, pitch: -0.3, roll: 0.2, spin: 1.1 });
      expect(res.strokes.length, kind).toBeGreaterThan(0);
      for (const s of res.strokes) {
        for (const p of s) {
          expect(Number.isFinite(p.x), kind).toBe(true);
          expect(Number.isFinite(p.y), kind).toBe(true);
        }
      }
    }
  });

  it("lands inside the requested size, centred", () => {
    for (const kind of KINDS) {
      const b = build3d(kind, { yaw: 0.4, sizeMm: 120 }).bbox;
      const w = b.maxX - b.minX;
      const h = b.maxY - b.minY;
      expect(Math.max(w, h), kind).toBeCloseTo(120, 6);
      expect(b.minX + b.maxX, kind).toBeCloseTo(0, 6);
      expect(b.minY + b.maxY, kind).toBeCloseTo(0, 6);
    }
  });

  it("gives each polyhedron edge its own stroke", () => {
    expect(build3d("cube").strokes.length).toBe(12);
    expect(build3d("ico").strokes.length).toBe(30);
    expect(build3d("tesseract").strokes.length).toBe(32);
  });

  it("turns the tesseract inside out as the spin advances", () => {
    const a = build3d("tesseract", { spin: 0 }).strokes;
    const b = build3d("tesseract", { spin: 1 }).strokes;
    expect(a[0]![0]!.x).not.toBeCloseTo(b[0]![0]!.x, 3);
  });
});
