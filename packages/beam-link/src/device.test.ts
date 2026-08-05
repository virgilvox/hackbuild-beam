import { beforeEach, describe, expect, it } from "vitest";
import { PROBE, WASHER_QUEUE_USABLE, intervalFor } from "@virgilvox/beam-core";
import { Device, type Job } from "./device.js";
import type { DeviceState, Transport } from "./index.js";
import { MockTransport, boardState, type MockBoardOptions } from "./transports/mock.js";
import type { StepPoint } from "./packet.js";

/**
 * Records every write and every reply in one ordered list, which is what lets the
 * INV-62a test assert not just that the probe was first but that nothing else went out
 * until the answer had arrived.
 */
class SpyTransport implements Transport {
  readonly kind = "mock" as const;
  readonly log: Array<{ dir: "tx" | "rx"; text: string }> = [];
  readonly frames: Uint8Array[] = [];

  constructor(private readonly inner: MockTransport) {
    inner.onLine((line) => this.log.push({ dir: "rx", text: line }));
  }

  get pending(): number {
    return this.inner.pending;
  }
  get writes(): string[] {
    return this.log.filter((e) => e.dir === "tx").map((e) => e.text);
  }
  connect(): Promise<void> {
    return this.inner.connect();
  }
  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }
  async sendLine(text: string): Promise<void> {
    this.log.push({ dir: "tx", text });
    await this.inner.sendLine(text);
  }
  async sendFrame(bytes: Uint8Array): Promise<void> {
    this.frames.push(bytes.slice());
    this.log.push({ dir: "tx", text: `[frame ${bytes.length}]` });
    await this.inner.sendFrame(bytes);
  }
  onLine(cb: (line: string) => void): () => void {
    return this.inner.onLine(cb);
  }
  onClose(cb: () => void): () => void {
    return this.inner.onClose(cb);
  }
}

interface Rig {
  mock: MockTransport;
  spy: SpyTransport;
  device: Device;
  states: DeviceState[];
}

/**
 * Time is injected all the way through: the device's sleeps drive the board's clock,
 * so a queue drains deterministically and instantly instead of the test waiting for
 * the wall. A test that has to sleep for real is either slow or flaky.
 */
function rig(opts: MockBoardOptions): Rig {
  const mock = new MockTransport(opts);
  const spy = new SpyTransport(mock);
  const states: DeviceState[] = [];
  const device = new Device({
    transport: spy,
    keepalive: false,
    now: () => mock.board.nowMs,
    sleep: async (ms) => {
      mock.advance(ms);
      await Promise.resolve();
    },
  });
  device.events.on("state", (s) => states.push(s));
  return { mock, spy, device, states };
}

const pulseRig = (extra: Partial<MockBoardOptions> = {}) =>
  rig({ lineage: "pulse", beats: false, ...extra });
const stepRig = (extra: Partial<MockBoardOptions> = {}) =>
  rig({ lineage: "step", hello: null, beats: false, ...extra });

