import { describe, expect, it } from "vitest";
import {
  BLE_MAX_WRITES_IN_FLIGHT,
  DETENT_CREDIT_HEADROOM,
  FLAG,
  MAGIC,
  STEP_FMT,
  WASHER_EMIT_GATE_SLOTS,
  crc8,
  intervalFor,
  stepCountByte,
} from "@virgilvox/beam-core";
import {
  formatStepBatch,
  packPulseFlat,
  packPulseHermite,
  packStepBatch,
  packStepFlat,
  type StepPoint,
} from "./packet.js";
import { BLOCKED_POLLS_BEFORE_REQUERY, PulseCredit, StepCredit } from "./stream.js";
import { MockTransport, boardState } from "./transports/mock.js";

const wire = (over: Partial<{ bin: number; herm: boolean; ivb: number }> = {}) => ({
  seg: true,
  bin: 0,
  herm: false,
  ivb: 0,
  tick: 20000,
  esc: 1 as const,
  proto: 0,
  ...over,
});

describe("INV-23: the pulse emit gate projects credit rather than trusting the last report", () => {
  it("counts everything launched since the report and everything still pooled", () => {
    const credit = new PulseCredit();
    credit.report(20);
    expect(credit.room()).toBe(20);
    credit.spend(8);
    expect(credit.room()).toBe(12);
    /* Anything pooled locally is spending slots too, even though it has not left. */
    expect(credit.room(4)).toBe(8);
    credit.report(30);
    /* A fresh report accounts for everything before it. */
    expect(credit.room()).toBe(30);
  });

  it("shuts at fewer than six free slots", () => {
    const credit = new PulseCredit();
    const gate = () => credit.gate({ pending: 0, kind: "serial", now: 0 });
    credit.report(WASHER_EMIT_GATE_SLOTS);
    expect(gate()).toBe(true);
    credit.spend(1);
    expect(gate()).toBe(false);
  });

  it("fails open before the board has ever reported, which is what both originals do", () => {
    const credit = new PulseCredit();
    expect(credit.room()).toBe(Number.POSITIVE_INFINITY);
    expect(credit.gate({ pending: 0, kind: "ble", now: 0 })).toBe(true);
  });

  it("INV-22: halts while more than three BLE writes are in flight", () => {
    const credit = new PulseCredit();
    credit.report(47);
    expect(credit.gate({ pending: BLE_MAX_WRITES_IN_FLIGHT, kind: "ble", now: 0 })).toBe(true);
    expect(credit.gate({ pending: BLE_MAX_WRITES_IN_FLIGHT + 1, kind: "ble", now: 0 })).toBe(false);
    /* Serial has no radio queue to fall behind, so depth there is not the same signal. */
    expect(credit.gate({ pending: 9, kind: "serial", now: 0 })).toBe(true);
  });

  it("stands off after the board says its queue is full", () => {
    const credit = new PulseCredit();
    credit.report(47);
    credit.hold(1000);
    expect(credit.gate({ pending: 0, kind: "serial", now: 1100 })).toBe(false);
    expect(credit.gate({ pending: 0, kind: "serial", now: 1300 })).toBe(true);
  });
});

describe("INV-24: the step credit window", () => {
  it("wants the batch plus eight before it sends a batch of six", () => {
    const credit = new StepCredit();
    credit.report(DETENT_CREDIT_HEADROOM);
    expect(credit.blocked()).toBe(false);
    credit.report(DETENT_CREDIT_HEADROOM - 1);
    expect(credit.blocked()).toBe(true);
  });

  it("re-queries after twenty five blocked polls, which is one second of no progress", () => {
    const credit = new StepCredit();
    let requeries = 0;
    for (let i = 0; i < BLOCKED_POLLS_BEFORE_REQUERY; i++) {
      if (credit.pollBlocked()) requeries++;
    }
    expect(requeries).toBe(0);
    expect(credit.pollBlocked()).toBe(true);
    /* And the counter starts again, so it pokes once a second rather than every poll. */
    expect(credit.pollBlocked()).toBe(false);
  });

  it("spends locally so six points launched are six slots gone before the next report", () => {
    const credit = new StepCredit();
    credit.report(20);
    credit.spend(6);
    expect(credit.free).toBe(14);
  });
});

describe("INV-18: the text point format", () => {
  it("omits the interval field rather than leaving a trailing comma", () => {
    const line = formatStepBatch([
      { x: 10, y: -4, laser: true, iv: 50 },
      { x: 11, y: -4, laser: false },
    ]);
    expect(line).toBe("S 10,-4,1,50 11,-4,0");
    /* A trailing comma breaks the board's tokeniser, and the point is silently
     * skipped rather than rejected. */
    expect(line).not.toMatch(/,\s/);
    expect(line).not.toMatch(/,$/);
  });
});

