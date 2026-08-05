import { describe, expect, it } from "vitest";
import {
  ESCAPE_LOW,
  FLAG,
  FORMATS,
  LINEAGE,
  MAGIC,
  PROBE,
  STEP_FMT,
  intervalToDurationMs,
  packetSize,
  parseStepCountByte,
  rateToInterval,
  stepCountByte,
} from "./spec.js";
import { crc8 } from "./crc8.js";
import { escapeFrame, isFrameOpener, isMagic, unescapeByte } from "./frame.js";

describe("packet sizes match the firmware framer's own arithmetic", () => {
  const byName = Object.fromEntries(FORMATS.map((f) => [f.name, f]));

  it("pulse formats are byte for byte what the shipped firmware validates", () => {
    /* need = 3 + count*8 + 1, max 68 */
    expect(packetSize(byName["hermite"]!, 8)).toBe(68);
    /* need = 3 + count*6 + 1, max 64 */
    expect(packetSize(byName["flat"]!, 10)).toBe(64);
    /* need = 3 + 6 + (count-1)*4 + 1, max 46 */
    expect(packetSize(byName["delta"]!, 10)).toBe(46);
  });

  it("step formats fit inside one BLE write at their maximum count", () => {
    expect(packetSize(byName["step-flat"]!, 8)).toBe(60);
    expect(packetSize(byName["step-delta"]!, 10)).toBe(56);
    expect(packetSize(byName["step-run"]!, 15)).toBe(53);

    /* The whole point of the fit loop is that escaping can push a packet past one
     * write. Starting under the 176 byte budget by this much means only a
     * pathological payload ever trips it. */
    for (const f of FORMATS) {
      expect(packetSize(f, f.maxCount)).toBeLessThan(176);
    }
  });

  it("step-run is the cheapest per point, which is why it is the cruise format", () => {
    const perPoint = (name: string, n: number) => packetSize(byName[name]!, n) / n;
    expect(perPoint("step-run", 15)).toBeLessThan(perPoint("step-delta", 10));
    expect(perPoint("step-delta", 10)).toBeLessThan(perPoint("step-flat", 8));
    /* Against roughly 18 characters per point in the text protocol. */
    expect(perPoint("step-run", 15)).toBeLessThan(4);
  });
});

describe("the magic byte keys the domain", () => {
  it("every format declares a domain and no magic serves two", () => {
    const byMagic = new Map<number, Set<string>>();
    for (const f of FORMATS) {
      const key = f.magic;
      if (!byMagic.has(key)) byMagic.set(key, new Set());
      byMagic.get(key)!.add(f.domain);
    }
    for (const [, domains] of byMagic) {
      expect(domains.size).toBe(1);
    }
  });

  it("all magics live in the 0xA0..0xAF window the escape mechanism can express", () => {
    for (const f of FORMATS) {
      expect(f.magic).toBeGreaterThanOrEqual(0xa0);
      expect(f.magic).toBeLessThanOrEqual(0xaf);
    }
    expect(MAGIC.ESC).toBe(0xa7);
  });

  it("step formats are signed and pulse formats are not", () => {
    for (const f of FORMATS) {
      const pos = f.segment.concat(f.anchor ?? []).filter((s) => /^(x|y|pan|tilt)$/.test(s.name));
      for (const p of pos) {
        if (f.domain === "step") expect(p.type).toBe("i16le");
        else expect(p.type).toBe("u16le");
      }
    }
  });

  it("pulse formats carry a duration and step formats carry an interval, never both", () => {
    for (const f of FORMATS) {
      const names = f.segment.concat(f.anchor ?? [], f.prefix ?? []).map((s) => s.name);
      const hasDur = names.includes("dur");
      const hasIv = names.includes("iv");
      expect(hasDur && hasIv).toBe(false);
      expect(f.domain === "pulse" ? hasDur : hasIv).toBe(true);
    }
  });
});

describe("the step count byte packs a sub-format nibble", () => {
  it("round trips every legal fmt and count", () => {
    for (const fmt of [STEP_FMT.FLAT, STEP_FMT.DELTA, STEP_FMT.RUN]) {
      for (let count = 1; count <= 15; count++) {
        const b = stepCountByte(fmt, count);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(255);
        expect(parseStepCountByte(b)).toEqual({ fmt, count });
      }
    }
  });

  it("a run packet's count of 15 still fits the nibble", () => {
    expect(parseStepCountByte(stepCountByte(STEP_FMT.RUN, 15))).toEqual({ fmt: 2, count: 15 });
  });
});