describe("INV-62a: connect writes nothing but the probe until the peer is classified", () => {
  for (const lineage of ["pulse", "step"] as const) {
    it(`holds on a ${lineage} board`, async () => {
      const { spy, device } = lineage === "pulse" ? pulseRig() : stepRig();
      await device.connect();

      const firstStatus = spy.log.findIndex((e) => e.dir === "rx" && /^(STAT |st )/.test(e.text));
      expect(firstStatus).toBeGreaterThanOrEqual(0);

      const before = spy.log.slice(0, firstStatus).filter((e) => e.dir === "tx");
      expect(before.length).toBeGreaterThan(0);
      expect(before.every((e) => e.text === PROBE)).toBe(true);

      const firstOther = spy.log.findIndex((e) => e.dir === "tx" && e.text !== PROBE);
      expect(firstOther).toBeGreaterThan(firstStatus);
      await device.disconnect();
    });
  }

  it("refuses to write anything else before classification, as an error rather than a convention", async () => {
    const { device } = stepRig();
    /* Not connected, so not classified. This one only shows the guard is reached
     * before the transport is; the live-link case below is what proves it holds where
     * a violation would actually land on a board. */
    await expect(device.send("ECHO 0")).rejects.toThrow(/INV-62a/);
    await expect(device.send("M 1500 1500 0")).rejects.toThrow(/INV-62a/);
    /* Past the guard and refused by the closed transport instead, which is how far a
     * probe gets with no link under it. */
    await expect(device.send(PROBE)).rejects.toThrow(/not connected/);
  });

  it("holds the guard on a live link whose peer answered nothing, and the coils stay live", async () => {
    /*
     * The state the guard actually exists for, and the one a disconnected device
     * cannot stand in for: the port is open, a write would reach the board, three
     * probes have been sent and answered by nothing, so the lineage is still unknown.
     *
     * Two mutations of `Device.send` survive the rest of this suite without this
     * test. Deleting the guard outright is caught only by the disconnected case above,
     * and only because the mock transport happens to throw first. Keying it off "has
     * classification been attempted" rather than "is the lineage known" is caught by
     * nothing at all, and it is the plausible mistake: it reads as equivalent, and it
     * opens the wire in exactly the simulator-mode state the whole design turns on.
     */
    const mock = new MockTransport({ lineage: "step", hello: null, silent: true });
    const spy = new SpyTransport(mock);
    const device = new Device({
      transport: spy,
      keepalive: false,
      probe: { retryMs: 5, timeoutMs: 20, maxRetries: 2 },
    });
    await device.connect();
    expect(mock.isConnected).toBe(true);
    expect(device.classification).not.toBeNull();
    expect(device.lineage).toBeNull();

    await expect(device.send("ECHO 0")).rejects.toThrow(/INV-62a/);
    await expect(device.send("M 1500 1500 0")).rejects.toThrow(/INV-62a/);

    /* Refused is not enough. It must never have been written: `E` with rest "CHO 0"
     * parses as zero over there and both coil sets let go. */
    expect(mock.sentLines).not.toContain("ECHO 0");
    expect(mock.sentLines.every((l) => l === PROBE)).toBe(true);
    expect(boardState(mock).coilsLive).toBe(true);
    expect(boardState(mock).a).toBe(0);

    /* And the probe still goes through on that same live link, which is the only
     * reason classification can ever succeed. */
    await device.probe();
    expect(spy.writes).toEqual([PROBE, PROBE, PROBE, PROBE]);
    await device.disconnect();
  });

  it("a step board that was never classified never had its coils released", async () => {
    const { mock, device } = stepRig();
    await device.connect();
    /* The whole point: the connect path above ran to completion and the rig is still
     * energised, because ECHO 0 was never one of the lines it was allowed to send. */
    expect(boardState(mock).coilsLive).toBe(true);
    expect(mock.sentLines).not.toContain("ECHO 0");
    await device.disconnect();
  });

  it("stays in simulator mode when nothing answers, and never guesses a vocabulary", async () => {
    const mock = new MockTransport({ lineage: "step", hello: null, silent: true });
    const spy = new SpyTransport(mock);
    const device = new Device({
      transport: spy,
      keepalive: false,
      probe: { retryMs: 5, timeoutMs: 20, maxRetries: 2 },
    });
    await device.connect();

    expect(device.state).toBe("unknown");
    expect(device.peer).toBeNull();
    expect(device.lineage).toBeNull();
    expect(spy.writes).toEqual([PROBE, PROBE, PROBE]);
    /* Read only. Everything that moves the machine refuses. */
    await expect(device.jog(1, 1)).rejects.toThrow(/read only/);
    await device.disconnect();
  });
});