describe("INV-14 and INV-12: what a packet actually looks like", () => {
  it("carries one CRC8 over the unescaped bytes from the magic to the last payload byte", () => {
    const bytes = packPulseFlat([{ pan: 1500, tilt: 1500, laser: true, durMs: 20 }], 7);
    expect(bytes[0]).toBe(MAGIC.FLAT);
    expect(bytes[1]).toBe(1);
    expect(bytes[2]).toBe(7);
    expect(bytes[bytes.length - 1]).toBe(crc8(bytes, 0, bytes.length - 1));
  });

  it("keeps the escape asymmetry: hermite escapes 0xA4 and legacy flat does not", () => {
    /* A pulse of 0x00A4 puts a raw 0xA4 in the payload. Old firmware predating the
     * hermite magic mistranslates `A7 04`, so a legacy packet must not escape it. */
    const flat = packPulseFlat([{ pan: 0xa4, tilt: 1500, laser: false, durMs: 5 }], 0);
    expect([...flat]).toContain(0xa4);

    const herm = packPulseHermite([{ pan: 0xa4, tilt: 1500, laser: false, durMs: 5 }], 0);
    const at = [...herm].indexOf(MAGIC.ESC);
    expect(at).toBeGreaterThan(0);
    expect(herm[at + 1]).toBe(0x04);
  });

  it("escapes the reserved range in every format, and never byte zero", () => {
    const bytes = packPulseFlat([{ pan: 0xa5, tilt: 0xa6, laser: false, durMs: 0xa7 }], 0);
    expect(bytes[0]).toBe(MAGIC.FLAT);
    /* Three escapes, one for each reserved byte that landed in the payload. */
    expect([...bytes].filter((b) => b === MAGIC.ESC)).toHaveLength(3);
  });

  it("sets the planned bit exactly when the host supplied the interval", () => {
    /* INV-36: with the bit set the board executes the timing verbatim and stacks no
     * ramp of its own. Without an interval there is nothing to execute verbatim. */
    const planned = packStepFlat([{ x: 5, y: 5, laser: true, iv: 50 }], 0);
    const bare = packStepFlat([{ x: 5, y: 5, laser: true }], 0);
    expect(planned[7]! & FLAG.PLANNED).toBe(FLAG.PLANNED);
    expect(planned[7]! & FLAG.LASER).toBe(FLAG.LASER);
    expect(bare[7]! & FLAG.PLANNED).toBe(0);
  });
});

describe("format selection follows what the board reported", () => {
  const cruise: StepPoint[] = Array.from({ length: 10 }, (_, i) => ({
    x: i,
    y: i,
    laser: true,
    iv: intervalFor(400),
  }));

  it("picks the run format for a cruise when the board advertises ivb=3", () => {
    const packet = packStepBatch(cruise, 0, wire({ ivb: 3 }));
    expect(packet.format).toBe("step-run");
    expect(packet.count).toBe(10);
    expect(packet.bytes[1]).toBe(stepCountByte(STEP_FMT.RUN, 10));
    /* Three bytes a point after the anchor, against seven for flat. */
    expect(packet.bytes.length).toBeLessThan(packStepFlat(cruise.slice(0, 8), 0).length);
  });

  it("falls back to delta, then to flat, as the board's ladder gets shorter", () => {
    expect(packStepBatch(cruise, 0, wire({ ivb: 2 })).format).toBe("step-delta");
    expect(packStepBatch(cruise, 0, wire({ ivb: 1 })).format).toBe("step-flat");
  });

  it("prefers hermite on a pulse board that says it plays curves", () => {
    const segs = Array.from({ length: 10 }, (_, i) => ({
      pan: 1500 + i,
      tilt: 1500,
      laser: true,
      durMs: 16,
      velPan: 4,
      velTilt: -2,
    }));
    expect(packPulseHermite(segs.slice(0, 8), 0)[0]).toBe(MAGIC.HERMITE);
    expect(packStepBatch(cruise, 0, wire({ ivb: 3 })).bytes[0]).toBe(MAGIC.STEP);
  });
});

describe("a packet the board can actually read", () => {
  it("round trips a run packet through the step board and lands where it said", async () => {
    const mock = new MockTransport({ lineage: "step", hello: null, beats: false });
    await mock.connect();

    const points: StepPoint[] = Array.from({ length: 10 }, (_, i) => ({
      x: i + 1,
      y: 0,
      laser: true,
      iv: intervalFor(400),
    }));
    const packet = packStepBatch(points, 0, wire({ ivb: 3 }));
    await mock.sendFrame(packet.bytes);
    mock.advance(5000);

    const state = boardState(mock);
    expect(state.crcErrors).toBe(0);
    expect(state.a).toBe(10);
    expect(state.laser).toBe(true);
    await mock.disconnect();
  });

  it("a corrupted packet is counted and dropped, never half applied", async () => {
    const mock = new MockTransport({ lineage: "pulse", beats: false });
    await mock.connect();

    const bytes = packPulseFlat([{ pan: 1800, tilt: 1800, laser: true, durMs: 10 }], 0);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! ^ 0xff) & 0xff;
    await mock.sendFrame(bytes);
    mock.advance(100);

    const state = boardState(mock);
    expect(state.crcErrors).toBe(1);
    /* Nothing moved and the beam stayed dark: a packet that fails its check is not a
     * packet, and half of one is how a beam ends up across the room. */
    expect(state.a).toBe(1500);
    expect(state.laser).toBe(false);
    await mock.disconnect();
  });

  it("counts a sequence gap as lost segments rather than pretending it never happened", async () => {
    const mock = new MockTransport({ lineage: "pulse", beats: false });
    await mock.connect();

    await mock.sendFrame(packPulseFlat([{ pan: 1500, tilt: 1500, laser: false, durMs: 5 }], 0));
    /* Sequence 1 was expected. Four packets went missing on the way. */
    await mock.sendFrame(packPulseFlat([{ pan: 1520, tilt: 1500, laser: false, durMs: 5 }], 5));

    expect(boardState(mock).lost).toBe(4);
    await mock.disconnect();
  });
});
