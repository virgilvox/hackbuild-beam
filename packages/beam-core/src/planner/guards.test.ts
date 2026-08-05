import { describe, expect, it } from "vitest";
import { dedupeQuantised, limitFromGain, quantisePath, type PlannedPoint } from "./guards.js";
import { createDetent28byj } from "../profiles/detent-28byj.js";
import { createWasherServo } from "../profiles/washer-servo.js";
import type { MachineProfile, Point } from "../types.js";

/*
 * These tests exist because an adversarial review of the merged design found that
 * dropping either guard produces a job that never advances, on the first stroke a
 * stepper rig ever plots. Both guards are present in the shipped tools. Neither
 * looks like it is doing anything.
 */

describe("limitFromGain, INV-80", () => {
  it("returns a real limit for a real gain", () => {
    expect(limitFromGain(400, 2)).toBe(200);
  });

  it("returns Infinity rather than NaN when the gain vanishes", () => {
    expect(limitFromGain(400, 0)).toBe(Infinity);
    expect(limitFromGain(400, 1e-15)).toBe(Infinity);
  });

  it("Infinity is absorbed by Math.min and NaN is not, which is the whole point", () => {
    /* This is the failure mode, stated as arithmetic. One poisoned cap is enough. */
    expect(Math.min(400, Infinity)).toBe(400);
    expect(Math.min(400, NaN)).toBeNaN();
    expect(Math.min(400, 0 / 0)).toBeNaN();
  });

  it("a NaN cap would propagate through both sweeps and the timing integration", () => {
    /* Reproduce the poisoning explicitly so the consequence is on record and not
     * merely asserted in a comment. */
    const caps = [400, 400, 0 / 0, 400, 400];
    const v = caps.slice();
    for (let i = 1; i < v.length; i++) v[i] = Math.min(v[i]!, Math.sqrt(v[i - 1]! ** 2 + 2 * 3000 * 10));
    expect(v.slice(2).every(Number.isNaN)).toBe(true);

    /* And the timing loop never advances past it, because the guard clause is false
     * for NaN in both directions. */
    let t = 0;
    for (let i = 2; i < v.length - 1; i++) {
      t += v[i]! + v[i + 1]! > 1e-9 ? 20 / (v[i]! + v[i + 1]!) : 0;
    }
    expect(t).toBe(0);
  });
});

describe("dedupeQuantised, INV-79", () => {
  it("collapses consecutive samples that land on the same commandable position", () => {
    const pts: PlannedPoint[] = [
      { axis: { a: 10, b: 5 }, laser: true },
      { axis: { a: 10, b: 5 }, laser: true },
      { axis: { a: 11, b: 5 }, laser: true },
    ];
    expect(dedupeQuantised(pts)).toHaveLength(2);
  });

  it("keeps a gate change at the same position, because that is how a dot is drawn", () => {
    /* The shipped tool emits exactly this pair to mark a pen down: identical
     * coordinates, the gate flipping from off to on. Collapsing it deletes the dot. */
    const pts: PlannedPoint[] = [
      { axis: { a: 10, b: 5 }, laser: false },
      { axis: { a: 10, b: 5 }, laser: true },
    ];
    expect(dedupeQuantised(pts)).toHaveLength(2);
  });

  it("leaves a path with no collisions untouched", () => {
    const pts: PlannedPoint[] = [0, 1, 2, 3].map((i) => ({ axis: { a: i, b: 0 }, laser: true }));
    expect(dedupeQuantised(pts)).toHaveLength(4);
  });

  it("handles an empty path", () => {
    expect(dedupeQuantised([])).toEqual([]);
  });
});

describe.each([
  ["detent-28byj", createDetent28byj()],
  ["washer-servo", createWasherServo()],
] as ReadonlyArray<readonly [string, MachineProfile]>)(
  "a real densified stroke never reaches the planner with a zero length axis segment: %s",
  (_id, profile) => {
    /*
     * The concrete reproduction. An off-axis stroke densified at the machine's own
     * sampling step is exactly the case the review predicted, and it is the first
     * thing either rig plots.
     */
    function densify(from: Point, to: Point, stepMm: number): Point[] {
      const d = Math.hypot(to.x - from.x, to.y - from.y);
      const n = Math.max(1, Math.ceil(d / stepMm));
      const out: Point[] = [];
      for (let i = 0; i <= n; i++) {
        out.push({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
      }
      return out;
    }

    it("the collision hazard tracks whether the machine samples at its own quantum", () => {
      const from = { x: -30, y: -17.32 };
      const to = { x: 30, y: 17.32 }; // 30 degrees to X
      const step = profile.sampleStepMm({ x: 0, y: 0 });
      const pts = densify(from, to, step);

      const quantised = pts.map((p) => profile.quantise(profile.inverse(p)));
      let collisions = 0;
      for (let i = 1; i < quantised.length; i++) {
        if (quantised[i]!.a === quantised[i - 1]!.a && quantised[i]!.b === quantised[i - 1]!.b) {
          collisions++;
        }
      }

      /*
       * This is sharper than "collisions always happen", which was the first guess
       * and is wrong.
       *
       * A machine that samples AT its quantum advances by about one axis unit per
       * sample, so an off-axis stroke rounds two consecutive samples onto the same
       * pair perhaps one time in seven, and every one of those is a division by zero
       * waiting to happen. That is the stepper.
       *
       * A machine that samples far COARSER than its quantum never collides: the
       * servo's quantum is one microsecond but it samples at half a deadband, which
       * is several microseconds, so consecutive samples are always distinguishable.
       *
       * The guard is still unconditional, because the property that makes the servo
       * safe is a property of its current sampling policy and not of its hardware.
       * Turn dither on, tighten the sampling, or add a profile that samples at its
       * quantum, and the hazard is back.
       */
      const samplesAtQuantum = step * profile.sensitivity(from, { x: from.x + 1, y: from.y }) < 2;
      if (samplesAtQuantum) {
        expect(collisions).toBeGreaterThan(0);
      } else {
        expect(collisions).toBe(0);
      }
    });

    it("quantisePath removes every one of them", () => {
      const from = { x: -30, y: -17.32 };
      const to = { x: 30, y: 17.32 };
      const step = profile.sampleStepMm({ x: 0, y: 0 });
      const pts = densify(from, to, step);
      const planned = quantisePath(
        pts,
        pts.map(() => true),
        profile,
      );

      for (let i = 1; i < planned.length; i++) {
        const ds = profile.arcLength(planned[i - 1]!.axis, planned[i]!.axis);
        expect(ds).toBeGreaterThan(0);
      }
    });

    it("and the resulting caps are all finite", () => {
      const from = { x: -30, y: -17.32 };
      const to = { x: 30, y: 17.32 };
      const step = profile.sampleStepMm({ x: 0, y: 0 });
      const pts = densify(from, to, step);
      const planned = quantisePath(
        pts,
        pts.map(() => true),
        profile,
      );

      for (let i = 1; i < planned.length; i++) {
        const ds = profile.arcLength(planned[i - 1]!.axis, planned[i]!.axis);
        const cap = Math.min(profile.limits.maxRate * profile.limits.derate, limitFromGain(1, 1 / ds));
        expect(Number.isNaN(cap)).toBe(false);
        expect(cap).toBeGreaterThan(0);
      }
    });
  },
);
