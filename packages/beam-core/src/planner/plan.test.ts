import { describe, expect, it } from "vitest";
import { createDetent28byj } from "../profiles/detent-28byj.js";
import { createWasherServo } from "../profiles/washer-servo.js";
import { limitFromGain } from "./guards.js";
import {
  dedupeChain,
  densifyChain,
  filletChain,
  mergeStrokes,
  optimizePath,
  refineCurves,
  type Stroke,
} from "./path.js";
import {
  buildTimeline,
  gateTable,
  nextGate,
  planJob,
  resolvePlanOptions,
  sampleAt,
  type ChainMove,
  type Timeline,
} from "./plan.js";
import { JUNCTION_FLOOR_PULL_IN } from "./tuning.js";
import type { MachineProfile, Point } from "../types.js";

/*
 * The planner is the one component both rigs share, so almost every test here runs
 * against both profiles. Where they are asserted to differ, the difference is the
 * point: a servo stops dead at a reversal and a stepper holds its pull-in floor,
 * and a test that let both pass would be testing nothing.
 */

const P = (x: number, y: number): Point => ({ x, y });

const line = (from: Point, to: Point, n = 2): Point[] => {
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    out.push(P(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f));
  }
  return out;
};

const circle = (r: number, n: number, cx = 0, cy = 0): Point[] => {
  const out: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(P(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return out;
};

const chains = (tl: Timeline): ChainMove[] =>
  tl.moves.filter((m): m is ChainMove => m.kind === "chain");

const RIGS: ReadonlyArray<readonly [string, () => MachineProfile]> = [
  ["washer-servo", () => createWasherServo()],
  ["detent-28byj", () => createDetent28byj()],
];

describe.each(RIGS)("planJob on %s", (_id, make) => {
  const profile = make();

  it("plans a single stroke into one continuous chain that starts and ends at rest", () => {
    const tl = planJob([line(P(-30, 0), P(30, 0))], profile);
    const cs = chains(tl);
    expect(cs.length).toBe(1);
    const c = cs[0]!;
    expect(c.pts.length).toBeGreaterThan(10);
    expect(tl.dur).toBeGreaterThan(0);
    expect(Number.isFinite(tl.dur)).toBe(true);
    /* Travel from the parking origin to the stroke start, then the stroke. */
    expect(c.travLen).toBeGreaterThan(0);
    expect(c.drawLen).toBeGreaterThan(55);
  });

  it("never produces a NaN anywhere in the profile, which is the whole of INV-79 and INV-80", () => {
    /* A demanding job: a circle, a diagonal and a reversal, on both rigs, densified
     * below the quantum so consecutive samples collide after rounding. */
    const tl = planJob(
      [circle(25, 24), line(P(-40, -40), P(40, 40)), [P(20, 0), P(-20, 0), P(20, 0)]],
      profile,
    );
    for (const c of chains(tl)) {
      for (let i = 0; i < c.pts.length; i++) {
        expect(Number.isFinite(c.v[i]!)).toBe(true);
        expect(Number.isFinite(c.t[i]!)).toBe(true);
        expect(c.v[i]!).toBeGreaterThanOrEqual(0);
      }
      for (let i = 1; i < c.t.length; i++) {
        expect(c.t[i]!).toBeGreaterThanOrEqual(c.t[i - 1]!);
      }
      expect(c.dur).toBeGreaterThan(0);
    }
    expect(Number.isFinite(tl.dur)).toBe(true);
    expect(tl.dur).toBeGreaterThan(0);
  });

  it("emits no zero length axis segment, because the guard runs before the wire does", () => {
    const tl = planJob([circle(25, 24), line(P(-40, -40), P(40, 40))], profile);
    expect(tl.plan.length).toBeGreaterThan(10);
    for (let i = 1; i < tl.plan.length; i++) {
      const a = tl.plan[i - 1]!;
      const b = tl.plan[i]!;
      const moved = profile.arcLength(a.axis, b.axis) > 0;
      /* Either the machine moves, or the beam changes state at one coordinate, which
       * is how a dot is drawn. Never neither. */
      expect(moved || a.laser !== b.laser).toBe(true);
    }
  });

  it("keeps every commanded pair on the machine's own grid", () => {
    const tl = planJob([circle(20, 16)], profile);
    for (const p of tl.plan) {
      expect(p.axis).toEqual(profile.quantise(p.axis));
    }
  });

  it("respects the derated ceiling even when the caller asks for more", () => {
    /* A stepper past pull-out loses steps silently, so this cap is not negotiable. */
    const tl = planJob([line(P(-40, -20), P(40, 20))], profile, {
      drawAxisRate: 1e6,
      travelAxisRate: 1e6,
      feedMmS: 1e5,
      travelMmS: 1e5,
    });
    const ceiling = profile.limits.maxRate * profile.limits.derate;
    expect(tl.options.axisRateCeiling).toBeCloseTo(ceiling, 9);
    for (const c of chains(tl)) {
      for (let i = 0; i < c.pen.length; i++) {
        const k = profile.sensitivity(c.pts[i]!, c.pts[i + 1]!, null);
        const axisRate = Math.max(c.v[i]!, c.v[i + 1]!) * k;
        expect(axisRate).toBeLessThanOrEqual(ceiling * 1.001);
      }
    }
  });

  it("carries the rounding residual so a job's milliseconds never drift", () => {
    /* INV-29. Rounding each span independently loses up to half a millisecond a time,
     * and several hundred points of that random walk put the beam gate 15 ms from
     * where the plan wanted it. */
    const tl = planJob([circle(25, 40), line(P(-30, 30), P(30, -30))], profile);
    let sum = 0;
    for (const p of tl.plan) sum += p.durMs;
    expect(Math.abs(sum - tl.dur * 1000)).toBeLessThan(1);
    for (const p of tl.plan) expect(Number.isInteger(p.durMs)).toBe(true);
  });

  it("the speed override divides the span and leaves the geometry alone, INV-85", () => {
    const strokes = [circle(20, 24)];
    const slow = planJob(strokes, profile);
    const fast = planJob(strokes, profile, { speed: 2 });
    expect(fast.dur).toBeCloseTo(slow.dur, 9);
    let slowMs = 0;
    let fastMs = 0;
    for (const p of slow.plan) slowMs += p.durMs;
    for (const p of fast.plan) fastMs += p.durMs;
    expect(fastMs).toBeGreaterThan(0);
    expect(fastMs / slowMs).toBeCloseTo(0.5, 2);
    expect(fast.plan.length).toBe(slow.plan.length);
  });
});

describe("the gate table, which is a table and never a sample", () => {
  const profile = createWasherServo();

  it("one stroke lights the beam once and never cuts it before the job ends", () => {
    const tl = planJob([line(P(-30, 0), P(30, 0))], profile);
    expect(tl.gates.length).toBe(1);
    expect(tl.gates[0]!).toBeGreaterThan(0);
    expect(tl.gates[0]!).toBeLessThan(tl.dur);
  });

  it("two separated strokes give on, off, on", () => {
    const tl = planJob([line(P(-40, 20), P(-10, 20)), line(P(10, -20), P(40, -20))], profile, {
      merge: false,
    });
    expect(tl.gates.length).toBe(3);
    for (let i = 1; i < tl.gates.length; i++) {
      expect(tl.gates[i]!).toBeGreaterThan(tl.gates[i - 1]!);
    }
  });

  it("a stroke shorter than one segment survives: that is the full stop in a line of text", () => {
    /*
     * This is the bug the table exists for. An emitter that decides the gate by
     * comparing the state at a segment's two ends reads off before and off after, with
     * the whole stroke invisible in between, and the full stop disappears from the
     * wall.
     */
    const stop: Stroke = [P(30, -18), P(30.1, -18)];
    const tl = planJob([line(P(-30, 0), P(20, 0)), stop], profile, { merge: false });

    expect(tl.gates.length).toBe(3); // on for the line, off, on for the full stop
    const lit = tl.plan.filter((p) => p.laser);
    expect(lit.length).toBeGreaterThan(0);

    /* The dot is present as a real commanded point at the full stop's own position. */
    const want = profile.quantise(profile.inverse(P(30, -18)));
    const atDot = tl.plan.filter((p) => p.axis.a === want.a && p.axis.b === want.b);
    expect(atDot.some((p) => p.laser)).toBe(true);
  });

  it("nextGate finds the following transition and Infinity past the last one", () => {
    const tl = planJob([line(P(-40, 20), P(-10, 20)), line(P(10, -20), P(40, -20))], profile, {
      merge: false,
    });
    expect(nextGate(tl, -1)).toBe(tl.gates[0]!);
    expect(nextGate(tl, tl.gates[0]!)).toBe(tl.gates[1]!);
    expect(nextGate(tl, tl.dur)).toBe(Infinity);
  });

  it("reads the gates off the moves, holds included", () => {
    const gates = gateTable([
      { kind: "hold", at: P(0, 0), laser: false, t0: 0, dur: 0.1 },
      { kind: "hold", at: P(0, 0), laser: true, t0: 0.1, dur: 0.06 },
      { kind: "hold", at: P(1, 1), laser: false, t0: 0.16, dur: 0.06 },
    ]);
    expect(gates).toEqual([0.1, 0.16]);
  });
});

describe("junction cost is profile supplied, not shared", () => {
  /*
   * The two rigs disagree about what a reversal costs and the disagreement is
   * physical. A servo decelerates to zero: the gear slop is taken up as a knock and
   * arriving with speed on is what makes it loud. A stepper holds its pull-in rate,
   * because below that there is nothing left to gain.
   */
  const reversal: Stroke[] = [[P(-25, 0), P(25, 0), P(-25, 0.2)]];

  const interiorMin = (tl: Timeline): number => {
    let lo = Infinity;
    for (const c of chains(tl)) {
      for (let i = 1; i < c.v.length - 1; i++) lo = Math.min(lo, c.v[i]!);
    }
    return lo;
  };

  it("a servo comes to a genuine stop at the reversal", () => {
    const tl = planJob(reversal, createWasherServo(), { merge: false });
    expect(interiorMin(tl)).toBeLessThan(5);
  });

  it("a stepper never goes below its pull-in floor", () => {
    const profile = createDetent28byj();
    const tl = planJob(reversal, profile, { merge: false });
    const k = profile.sensitivity(P(24, 0), P(25, 0), null);
    const floorMmS = limitFromGain(JUNCTION_FLOOR_PULL_IN, k);
    expect(interiorMin(tl)).toBeGreaterThan(floorMmS * 0.6);
    expect(floorMmS).toBeGreaterThan(0);
  });

  it("the floor is an option, so a bench that measures a different pull-in can say so", () => {
    const profile = createDetent28byj();
    const slow = planJob(reversal, profile, { merge: false, junctionFloorAxisRate: 0 });
    const fast = planJob(reversal, profile, { merge: false });
    expect(interiorMin(slow)).toBeLessThan(interiorMin(fast));
    /* And holding the floor is the faster job, which is the reason it exists. */
    expect(fast.dur).toBeLessThan(slow.dur);
  });

  it("the floor never speeds a segment past its own cap", () => {
    const profile = createDetent28byj();
    const tl = planJob(reversal, profile, {
      merge: false,
      junctionFloorAxisRate: 1e6,
    });
    const ceiling = profile.limits.maxRate * profile.limits.derate;
    for (const c of chains(tl)) {
      for (let i = 0; i < c.pen.length; i++) {
        const k = profile.sensitivity(c.pts[i]!, c.pts[i + 1]!, null);
        expect(Math.max(c.v[i]!, c.v[i + 1]!) * k).toBeLessThanOrEqual(ceiling * 1.001);
      }
    }
  });
});

describe("sampleAt", () => {
  const profile = createWasherServo();

  it("walks the path monotonically and lands on both endpoints", () => {
    const tl = planJob([line(P(-30, 5), P(30, 5))], profile);
    const a = sampleAt(tl, 0);
    expect(a.at.x).toBeCloseTo(0, 6);
    expect(a.at.y).toBeCloseTo(0, 6);
    expect(a.v).toBe(0);

    const z = sampleAt(tl, tl.dur);
    expect(z.at.x).toBeCloseTo(30, 3);
    expect(z.at.y).toBeCloseTo(5, 3);

    let last = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const s = sampleAt(tl, (tl.dur * i) / 200);
      expect(Number.isFinite(s.at.x)).toBe(true);
      expect(Number.isFinite(s.v)).toBe(true);
      if (s.laser) {
        expect(s.at.x).toBeGreaterThanOrEqual(last - 1e-9);
        last = s.at.x;
      }
    }
  });

  it("agrees with the gate table about when the beam is on", () => {
    const tl = planJob([line(P(-30, 0), P(30, 0))], profile);
    const g = tl.gates[0]!;
    expect(sampleAt(tl, g - 1e-4).laser).toBe(false);
    expect(sampleAt(tl, g + 1e-4).laser).toBe(true);
  });

  it("answers for an empty job rather than throwing", () => {
    const tl = planJob([], profile);
    expect(tl.dur).toBe(0);
    expect(sampleAt(tl, 0)).toEqual({ at: P(0, 0), laser: false, v: 0 });
  });
});

describe("dots", () => {
  it("a single point stroke is burned as a hold at the end of the job", () => {
    const profile = createWasherServo();
    const tl = planJob([line(P(-20, 0), P(20, 0)), [P(5, 25)]], profile);
    const holds = tl.moves.filter((m) => m.kind === "hold");
    expect(holds.length).toBe(1);
    expect(tl.dur).toBeGreaterThan(0.06);
  });

  it("a job of nothing but dots is still a job", () => {
    const tl = planJob([[P(1, 1)], [P(-1, -1)]], createDetent28byj());
    expect(tl.moves.length).toBe(2);
    expect(tl.dur).toBeCloseTo(0.12, 9);
    expect(tl.plan.length).toBeGreaterThan(0);
    expect(tl.plan.every((p) => p.laser)).toBe(true);
  });
});

describe("the geometry stages", () => {
  it("refineCurves puts the curve back into a faceted circle and leaves corners alone", () => {
    const octagon = circle(20, 8);
    const refined = refineCurves([octagon], 0.05)[0]!;
    expect(refined.length).toBeGreaterThan(octagon.length * 3);
    /* Every refined point is on the circle it was cut from, within the tolerance the
     * refinement was asked for plus the faceting it started with. */
    for (const p of refined) {
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(17);
      expect(Math.hypot(p.x, p.y)).toBeLessThan(21);
    }

    const corner: Stroke = [P(-10, 0), P(0, 0), P(0, 10)];
    const kept = refineCurves([corner], 0.05)[0]!;
    /* A 90 degree turn is a corner, not a curve, and the vertex must survive. */
    expect(kept.some((p) => Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9)).toBe(true);
  });

  it("mergeStrokes joins strokes that share an endpoint and leaves the rest alone", () => {
    const a: Stroke = [P(0, 0), P(10, 0)];
    const b: Stroke = [P(10, 0.1), P(10, 10)];
    const far: Stroke = [P(50, 50), P(60, 50)];
    const out = mergeStrokes([a, b, far], 0.35);
    expect(out.length).toBe(2);
    /* The shared endpoint is spent, not duplicated: three points, one chain. */
    expect(out[0]!.length).toBe(3);
    expect(out[0]![2]).toEqual(P(10, 10));
    expect(out[1]!.length).toBe(2);
  });

  it("mergeStrokes reverses a stroke to make the join", () => {
    const a: Stroke = [P(0, 0), P(10, 0)];
    const b: Stroke = [P(20, 0), P(10, 0)];
    const out = mergeStrokes([a, b], 0.35);
    expect(out.length).toBe(1);
    expect(out[0]![out[0]!.length - 1]).toEqual(P(20, 0));
  });

  it("optimizePath leaves fewer than three strokes exactly as they came", () => {
    const a: Stroke = [P(40, 40), P(41, 40)];
    const b: Stroke = [P(1, 1), P(2, 1)];
    const out = optimizePath([a, b]);
    expect(out[0]![0]).toEqual(P(40, 40));
  });

  it("optimizePath walks nearest neighbour from the origin and reverses where it helps", () => {
    const far: Stroke = [P(40, 40), P(41, 40)];
    const near: Stroke = [P(2, 0), P(1, 0)];
    const mid: Stroke = [P(10, 0), P(11, 0)];
    const out = optimizePath([far, mid, near]);
    expect(out[0]![0]).toEqual(P(1, 0)); // reversed so the near end comes first
    expect(out[1]![0]).toEqual(P(10, 0));
    expect(out[2]![0]).toEqual(P(40, 40));
  });

  it("filletChain never rounds a vertex where the beam gate changes", () => {
    const pts = [P(-10, 0), P(0, 0), P(0, 10)];
    const rounded = filletChain(pts, [true, true], 2);
    expect(rounded.pts.some((p) => Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9)).toBe(false);

    const gated = filletChain(pts, [false, true], 2);
    expect(gated.pts.some((p) => Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9)).toBe(true);
    expect(gated.pen.length).toBe(gated.pts.length - 1);
  });

  it("filletChain measures flatness against the last point kept, not the input neighbour", () => {
    /*
     * The regression that cost a letter D its bowl. On a gently curving run every
     * vertex is nearly straight relative to the one before it, so testing against the
     * neighbour drops them one after another and the output jumps from the start of
     * the curve to the end: 106 points became 11 and the bowl became a chord.
     */
    const arc = circle(20, 200).slice(0, 100);
    const pen = new Array<boolean>(arc.length - 1).fill(true);
    const out = filletChain(arc, pen, 0.3);
    expect(out.pts.length).toBeGreaterThan(arc.length * 0.5);
    for (const p of out.pts) expect(Math.hypot(p.x, p.y)).toBeGreaterThan(19);
  });

  it("dedupeChain keeps the more permissive gate across a collapse", () => {
    const pts = [P(0, 0), P(0.001, 0), P(1, 0)];
    const out = dedupeChain(pts, [true, false], 0.02);
    expect(out.pts.length).toBe(2);
    expect(out.pen).toEqual([true]);
  });

  it("densifyChain asks the machine how fine to sample", () => {
    const profile = createDetent28byj();
    const step = Math.min(0.25, profile.sampleStepMm(P(0, 0)));
    const out = densifyChain([P(-10, 0), P(10, 0)], [true], () => step);
    expect(out.pts.length).toBe(Math.ceil(20 / step) + 1);
    expect(out.pen.length).toBe(out.pts.length - 1);
    for (let i = 1; i < out.pts.length; i++) {
      expect(out.pts[i]!.x - out.pts[i - 1]!.x).toBeLessThanOrEqual(step + 1e-9);
    }
  });
});

describe("settle dwells", () => {
  it("a settle splits the chain into a real pause and only before the beam lights", () => {
    const profile = createWasherServo();
    const strokes = [line(P(-40, 20), P(-20, 20)), line(P(20, -20), P(40, -20))];
    const none = planJob(strokes, profile, { merge: false, settleMs: 0 });
    const rest = planJob(strokes, profile, { merge: false, settleMs: 120 });
    expect(none.moves.filter((m) => m.kind === "hold").length).toBe(0);
    const holds = rest.moves.filter((m) => m.kind === "hold");
    expect(holds.length).toBeGreaterThan(0);
    expect(rest.dur).toBeGreaterThan(none.dur + 0.1);
    for (const h of holds) expect(h.kind === "hold" && h.laser).toBe(false);
  });
});

describe("plan options", () => {
  it("defaults the junction floor from the profile and nowhere else", () => {
    expect(resolvePlanOptions(createWasherServo()).junctionFloorAxisRate).toBe(0);
    expect(resolvePlanOptions(createDetent28byj()).junctionFloorAxisRate).toBe(
      JUNCTION_FLOOR_PULL_IN,
    );
  });

  it("clamps a feed that would make the timeline meaningless", () => {
    const o = resolvePlanOptions(createWasherServo(), {
      feedMmS: Number.POSITIVE_INFINITY,
      accelMmS2: 0,
      denseMm: 0,
    });
    expect(Number.isFinite(o.feedMmS)).toBe(true);
    expect(o.accelMmS2).toBeGreaterThan(0);
    expect(o.denseMm).toBeGreaterThan(0);
  });

  it("buildTimeline can be driven directly with resolved options", () => {
    const profile = createDetent28byj();
    const o = resolvePlanOptions(profile, { settleMs: 0 });
    const tl = buildTimeline([line(P(-20, 0), P(20, 0))], profile, o);
    expect(tl.dur).toBeGreaterThan(0);
    expect(tl.axisLen).toBeGreaterThan(0);
    expect(tl.options).toBe(o);
  });
});

describe("INV-81, the feed cap keeps the unit the machine was tuned in", () => {
  it("a diagonal paces its dominant axis, so it runs faster in millimetres than an axis move", () => {
    /*
     * The stepper paces its dominant axis, so a diagonal covers root two millimetres
     * for every millimetre of axis travel, deliberately, with no cross axis
     * normalisation. Expressing the cap as feed_mm times gain makes every diagonal
     * about 1.42 times slower than the shipped tool for no safety benefit, because
     * pull-out is a step rate and the dominant axis is already at it.
     */
    const profile = createDetent28byj();
    const rate = 400;
    const opts = { drawAxisRate: rate, travelAxisRate: rate, feedMmS: 1e5, merge: false };
    const straight = planJob([line(P(-30, 0), P(30, 0))], profile, opts);
    const diagonal = planJob([line(P(-21.2, -21.2), P(21.2, 21.2))], profile, opts);

    /* The dominant axis runs at the rate the operator set, on both jobs. That is the
     * number the bench was tuned in and it survives the round trip untouched. */
    const dominantRate = (tl: Timeline): number => {
      let hi = 0;
      for (const c of chains(tl)) {
        for (let i = 0; i < c.pen.length; i++) {
          if (!c.pen[i]) continue;
          const k = profile.sensitivity(c.pts[i]!, c.pts[i + 1]!, null);
          hi = Math.max(hi, c.v[i]! * k);
        }
      }
      return hi;
    };
    /* Within a percent, not exactly: the gain is a secant taken per segment and it
     * varies across the field, so the binding segment is the one whose local gain is
     * highest and the rest sit just under. */
    expect(dominantRate(straight) / rate).toBeGreaterThan(0.99);
    expect(dominantRate(straight) / rate).toBeLessThan(1.001);
    expect(dominantRate(diagonal) / rate).toBeGreaterThan(0.99);
    expect(dominantRate(diagonal) / rate).toBeLessThan(1.001);

    /* Same axis rate, but the diagonal covers more millimetres per second because
     * both axes are moving. Normalising it away would make every diagonal slower for
     * no safety benefit: pull-out is a step rate and the dominant axis is already at
     * it. The gain is under root two here only because the two mirrors sit at
     * different lever arms, which is the geometry doing its job. */
    expect(diagonal.peak).toBeGreaterThan(straight.peak * 1.15);
    expect(diagonal.peak).toBeLessThan(straight.peak * Math.SQRT2 * 1.01);
  });
});
