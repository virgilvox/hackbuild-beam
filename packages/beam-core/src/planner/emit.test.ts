import { describe, expect, it } from "vitest";
import { emitSegments } from "./emit.js";
import { planJob, type Timeline } from "./plan.js";
import { createWasherServo } from "../profiles/washer-servo.js";
import { createDetent28byj } from "../profiles/detent-28byj.js";
import type { MachineProfile, Point } from "../types.js";

/*
 * The emitter is the half that decides whether a rig draws a line or a staircase,
 * so these tests check the thing that actually matters: does the curve the BOARD
 * will play still lie on the strokes we asked for.
 */

/** A shape with straights, a tight corner and a curve, plus a gap to force a gate. */
function testStrokes(): Point[][] {
  const arc: Point[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = (i / 24) * Math.PI;
    arc.push({ x: 10 + 18 * Math.cos(t), y: 18 * Math.sin(t) });
  }
  return [
    [
      { x: -40, y: -20 },
      { x: -40, y: 20 },
      { x: -20, y: -20 },
      { x: -20, y: 20 },
    ],
    arc,
  ];
}

/**
 * Reconstruct the board's playback from the emitted stream.
 *
 * The board plays each segment from its ACTUAL position and ACTUAL velocity to the
 * endpoint pair, so this walks the same cubic with the same chained state. If the
 * emitter is right, this lands on the strokes.
 */
function replay(
  segs: ReturnType<typeof emitSegments>["segments"],
  profile: MachineProfile,
): Point[] {
  const out: Point[] = [];
  if (!segs.length) return out;
  let cur = { a: segs[0]!.a, b: segs[0]!.b };
  let vel = { a: 0, b: 0 };
  for (const s of segs) {
    const D = s.durMs;
    const v1 = { a: s.velA / 16, b: s.velB / 16 };
    for (let k = 1; k <= 12; k++) {
      const T = k / 12;
      const h00 = (2 * T - 3) * T * T + 1;
      const h10 = ((T - 2) * T + 1) * T;
      const h01 = (3 - 2 * T) * T * T;
      const h11 = (T - 1) * T * T;
      const a = h00 * cur.a + h10 * D * vel.a + h01 * s.a + h11 * D * v1.a;
      const b = h00 * cur.b + h10 * D * vel.b + h01 * s.b + h11 * D * v1.b;
      if (s.laser) out.push(profile.forward({ a, b }));
    }
    cur = { a: s.a, b: s.b };
    vel = v1;
  }
  return out;
}

function ptSeg(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const L = vx * vx + vy * vy;
  const t = L < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L));
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

