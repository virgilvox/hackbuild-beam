import { describe, expect, it } from "vitest";
import { createDetent28byj } from "../profiles/detent-28byj.js";
import { createWasherServo } from "../profiles/washer-servo.js";
import { planJob } from "../planner/plan.js";
import { simulate, tracedRuns } from "./sim.js";
import type { Point } from "../types.js";

const P = (x: number, y: number): Point => ({ x, y });

const line = (from: Point, to: Point): Point[] => [from, to];

describe("simulate on the stepper rig", () => {
  it("with no slack the trace follows the plan to within the machine's own quantum", () => {
    const profile = createDetent28byj({ slackA: 0, slackB: 0 });
    const tl = planJob([line(P(-30, 0), P(30, 0))], profile);
    const sim = simulate(tl, profile);

    expect(sim.samples.length).toBeGreaterThan(10);
    expect(sim.truncated).toBe(false);
    /* Everything left is quantisation: the plan is in millimetres and the machine can
     * only stand on half steps. */
    const stepMm = profile.sampleStepMm(P(0, 0));
    expect(sim.worstMm).toBeLessThan(stepMm * 2);
  });

  it("backlash makes a retraced line miss its own path, which is the doubling you see", () => {
    /* Comp equal to slack cancels out. Comp of zero against real slack produces the
     * classic doubled line, and the spread is what that looks like as a number. */
    const clean = createDetent28byj({ slackA: 0, slackB: 0 });
    const slack = createDetent28byj({ slackA: 6, slackB: 6 });
    const there: Point[] = [P(-25, 0), P(25, 0)];
    const back: Point[] = [P(25, 0.4), P(-25, 0.4)];

    const a = simulate(planJob([there, back], clean, { merge: false }), clean);
    const b = simulate(planJob([there, back], slack, { merge: false }), slack);

    expect(b.spreadMm).toBeGreaterThan(a.spreadMm);
    /* Six half steps of slack, split either side of the shaft, is three half steps of
     * mirror error and the reversal spends all of it. */
    const stepMm = slack.sampleStepMm(P(0, 0));
    expect(b.worstMm).toBeGreaterThan(stepMm * 1.5);
  });

  it("is deterministic, because a model whose answer moves is not a model", () => {
    const profile = createDetent28byj({ slackA: 4, slackB: 2 });
    const tl = planJob([line(P(-20, -10), P(20, 10))], profile);
    const a = simulate(tl, profile);
    const b = simulate(tl, profile);
    expect(a.samples.length).toBe(b.samples.length);
    expect(a.spreadMm).toBe(b.spreadMm);
    expect(a.samples.map((s) => s.at.x)).toEqual(b.samples.map((s) => s.at.x));
  });
});

describe("simulate on the servo rig", () => {
  it("a worse servo traces a worse path, which is the reason the preset exists", () => {
    const cheap = createWasherServo({ servo: "micro9g" });
    const good = createWasherServo({ servo: "digital" });
    const strokes = [[P(-40, 0), P(40, 0), P(40, 30), P(-40, 30)]];

    const a = simulate(planJob(strokes, cheap), cheap);
    const b = simulate(planJob(strokes, good), good);

    expect(a.worstMm).toBeGreaterThan(b.worstMm);
    expect(a.meanMm).toBeGreaterThan(b.meanMm);
    expect(Number.isFinite(a.worstMm)).toBe(true);
  });

  it("lags the plan rather than teleporting to it, because a servo has mass", () => {
    const profile = createWasherServo({ servo: "micro9g" });
    const tl = planJob([line(P(-40, 0), P(40, 0))], profile);
    const sim = simulate(tl, profile);
    /* The trace starts where the plan starts and never arrives before it does. */
    const first = sim.samples[0]!;
    expect(Math.hypot(first.at.x - first.ideal.x, first.at.y - first.ideal.y)).toBeLessThan(1);
    expect(sim.meanMm).toBeGreaterThan(0);
    for (const s of sim.samples) {
      expect(Number.isFinite(s.at.x)).toBe(true);
      expect(Number.isFinite(s.at.y)).toBe(true);
    }
  });
});

describe("the shape of a simulation", () => {
  const profile = createDetent28byj();

  it("covers the whole job at the step size it was asked for", () => {
    const tl = planJob([line(P(-20, 0), P(20, 0))], profile);
    const sim = simulate(tl, profile, { dtSec: 0.002 });
    expect(sim.dtSec).toBe(0.002);
    const last = sim.samples[sim.samples.length - 1]!;
    expect(last.t).toBeGreaterThanOrEqual(tl.dur - 0.002);
    for (let i = 1; i < sim.samples.length; i++) {
      expect(sim.samples[i]!.t - sim.samples[i - 1]!.t).toBeCloseTo(0.002, 9);
    }
  });

  it("says so when it truncates rather than quietly showing half a drawing", () => {
    const tl = planJob([line(P(-40, -40), P(40, 40))], profile);
    const sim = simulate(tl, profile, { maxSamples: 20 });
    expect(sim.truncated).toBe(true);
    expect(sim.samples.length).toBe(20);
  });

  it("replays in emitted time, so the speed override is part of what is simulated", () => {
    const strokes = [line(P(-20, 0), P(20, 0))];
    const slow = planJob(strokes, profile);
    const fast = planJob(strokes, profile, { speed: 2 });
    const a = simulate(slow, profile, { dtSec: 0.002 });
    const b = simulate(fast, profile, { dtSec: 0.002 });
    expect(b.samples.length).toBeLessThan(a.samples.length * 0.6);
  });

  it("an empty job simulates to nothing rather than throwing", () => {
    const tl = planJob([], profile);
    const sim = simulate(tl, profile);
    expect(sim.samples).toEqual([]);
    expect(sim.spreadMm).toBe(0);
  });

  it("interpolation only shows where the command stream is sparse, and there it shows a lot", () => {
    /*
     * The board interpolates between commanded points: a span for the servo, Bresenham
     * for the stepper. On a normal job that makes almost no difference, because the
     * planner already samples below the machine's own quantum, and the two traces
     * agree to well inside one step. Worth knowing rather than assuming.
     *
     * Where it does matter is a sparse stream, which is what a long throw or a link
     * that has stretched its segments produces. Then step and hold is a visible
     * staircase and interpolation is the line the design asked for.
     */
    const near = planJob([line(P(-20, 0), P(20, 0))], profile);
    const heldNear = simulate(near, profile, { interpolate: false });
    const lerpedNear = simulate(near, profile, { interpolate: true });
    expect(heldNear.samples.length).toBe(lerpedNear.samples.length);
    expect(Math.abs(heldNear.meanMm - lerpedNear.meanMm)).toBeLessThan(
      profile.sampleStepMm(P(0, 0)),
    );

    const sparseRig = createDetent28byj({ throwMm: 2000, sepMm: 0 });
    const far = planJob([line(P(-60, 0), P(60, 0))], sparseRig, { denseMm: 12 });
    const held = simulate(far, sparseRig, { interpolate: false });
    const lerped = simulate(far, sparseRig, { interpolate: true });
    expect(held.meanMm).toBeGreaterThan(lerped.meanMm * 1.5);
  });

  it("tracedRuns splits at the gate so the preview never draws a travel move", () => {
    const tl = planJob([line(P(-30, 20), P(-10, 20)), line(P(10, -20), P(30, -20))], profile, {
      merge: false,
    });
    const sim = simulate(tl, profile);
    const runs = tracedRuns(sim);
    expect(runs.length).toBe(2);
    for (const r of runs) expect(r.length).toBeGreaterThan(1);
  });
});