describe("the flags byte", () => {
  it("is bits, not booleans", () => {
    expect(FLAG.LASER).toBe(0x01);
    expect(FLAG.PLANNED).toBe(0x02);
  });

  it("expresses a planned travel move: planned set, gate clear", () => {
    /* The backlash take-up is the opposite case and it matters: bit 1 clear so the
     * firmware ramp applies, bit 0 clear so the beam stays off. */
    const plannedTravel = FLAG.PLANNED;
    expect(plannedTravel & FLAG.PLANNED).toBeTruthy();
    expect(plannedTravel & FLAG.LASER).toBeFalsy();

    const lashTakeUp = 0;
    expect(lashTakeUp & FLAG.PLANNED).toBeFalsy();
    expect(lashTakeUp & FLAG.LASER).toBeFalsy();
  });

  it("leaves bits 2 to 7 free for additive extension", () => {
    expect(FLAG.LASER | FLAG.PLANNED).toBe(0x03);
  });
});

describe("crc8", () => {
  it("is CRC-8/ATM: poly 0x07, init 0, no reflection, no final xor", () => {
    /* The classic check value for this parameterisation. */
    expect(crc8(new Uint8Array([...Buffer.from("123456789", "ascii")]))).toBe(0xf4);
  });

  it("is zero over an empty range", () => {
    expect(crc8(new Uint8Array([]))).toBe(0);
  });

  it("catches the single byte splice a lost BLE chunk produces", () => {
    const a = new Uint8Array([MAGIC.FLAT, 2, 0, 0xdc, 0x05, 0xb8, 0x0b, 0x01, 0x11]);
    const b = Uint8Array.from(a);
    b[4] = 0x06; // one byte of a pulse value changed
    expect(crc8(a)).not.toBe(crc8(b));
  });
});

describe("escaping", () => {
  it("never escapes byte 0, so the magic stays recognisable", () => {
    const b = new Uint8Array([MAGIC.FLAT, 0x01, 0x02]);
    expect(escapeFrame(b, ESCAPE_LOW.LEGACY)[0]).toBe(MAGIC.FLAT);
  });

  it("escapes the reserved range as A7 plus the low nibble", () => {
    const b = new Uint8Array([MAGIC.FLAT, 0xa5, 0xa6, 0xa7]);
    const out = escapeFrame(b, ESCAPE_LOW.LEGACY);
    expect(Array.from(out)).toEqual([MAGIC.FLAT, 0xa7, 0x05, 0xa7, 0x06, 0xa7, 0x07]);
  });

  it("round trips through the receiver's reconstruction", () => {
    for (const v of [0xa3, 0xa4, 0xa5, 0xa6, 0xa7]) {
      expect(unescapeByte(v & 0x0f)).toBe(v);
    }
  });

  it("returns the input untouched when nothing needs escaping", () => {
    const b = new Uint8Array([MAGIC.FLAT, 0x10, 0x20]);
    expect(escapeFrame(b, ESCAPE_LOW.LEGACY)).toBe(b);
  });

  it("preserves the documented legacy asymmetry", () => {
    /* A payload 0xA4 goes out raw under the legacy floor, because firmware that
     * predates the hermite magic would mistranslate A7 04. This is the behavior that
     * costs a packet, and the receiver side is where it gets fixed. */
    const b = new Uint8Array([MAGIC.FLAT, 0xa4]);
    expect(Array.from(escapeFrame(b, ESCAPE_LOW.LEGACY))).toEqual([MAGIC.FLAT, 0xa4]);
    expect(Array.from(escapeFrame(b, ESCAPE_LOW.HERMITE))).toEqual([MAGIC.FLAT, 0xa7, 0x04]);
  });

  it("the uniform floor covers the step magic, ending the asymmetry", () => {
    const b = new Uint8Array([MAGIC.STEP, 0xa3, 0xa4]);
    expect(Array.from(escapeFrame(b, ESCAPE_LOW.UNIFORM))).toEqual([
      MAGIC.STEP,
      0xa7,
      0x03,
      0xa7,
      0x04,
    ]);
  });

  it("costs what the floor says it costs, and the uniform floor is not free", () => {
    /*
     * The original records "about one byte in eighty" and that figure is for the
     * LEGACY floor: 3 reserved values in 256 is 1.17 percent, one byte in 85.
     *
     * The uniform floor reserves 5 values, which is 1.95 percent, one byte in 51.
     * Ending the escape asymmetry therefore costs about 67 percent more escaping
     * than the legacy path. That is a real trade and it is worth naming rather than
     * rounding away: it buys a framer where the escaped set equals the restart set,
     * which is the defect class that produced the asymmetry in the first place.
     */
    const payload = new Uint8Array(800);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;
    payload[0] = MAGIC.STEP;
    const uniform = escapeFrame(payload, ESCAPE_LOW.UNIFORM).length / payload.length;
    const legacy = escapeFrame(payload, ESCAPE_LOW.LEGACY).length / payload.length;

    expect(uniform).toBeCloseTo(1 + 5 / 256, 2);
    expect(legacy).toBeCloseTo(1 + 3 / 256, 2);
    expect(uniform).toBeGreaterThan(legacy);
  });

  it("recognises openers", () => {
    expect(isMagic(MAGIC.STEP)).toBe(true);
    expect(isMagic(MAGIC.HERMITE)).toBe(true);
    expect(isMagic(MAGIC.ESC)).toBe(false);
    expect(isMagic(0x3f)).toBe(false); // the probe character
  });
});