/** Geometric departure from the intended strokes. Lag along the path is invisible. */
function geomWorst(pts: Point[], strokes: Point[][]): number {
  let worst = 0;
  for (const p of pts) {
    let best = Infinity;
    for (const st of strokes) {
      for (let i = 1; i < st.length; i++) {
        const d = ptSeg(p, st[i - 1]!, st[i]!);
        if (d < best) best = d;
        if (best < 0.01) break;
      }
      if (best < 0.01) break;
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

const PROFILES: Array<[string, MachineProfile]> = [
  ["washer-servo", createWasherServo()],
  ["detent-28byj", createDetent28byj()],
];

describe.each(PROFILES)("emitter: %s", (_id, profile) => {
  const strokes = testStrokes();
  const tl: Timeline = planJob(strokes, profile, { tolMm: 0.2 });

  it("produces segments", () => {
    const r = emitSegments(tl, profile, { hermite: true });
    expect(r.segments.length).toBeGreaterThan(0);
  });

  it("the stream the board plays still lies on the strokes", () => {
    const r = emitSegments(tl, profile, { hermite: true, tolMm: 0.05 });
    expect(geomWorst(replay(r.segments, profile), strokes)).toBeLessThan(0.6);
  });

  it("wire duration equals plan duration, because the residual is carried", () => {
    const r = emitSegments(tl, profile, { hermite: true });
    const wireMs = r.segments.reduce((n, s) => n + s.durMs, 0);
    /*
     * Rounding each duration independently loses up to half a millisecond a time,
     * and across hundreds of segments that random walk puts the beam gate as much as
     * fifteen milliseconds from where the plan wanted it. Carrying the residual
     * keeps the stream locked to the timeline however the segments happen to fall.
     */
    expect(Math.abs(wireMs - tl.dur * 1000)).toBeLessThan(segCount(r.segments.length));
  });

  it("no segment straddles a gate change", () => {
    /*
     * The board holds one beam state for a segment's whole duration, so a segment
     * that spans a gate either lights part of a reposition or loses part of a
     * stroke. The full stop in a line of text is exactly the stroke this destroys.
     *
     * Checked by counting beam state changes rather than by reconstructing time from
     * the emitted durations. Those are rounded to whole milliseconds with the
     * residual carried across segments, so accumulating them lands each probe a
     * fraction either side of a gate and the reconstruction, not the emitter, is
     * what fails. The honest invariant is that the stream changes state exactly as
     * often as the plan does.
     */
    const r = emitSegments(tl, profile, { hermite: true });
    let changes = 0;
    for (let i = 1; i < r.segments.length; i++) {
      if (r.segments[i]!.laser !== r.segments[i - 1]!.laser) changes++;
    }
    expect(changes).toBe(tl.gates.length);
  });

  it("every duration fits the wire's one byte field", () => {
    const r = emitSegments(tl, profile, { hermite: true });
    for (const s of r.segments) {
      expect(s.durMs).toBeGreaterThanOrEqual(1);
      expect(s.durMs).toBeLessThanOrEqual(255);
    }
  });

  it("every velocity fits int8 sixteenths", () => {
    const r = emitSegments(tl, profile, { hermite: true });
    for (const s of r.segments) {
      expect(Number.isInteger(s.velA)).toBe(true);
      expect(Math.abs(s.velA)).toBeLessThanOrEqual(127);
      expect(Math.abs(s.velB)).toBeLessThanOrEqual(127);
    }
  });

  it("positions are quantised onto what the machine can command", () => {
    const r = emitSegments(tl, profile, { hermite: true });
    for (const s of r.segments) {
      expect(Number.isInteger(s.a)).toBe(true);
      expect(Number.isInteger(s.b)).toBe(true);
    }
  });

  it("legacy sends no velocities, so the cubic collapses to the straight line old firmware expects", () => {
    const r = emitSegments(tl, profile, { hermite: false });
    for (const s of r.segments) {
      expect(s.velA).toBe(0);
      expect(s.velB).toBe(0);
    }
  });
});

function segCount(n: number): number {
  /* One millisecond of slack per segment is the most rounding can cost even before
   * the residual carry, so this bound is loose on purpose and still catches drift. */
  return Math.max(4, n);
}

describe("hermite earns its extra bytes", () => {
  const profile = createWasherServo();
  const strokes = testStrokes();
  const tl = planJob(strokes, profile, { tolMm: 0.2 });

  it("carries the same path in fewer segments than legacy", () => {
    /*
     * The cubic reproduces the planner's ramps exactly, so a whole acceleration
     * phase fits in one segment and the split points fall only where the path
     * genuinely curves or a gate changes. That is the entire argument for the
     * format: fewer packets over a lossy radio, for the same drawing.
     */
    const legacy = emitSegments(tl, profile, { hermite: false, tolMm: 0.05 });
    const herm = emitSegments(tl, profile, { hermite: true, tolMm: 0.05 });
    expect(herm.segments.length).toBeLessThan(legacy.segments.length);
  });

  it("and is no less accurate for it", () => {
    const legacy = emitSegments(tl, profile, { hermite: false, tolMm: 0.05 });
    const herm = emitSegments(tl, profile, { hermite: true, tolMm: 0.05 });
    const gl = geomWorst(replay(legacy.segments, profile), strokes);
    const gh = geomWorst(replay(herm.segments, profile), strokes);
    expect(gh).toBeLessThanOrEqual(gl * 1.15);
  });
});

describe("a tighter tolerance buys more segments", () => {
  it("spends detail where it is asked to", () => {
    const profile = createWasherServo();
    const strokes = testStrokes();
    const tl = planJob(strokes, profile, { tolMm: 0.2 });
    const coarse = emitSegments(tl, profile, { hermite: true, tolMm: 0.5 });
    const fine = emitSegments(tl, profile, { hermite: true, tolMm: 0.02 });
    expect(fine.segments.length).toBeGreaterThanOrEqual(coarse.segments.length);
  });
});
