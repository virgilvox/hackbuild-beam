import { describe, expect, it } from "vitest";
import { DETENT_DEADMAN_MS, STARVATION_GATE_MS, WASHER_DEADMAN_MS } from "@virgilvox/beam-core";
import {
  DEADMAN_MS,
  KEEPALIVE_MS,
  Keepalive,
  StarvationGate,
  isBoardDeadman,
  isErrorLine,
  isQueueFull,
  killBeam,
  stopSequence,
} from "./safety.js";

describe("INV-48: the pulse keepalive sits inside the board's 1.5 s dead man", () => {
  it("polls once a second idle and every 1.2 s in a plot", () => {
    const k = new Keepalive("pulse");
    expect(k.periodMs()).toBe(KEEPALIVE_MS.pulseIdle);
    k.running = true;
    expect(k.periodMs()).toBe(KEEPALIVE_MS.pulseRunning);
    expect(k.periodMs()).toBeLessThan(DEADMAN_MS.pulse);
    expect(DEADMAN_MS.pulse).toBe(WASHER_DEADMAN_MS);
  });

  it("fires once per period and not once per tick", () => {
    const k = new Keepalive("pulse");
    k.reset(0);
    expect(k.due(500)).toBe(false);
    expect(k.due(1000)).toBe(true);
    expect(k.due(1100)).toBe(false);
    expect(k.due(2000)).toBe(true);
  });

  it("keeps polling while nothing else is on the wire, which is the whole point", () => {
    /* An operator jogging corners sends no traffic for long stretches, and the board
     * cannot tell that apart from a host that has gone away. */
    const k = new Keepalive("pulse");
    k.reset(0);
    let sent = 0;
    for (let t = 0; t <= 10_000; t += 100) if (k.due(t)) sent++;
    expect(sent).toBe(10);
  });
});

describe("INV-47: the step keepalive protects a deliberate alignment hold", () => {
  it("polls every 2 s while the beam is held on, inside the board's 5 s dead man", () => {
    const k = new Keepalive("step");
    k.beamOn = true;
    expect(k.periodMs()).toBe(KEEPALIVE_MS.stepBeamHeld);
    expect(k.periodMs()).toBeLessThan(DEADMAN_MS.step);
    expect(DEADMAN_MS.step).toBe(DETENT_DEADMAN_MS);
  });

  it("stays off the wire when there is nothing to protect", () => {
    const k = new Keepalive("step");
    /* Beam off: the dead man has nothing to cut. Plot running: the stream itself is
     * the traffic. Either way a poll would only be noise on a link that is carrying
     * geometry. */
    expect(k.periodMs()).toBe(0);
    k.beamOn = true;
    k.running = true;
    expect(k.periodMs()).toBe(0);
    expect(k.due(999_999)).toBe(false);
  });
});

describe("INV-43: stop ordering", () => {
  it("flushes before it cuts the beam, in both vocabularies", () => {
    expect(stopSequence("pulse")).toEqual(["FLUSH", "L 0"]);
    expect(stopSequence("step")).toEqual(["X", "L 0"]);
    /* Sending only the gate leaves the queue standing, and every queued segment
     * relights the beam while the app believes it is paused. */
    for (const lineage of ["pulse", "step"] as const) {
      const seq = stopSequence(lineage);
      expect(seq.indexOf("L 0")).toBe(seq.length - 1);
    }
  });

  it("the kill is best effort: a link that is already gone must not throw", async () => {
    const sent: string[] = [];
    await killBeam("step", async (line) => {
      sent.push(line);
      throw new Error("link is gone");
    });
    /* It tried, and it stopped trying rather than leaving the transport open. */
    expect(sent).toEqual(["X"]);
  });
});

describe("reading what the board says", () => {
  it("recognises a dead man in either vocabulary", () => {
    expect(isBoardDeadman("ERR deadman")).toBe(true);
    expect(isBoardDeadman("warn deadman beam off")).toBe(true);
    expect(isBoardDeadman("ok")).toBe(false);
  });

  it("recognises a full queue in either vocabulary", () => {
    expect(isQueueFull("ERR segq full")).toBe(true);
    expect(isQueueFull("err full")).toBe(true);
    expect(isQueueFull("ok 6/6 free=200")).toBe(false);
  });

  it("tells an error line from an ordinary reply", () => {
    expect(isErrorLine("ERR unknown FLUSH")).toBe(true);
    expect(isErrorLine("err corner 0..3")).toBe(true);
    expect(isErrorLine("warn deadman beam off")).toBe(true);
    expect(isErrorLine("ok saved")).toBe(false);
  });
});

describe("INV-42: the starvation gate", () => {
  it("fires within 300 ms of an armed job running dry", () => {
    const gate = new StarvationGate();
    expect(gate.windowMs).toBe(STARVATION_GATE_MS);
    gate.arm(0);
    expect(gate.starved(299)).toBe(false);
    expect(gate.starved(300)).toBe(true);
  });

  it("does not fire when nothing was armed, and stops firing once fed", () => {
    /* Holding the beam lit at a dead stop burns a dot into the glow paint. A job that
     * was never armed has no beam to hold. */
    const gate = new StarvationGate();
    expect(gate.starved(10_000)).toBe(false);
    gate.arm(0);
    gate.fed(250);
    expect(gate.starved(500)).toBe(false);
    expect(gate.starved(550)).toBe(true);
    gate.disarm();
    expect(gate.starved(10_000)).toBe(false);
  });
});
