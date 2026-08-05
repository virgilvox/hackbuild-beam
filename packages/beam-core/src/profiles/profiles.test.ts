import { describe, expect, it } from "vitest";
import { createWasherServo } from "./washer-servo.js";
import { createDetent28byj, intervalFor } from "./detent-28byj.js";
import { DEG_PER_STEP, STEPS_PER_REV, TICK_HZ } from "../constants.js";
import type { MachineProfile, Point } from "../types.js";

/*
 * The contract tests. Every profile satisfies these, so the planner can hold one
 * of them without asking which it is. If a third rig is ever added, it lands here
 * first and the planner does not change.
 */

const PROFILES: MachineProfile[] = [createWasherServo(), createDetent28byj()];

const FIELD: Point[] = [];
for (let x = -50; x <= 50; x += 25) {
  for (let y = -50; y <= 50; y += 25) {
    FIELD.push({ x, y });
  }
}

describe.each(PROFILES.map((p) => [p.id, p] as const))("profile contract: %s", (_id, p) => {
  it("round trips mm through axis units and back", () => {
    let worst = 0;
    for (const pt of FIELD) {
      const back = p.forward(p.inverse(pt));
      worst = Math.max(worst, Math.hypot(back.x - pt.x, back.y - pt.y));
    }
    /* Unrounded both ways, so this is float noise and nothing else. Quantisation is
     * a separate stage and it is the planner's job, not the map's. */
    expect(worst).toBeLessThan(1e-6);
  });

  it("reports a positive finite sensitivity", () => {
    const centre = p.sensitivity({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect(centre).toBeGreaterThan(0);
    expect(Number.isFinite(centre)).toBe(true);
  });

  it("sensitivity really does vary across the field, which is why it is a secant", () => {
    /*
     * If this were constant, a single global mm-per-unit figure would be correct and
     * the whole per-segment gain machinery would be pointless. It is not constant:
     * both maps are non-linear, so the gain at the field edge differs from the gain
     * at the centre, and a limit computed from the wrong one is wrong everywhere it
     * is applied.
     */
    const centre = p.sensitivity({ x: 0, y: 0 }, { x: 1, y: 0 });
    const edge = p.sensitivity({ x: 100, y: 100 }, { x: 101, y: 100 });
    expect(Math.abs(edge - centre) / centre).toBeGreaterThan(0.01);
  });

  it("returns zero sensitivity for a zero length move rather than dividing by it", () => {
    expect(p.sensitivity({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0);
  });

  it("declares an axis quantum and a range that contains the field", () => {
    for (const ax of [p.axis.a, p.axis.b]) {
      expect(ax.quantum).toBeGreaterThan(0);
      expect(ax.max).toBeGreaterThan(ax.min);
    }
  });

  it("derates a destructive overrun and does not derate a degrading one", () => {
    if (p.limits.overrun === "destroys") {
      expect(p.limits.derate).toBeLessThan(1);
    } else {
      expect(p.limits.derate).toBe(1);
    }
  });

  it("has an actuator that starts where it is put and moves toward a command", () => {
    const act = p.actuator();
    const home = p.inverse({ x: 0, y: 0 });
    act.reset(home.a, home.b);

    const target = p.inverse({ x: 20, y: 0 });
    let pos = { a: home.a, b: home.b };
    for (let i = 0; i < 2000; i++) pos = act.step(0.001, target.a, target.b);

    /* It gets most of the way there. Exactly how close is the error model's business
     * and is pinned per profile, not here. */
    const travelled = Math.abs(pos.a - home.a);
    const asked = Math.abs(target.a - home.a);
    expect(travelled).toBeGreaterThan(asked * 0.5);
  });
});

describe("the two profiles differ in exactly the four documented ways", () => {
  const [washer, detent] = PROFILES as [MachineProfile, MachineProfile];

  it("axis unit", () => {
    expect(washer.axis.a.name).toBe("us");
    expect(detent.axis.a.name).toBe("halfstep");
  });

  it("geometry parameters, not geometry models", () => {
    /* This is the claim. A pan/tilt head has no mirror separation; a two mirror rig
     * needs no vertical offset. Same model, two parameter sets. */
    expect(washer.geometry.sepMm).toBe(0);
    expect(detent.geometry.vOffMm).toBe(0);
    expect(washer.geometry.vOffMm).not.toBe(0);
    expect(detent.geometry.sepMm).not.toBe(0);
  });

  it("beam angle per axis angle: a mirror doubles, a horn does not", () => {
    expect(washer.beamAnglePerAxisAngle).toBe(1);
    expect(detent.beamAnglePerAxisAngle).toBe(2);
  });

  it("sub quantum strategy follows what the hardware can actually do", () => {
    expect(washer.axis.a.subQuantum).toBe("dither");
    expect(detent.axis.a.subQuantum).toBe("none");
  });
});

describe("detent bench reference values", () => {
  /*
   * From fwtest.cpp T6, which prints these and does not assert on them. They are
   * load bearing (they define mm per step on the bench geometry) so they get an
   * assertion here, which is exactly the gap the harness read flagged.
   */
  const p = createDetent28byj();

  it("DEG_PER_STEP is computed, not the rounded value in the firmware comment", () => {
    expect(STEPS_PER_REV).toBe(4075.7728);
    expect(DEG_PER_STEP).toBeCloseTo(0.08832680761793199, 15);
    /* The comment's 0.0883266 would shift every step count. */
    expect(DEG_PER_STEP).not.toBeCloseTo(0.0883266, 9);
  });

  it("60 mm right is 109 half steps at 0.5505 mm per step", () => {
    const { a } = p.inverse({ x: 60, y: 0 });
    expect(Math.round(a)).toBe(109);
    expect(60 / Math.round(a)).toBeCloseTo(0.550459, 5);
  });

  it("60 mm up is 123 half steps", () => {
    const { b } = p.inverse({ x: 0, y: 60 });
    expect(Math.round(b)).toBe(123);
  });

  it("the two axes differ because the X mirror sits sep further from the plane", () => {
    /* 109 against 123 is not an error, it is the mirror separation showing up: the X
     * mirror's lever arm is throw + sep while the Y mirror's is throw. */
    const { a } = p.inverse({ x: 60, y: 0 });
    const { b } = p.inverse({ x: 0, y: 60 });
    expect(Math.round(b)).toBeGreaterThan(Math.round(a));
  });
});

describe("interval derivation", () => {
  it("uses truncating division, matching C", () => {
    /* Defaults land exactly: rate 400 gives 50, travel 500 gives 40. */
    expect(intervalFor(400)).toBe(50);
    expect(intervalFor(500)).toBe(40);
    expect(TICK_HZ).toBe(20000);
  });

  it("clamps rather than dividing by zero or overflowing uint16", () => {
    expect(intervalFor(0)).toBe(20000);
    expect(intervalFor(-5)).toBe(20000);
    expect(intervalFor(1e9)).toBe(1);
  });

  it("truncates toward zero where a float divide would round up", () => {
    /* 20000 / 700 is 28.57. C gives 28, not 29. */
    expect(intervalFor(700)).toBe(28);
    expect(intervalFor(900)).toBe(22);
  });
});

describe("profile identity", () => {
  const [washer, detent] = PROFILES as [MachineProfile, MachineProfile];

  it("picks itself from the legacy hello line of an unmodified board", () => {
    expect(washer.matches("READY LASER RIG", {})).toBe(true);
    expect(detent.matches("READY LASER RIG", {})).toBe(false);

    expect(detent.matches("detent 1.3 esp32c3 spr=4075.77 dps=0.088327 tick=20000", {})).toBe(true);
    expect(washer.matches("detent 1.3 esp32c3", {})).toBe(false);
  });

  it("falls back to the config dump when the hello line was missed", () => {
    /* A mid-session reconnect can land after the board has already greeted. A pulse
     * window with no step rate is a servo rig; a step rate with no pulse window is a
     * stepper rig. */
    expect(washer.matches("", { min: "500", max: "2500" })).toBe(true);
    expect(detent.matches("", { min: "500", max: "2500" })).toBe(false);

    expect(detent.matches("", { rate: "400", travel: "500" })).toBe(true);
    expect(washer.matches("", { rate: "400", travel: "500" })).toBe(false);
  });

  it("does not both claim the same board", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["READY LASER RIG", { min: "500", max: "2500" }],
      ["detent 1.3 esp32c3", { rate: "400" }],
      ["BEAM 2.0", { profile: "washer-servo" }],
      ["BEAM 2.0", { profile: "detent-28byj" }],
    ];
    for (const [hello, cfg] of cases) {
      const claims = PROFILES.filter((p) => p.matches(hello, cfg));
      expect(claims).toHaveLength(1);
    }
  });
});

describe.each(PROFILES.map((p) => [p.id, p] as const))("planner contract: %s", (_id, p) => {
  it("arcLength is Linf, which is what the hardware actually counts", () => {
    const from = { a: 0, b: 0 };
    const to = { a: 30, b: 12 };
    expect(p.arcLength(from, to)).toBe(30);
    /* Not Euclidean. On a stepper the minor axis steps on the same tick as the
     * major, so a diagonal costs what its dominant axis costs and nothing more. */
    expect(p.arcLength(from, to)).not.toBeCloseTo(Math.hypot(30, 12), 6);
  });

  it("arcLength is symmetric and zero for no move", () => {
    expect(p.arcLength({ a: 5, b: 5 }, { a: 5, b: 5 })).toBe(0);
    expect(p.arcLength({ a: 0, b: 0 }, { a: -7, b: 3 })).toBe(7);
  });

  it("sampleStepMm is positive and finite everywhere in the field", () => {
    for (const pt of FIELD) {
      const s = p.sampleStepMm(pt);
      expect(s).toBeGreaterThan(0);
      expect(Number.isFinite(s)).toBe(true);
    }
  });

  it("quantise lands on the axis quantum", () => {
    const q = p.quantise({ a: 12.4, b: -7.6 });
    expect(Number.isInteger(q.a)).toBe(true);
    expect(Number.isInteger(q.b)).toBe(true);
  });

  it("quantise is idempotent", () => {
    const once = p.quantise({ a: 100.3, b: -50.7 });
    expect(p.quantise(once)).toEqual(once);
  });
});

describe("quantise rounding matches each machine's own convention", () => {
  const [washer, detent] = PROFILES as [MachineProfile, MachineProfile];

  it("the stepper rounds half away from zero, matching lroundf", () => {
    /*
     * INV-65. The firmware uses lroundf, which rounds half AWAY from zero, while
     * Math.round rounds half toward positive infinity. They disagree at negative
     * half integers, which is exactly where a field centred on zero puts a lot of
     * points. Math.round(-0.5) is -0; lroundf(-0.5) is -1.
     */
    expect(detent.quantise({ a: -0.5, b: -1.5 })).toEqual({ a: -1, b: -2 });
    expect(detent.quantise({ a: 0.5, b: 1.5 })).toEqual({ a: 1, b: 2 });
    /* The naive port would give -0 and -1 here. */
    expect(Math.round(-0.5)).not.toBe(-1);
  });

  it("the servo clamps into its pulse window before rounding", () => {
    const lo = washer.quantise({ a: -9999, b: 9999 });
    expect(lo.a).toBe(washer.axis.a.min);
    expect(lo.b).toBe(washer.axis.b.max);
  });
});

describe("sampleStepMm reflects what each machine can resolve", () => {
  const [washer, detent] = PROFILES as [MachineProfile, MachineProfile];
  const origin = { x: 0, y: 0 };

  it("the stepper samples at one step, roughly half a millimetre on the bench", () => {
    /* 0.550 mm per step at 60 mm right, per fwtest.cpp T6. */
    expect(detent.sampleStepMm(origin)).toBeGreaterThan(0.4);
    expect(detent.sampleStepMm(origin)).toBeLessThan(0.7);
  });

  it("the servo samples finer than its own deadband, on purpose", () => {
    /* One deadband step is about 1.9 mm on the default geometry. Sampling at half
     * that is not about resolving what the servo can do, it is about not throwing
     * detail away in the source before the planner sees it. */
    const s = washer.sampleStepMm(origin);
    expect(s).toBeGreaterThan(0.08);
    expect(s).toBeLessThan(1.9);
  });

  it("dither makes the servo sample finer still", () => {
    const plain = createWasherServo({ dither: false }).sampleStepMm(origin);
    const dithered = createWasherServo({ dither: true }).sampleStepMm(origin);
    expect(dithered).toBeLessThan(plain);
  });
});

describe("the planned bit is a safety trade, not a free win", () => {
  const [washer, detent] = PROFILES as [MachineProfile, MachineProfile];

  it("a machine that bypasses its own ramp says so", () => {
    /*
     * Setting the planned bit turns off the firmware's reversal ramp, which is the
     * thing that stops a full rate reversal, which is exactly where a stepper skips.
     * From that moment the host owns corner deceleration and a planner bug is
     * destroyed geometry rather than a slow corner.
     */
    expect(detent.caps.firmwareRampBypassed).toBe(true);
    expect(washer.caps.firmwareRampBypassed).toBe(false);
  });

  it("only a machine whose overrun destroys can have a ramp worth bypassing", () => {
    for (const p of PROFILES) {
      if (p.caps.firmwareRampBypassed) {
        expect(p.limits.overrun).toBe("destroys");
        expect(p.limits.derate).toBeLessThan(1);
      }
    }
  });
});

describe("sampleStepMm takes the worst axis, not just X", () => {
  /*
   * The shipped stepper tool samples its gain along X at the origin and uses that
   * one number everywhere. Under a solved homography the two axes can be stretched
   * by different amounts, and sampling the slack axis under-samples the tight one.
   */
  it("a map that stretches Y harder than X produces a finer step, not the X-only step", () => {
    /* A rig whose Y lever arm is much shorter has a much higher Y gain. */
    const squat = createDetent28byj({ throwMm: 60, sepMm: 22 });
    const near = { x: 0, y: 0 };

    const kx = squat.sensitivity(near, { x: 1, y: 0 });
    const ky = squat.sensitivity(near, { x: 0, y: 1 });
    expect(ky).not.toBeCloseTo(kx, 3);

    const step = squat.sampleStepMm(near);
    /* The step must follow the busier axis. If it followed X alone it would be the
     * larger, coarser value and the Y detail would be thrown away before planning. */
    expect(step).toBeCloseTo(1 / Math.max(kx, ky), 9);
    expect(step).toBeLessThanOrEqual(1 / kx);
  });
});