describe("INV-59: the board is the source of truth and connect adopts", () => {
  it("adopts a pulse board's stored setup and builds the profile from it", async () => {
    const { device, states } = pulseRig({
      washer: { distMm: 210, wallW: 400, wallH: 400, mountH: 55, minUs: 600, maxUs: 2400 },
    });
    await device.connect();

    expect(states).toEqual(["classifying", "adopting", "idle"]);
    expect(device.adopted).toBe(true);
    const board = device.boardConfig;
    expect(board?.kind).toBe("washer");
    if (board?.kind !== "washer") throw new Error("wrong lineage");
    expect(board.distMm).toBe(210);
    expect(board.minUs).toBe(600);

    const peer = device.peer;
    expect(peer?.profile.id).toBe("washer-servo");
    /* The profile carries the board's numbers, not the library defaults: a wrong
     * profile aims a live beam through the wrong map, and so does a right profile
     * with the wrong throw. */
    expect(peer?.profile.geometry.throwMm).toBe(210);
    expect(peer?.profile.axis.a.min).toBe(600);
    expect(peer?.legacy).toBe(true);
    await device.disconnect();
  });

  it("adopts a step board's qc dump and reads the tick rate off the version line", async () => {
    const { device, spy } = stepRig({ detent: { throwMm: 175, sepMm: 30, rate: 520 } });
    await device.connect();

    const board = device.boardConfig;
    expect(board?.kind).toBe("detent");
    if (board?.kind !== "detent") throw new Error("wrong lineage");
    expect(board.throwMm).toBe(175);
    expect(board.rate).toBe(520);
    expect(board.complete).toBe(true);

    expect(device.peer?.profile.id).toBe("detent-28byj");
    expect(device.peer?.profile.geometry.sepMm).toBe(30);
    /* Negotiated, never compiled in. The stale comment in the firmware is exactly
     * how a host ends up off by a factor of two on every interval it sends. */
    expect(device.peer?.wire.tick).toBe(20000);
    expect(spy.writes).toContain("V");
    expect(spy.writes).toContain("Q");
    await device.disconnect();
  });

  it("INV-84: a stored calibration flag with no corners behind it is not honoured", async () => {
    const { device } = pulseRig({ washer: { calibrationOn: true, cornerCount: 0 } });
    await device.connect();
    const board = device.boardConfig;
    if (board?.kind !== "washer") throw new Error("wrong lineage");
    expect(board.cornerCount).toBe(0);
    expect(board.calibrationOn).toBe(false);
    await device.disconnect();
  });

  it("adopting reads: nothing in connect pushes geometry or moves the machine", async () => {
    const { mock, spy, device } = stepRig();
    const before = boardState(mock);
    await device.connect();
    const after = boardState(mock);

    expect(after.a).toBe(before.a);
    expect(after.b).toBe(before.b);
    expect(after.laser).toBe(false);
    expect(after.saves).toBe(0);
    /* Only reads: the probe, the version and the config dump. */
    expect(new Set(spy.writes)).toEqual(new Set([PROBE, "V", "Q"]));
    await device.disconnect();
  });
});

describe("pushing and persisting are explicit acts", () => {
  it("a pulse push is ONE line, because CFG is applied key by key", async () => {
    const { spy, device } = pulseRig();
    await device.connect();
    const from = spy.writes.length;

    await device.push({
      wallW: 400,
      wallH: 400,
      distMm: 210,
      corners: {
        tl: { panDeg: 91.2, tiltDeg: 88.4 },
        tr: { panDeg: 88.9, tiltDeg: 88.5 },
        bl: { panDeg: 91.1, tiltDeg: 91.7 },
        br: { panDeg: 88.8, tiltDeg: 91.6 },
      },
      calibrationOn: true,
    });

    const pushed = spy.writes.slice(from);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatch(/^CFG /);
    expect(pushed[0]).toContain("tl=91.20,88.40");
    /* INV-61: a config push with all four corners runs close to 200 characters, and
     * a board whose line buffer truncates it applies half a config. */
    expect((pushed[0] ?? "").length).toBeLessThan(300);
    await device.disconnect();
  });

  it("a step push is the command sequence, with limits set before they are turned on", async () => {
    const { spy, device } = stepRig();
    await device.connect();
    const from = spy.writes.length;

    await device.push({
      throwMm: 150,
      sepMm: 22,
      fieldW: 120,
      fieldH: 120,
      rate: 400,
      rateTravel: 500,
      idleReleaseMs: 4000,
      lashX: 3,
      lashY: 4,
      invX: true,
      invY: false,
      minX: -900,
      maxX: 900,
      minY: -900,
      maxY: 900,
      limitsOn: true,
    });

    const pushed = spy.writes.slice(from);
    expect(pushed[0]).toBe("G 150 22 120 120");
    expect(pushed).toContain("B 3 4");
    expect(pushed).toContain("I 1 0");
    expect(pushed.indexOf("N -900 900 -900 900")).toBeLessThan(pushed.indexOf("U 1"));
    await device.disconnect();
  });

  it("INV-60: persisting is its own act on the step rig", async () => {
    const { mock, spy, device } = stepRig();
    await device.connect();
    expect(boardState(mock).saves).toBe(0);

    expect(await device.persist()).toBe(true);

    expect(spy.writes).toContain("W");
    expect(boardState(mock).saves).toBe(1);
    await device.disconnect();
  });

  it("the pulse rig has no separate persist, and says so rather than pretending", async () => {
    const { spy, device } = pulseRig();
    await device.connect();
    const from = spy.writes.length;

    expect(await device.persist()).toBe(false);

    expect(spy.writes.slice(from)).toHaveLength(0);
    await device.disconnect();
  });
});