describe("classification", () => {
  it("the probe cannot be mistaken for a frame opener", () => {
    expect(PROBE).toBe("?");
    expect(isMagic(PROBE.charCodeAt(0))).toBe(false);
    expect(PROBE.charCodeAt(0)).toBeLessThan(0xa0);
  });

  it("distinguishes the two lineages by the case of the status prefix", () => {
    expect(LINEAGE.pulse.test("STAT pan=1500 tilt=1500 q=47")).toBe(true);
    expect(LINEAGE.step.test("STAT pan=1500")).toBe(false);

    expect(LINEAGE.step.test("st q=0 free=255 px=0 py=0")).toBe(true);
    expect(LINEAGE.pulse.test("st q=0 free=255")).toBe(false);
  });
});

describe("interval and duration", () => {
  it("rate to interval truncates toward zero, matching C", () => {
    expect(rateToInterval(400, 20000)).toBe(50);
    expect(rateToInterval(700, 20000)).toBe(28); // 28.57 truncates, not rounds
  });

  it("duration in the step domain is an exact integer relation, not a rounding", () => {
    /* 100 dominant axis steps at 50 ticks each, 20 kHz: exactly 250 ms. */
    expect(intervalToDurationMs(50, 100, 20000)).toBe(250);
  });

  it("reports zero rather than dividing by a board with no step clock", () => {
    expect(intervalToDurationMs(50, 100, 0)).toBe(0);
  });

  it("expresses sub-millisecond timing that a whole ms field could not carry", () => {
    /* One step at 20000 steps per second is 0.05 ms. A whole millisecond field would
     * floor this to 1 and run it twenty times too slow, which is why the step domain
     * carries an interval and not a duration. */
    expect(intervalToDurationMs(1, 1, 20000)).toBeCloseTo(0.05, 10);
    expect(Math.max(1, Math.round(0.05))).toBe(1);
  });
});

describe("the frame opener fix, INV-13", () => {
  it("restarts on a magic byte only when no frame is open", () => {
    /* An 0xA4 arriving while a legacy packet is being assembled is a payload byte,
     * not a new packet: the shipped sender does not escape it under the legacy
     * floor. Restarting there is what costs a good packet. */
    expect(isFrameOpener(MAGIC.HERMITE, false)).toBe(true);
    expect(isFrameOpener(MAGIC.HERMITE, true)).toBe(false);
  });

  it("still opens on every magic when idle, so a real packet is never missed", () => {
    for (const m of [MAGIC.STEP, MAGIC.HERMITE, MAGIC.FLAT, MAGIC.DELTA]) {
      expect(isFrameOpener(m, false)).toBe(true);
    }
  });

  it("never opens on the escape byte or on text", () => {
    expect(isFrameOpener(MAGIC.ESC, false)).toBe(false);
    expect(isFrameOpener(0x3f, false)).toBe(false);
  });
});