describe("moving the machine", () => {
  it("jogs relative on both lineages, in each one's own vocabulary", async () => {
    const pulse = pulseRig();
    await pulse.device.connect();
    await pulse.device.jog(50, -25);
    expect(pulse.spy.writes.at(-1)).toBe("P 1550 1475");
    await pulse.device.disconnect();

    const step = stepRig();
    await step.device.connect();
    await step.device.jog(12, -3);
    expect(step.spy.writes.at(-1)).toBe("J 12 -3");
    await step.device.disconnect();
  });

  it("L 0 and L 1 are the one command that means the same thing on both", async () => {
    for (const make of [pulseRig, stepRig]) {
      const { mock, device } = make();
      await device.connect();
      await device.setLaser(true);
      expect(boardState(mock).laser).toBe(true);
      await device.setLaser(false);
      expect(boardState(mock).laser).toBe(false);
      await device.disconnect();
    }
  });

  it("refuses a job planned for the other lineage rather than translating it", async () => {
    const { device } = stepRig();
    await device.connect();
    const job: Job = { lineage: "pulse", segments: [{ pan: 1500, tilt: 1500, laser: false, durMs: 10 }] };
    await expect(device.run(job)).rejects.toThrow(/planned for the pulse lineage/);
    await device.disconnect();
  });
});

describe("running a job on the step lineage", () => {
  const line = (n: number): StepPoint[] =>
    Array.from({ length: n }, (_, i) => ({
      x: i,
      y: Math.round(i / 2),
      laser: true,
      iv: intervalFor(400),
    }));

  it("streams text batches of six and lands the beam on the last point", async () => {
    const { mock, spy, device } = stepRig();
    await device.connect();
    const from = spy.writes.length;

    const points = line(14);
    const result = await device.run({ lineage: "step", points });

    expect(result.sent).toBe(14);
    expect(result.stopped).toBe(false);
    const batches = spy.writes.slice(from).filter((w) => w.startsWith("S "));
    expect(batches).toHaveLength(3);
    /* INV-18: `x,y,l` with an optional fourth `iv`, space joined. A trailing comma
     * for a missing iv breaks the board's tokeniser. */
    expect(batches[0]).toBe("S 0,0,1,50 1,1,1,50 2,1,1,50 3,2,1,50 4,2,1,50 5,3,1,50");
    expect(batches[0]?.split(" ")).toHaveLength(7);

    const state = boardState(mock);
    expect(state.a).toBe(13);
    expect(state.queued).toBe(0);
    /* INV-82: the beam is not cut until the board has actually finished. */
    expect(state.laser).toBe(false);
    expect(device.state).toBe("idle");
    await device.disconnect();
  });

  it("INV-24: the credit window is what stops the queue-full drops", async () => {
    /* Beats on, because this is the case the unsolicited report exists for: 300
     * points is more than the board's 255 slot queue, so the host has to wait for
     * the board to tell it there is room. */
    const { mock, device } = stepRig({ beats: true });
    await device.connect();

    const result = await device.run({ lineage: "step", points: line(300) });

    expect(result.sent).toBe(300);
    const state = boardState(mock);
    /* Not one segment thrown away. A dropped segment is erased geometry. */
    expect(state.drops).toBe(0);
    expect(state.a).toBe(299);
    await device.disconnect();
  });

  it("INV-43: stop is flush then beam off, never the reverse", async () => {
    const { mock, spy, device } = stepRig();
    await device.connect();
    await device.setLaser(true);
    await device.moveTo(400, 400, true);
    const from = spy.writes.length;

    await device.stop();

    expect(spy.writes.slice(from)).toEqual(["X", "L 0"]);
    const state = boardState(mock);
    expect(state.queued).toBe(0);
    expect(state.laser).toBe(false);
    await device.disconnect();
  });
});

describe("running a job on the pulse lineage", () => {
  const ramp = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      pan: 1400 + i,
      tilt: 1500 + (i % 7),
      laser: i > 1,
      durMs: 20,
    }));

  it("streams packed binary in the format the board negotiated and plays it out", async () => {
    const { mock, spy, device } = pulseRig();
    await device.connect();
    const segments = ramp(24);

    const result = await device.run({ lineage: "pulse", segments });

    expect(result.sent).toBe(24);
    /* The board reported bin=2 and herm=1, so hermite is what goes out: three
     * packets of eight, not twenty-four text lines. */
    expect(spy.frames).toHaveLength(3);
    expect(spy.frames[0]?.[0]).toBe(0xa4);
    expect(spy.frames[0]?.[1]).toBe(8);

    const state = boardState(mock);
    expect(state.a).toBe(1423);
    expect(state.lost).toBe(0);
    expect(state.crcErrors).toBe(0);
    expect(state.drops).toBe(0);
    expect(state.laser).toBe(false);
    expect(state.free).toBe(WASHER_QUEUE_USABLE);
    await device.disconnect();
  });

  it("INV-23: the emit gate never overruns the board's queue", async () => {
    /* Two hundred segments through a forty seven slot queue. The only thing keeping
     * them apart is the credit projection. */
    const { mock, device } = pulseRig();
    await device.connect();

    const result = await device.run({ lineage: "pulse", segments: ramp(200) });

    expect(result.sent).toBe(200);
    expect(boardState(mock).drops).toBe(0);
    expect(boardState(mock).lost).toBe(0);
    await device.disconnect();
  });

  it("INV-43: stop flushes before it cuts the beam", async () => {
    const { spy, device } = pulseRig();
    await device.connect();
    const from = spy.writes.length;

    await device.stop();

    expect(spy.writes.slice(from)).toEqual(["FLUSH", "L 0"]);
    await device.disconnect();
  });
});

describe("what the board says back", () => {
  let seen: Array<{ level: string; text: string }>;

  beforeEach(() => {
    seen = [];
  });

  it("INV-25: a rising drop counter is surfaced loudly", async () => {
    const { mock, device } = pulseRig();
    device.events.on("log", (l) => seen.push(l));
    const drops: Array<{ total: number; delta: number }> = [];
    device.events.on("drops", (d) => drops.push(d));
    await device.connect();

    /* Fill the board's queue past its end, which is what a drop actually is. */
    for (let i = 0; i < WASHER_QUEUE_USABLE + 4; i++) {
      await mock.sendLine(`SEG 1500 1500 0 50`);
    }
    await device.probe();
    await Promise.resolve();

    expect(boardState(mock).drops).toBeGreaterThan(0);
    expect(drops.at(-1)?.delta).toBeGreaterThan(0);
    expect(seen.some((l) => l.level === "error" && /geometry is gone/.test(l.text))).toBe(true);
    await device.disconnect();
  });

  it("INV-41: a board dead man pauses the job rather than streaming on from the wrong place", async () => {
    const { mock, device } = stepRig();
    const flushes: string[] = [];
    device.events.on("flush", (f) => flushes.push(f.reason));
    await device.connect();

    /* The board announcing that it cut the beam and dumped its queue. */
    mock.board.emit("warn deadman beam off");

    expect(flushes).toContain("board dead man");
    await device.disconnect();
  });

  it("a link that drops leaves the device disconnected and unclassified", async () => {
    const { mock, device } = stepRig();
    await device.connect();
    expect(device.state).toBe("idle");

    await mock.disconnect();

    expect(device.state).toBe("disconnected");
    expect(device.peer).toBeNull();
    expect(device.lineage).toBeNull();
  });
});
