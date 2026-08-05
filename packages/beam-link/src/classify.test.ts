import { describe, expect, it } from "vitest";
import { LINEAGE, PROBE } from "@virgilvox/beam-core";
import { classify, isHello, lineageOf, numericKv, parseKv, wireCapsFrom } from "./classify.js";
import { MockTransport, boardState } from "./transports/mock.js";
import type { Transport } from "./index.js";

/**
 * A transport that keeps an ordered record of what went out and what came back, so a
 * test can assert not only WHAT was written but WHEN, relative to the answer that made
 * it safe to write it.
 */
class SpyTransport implements Transport {
  readonly kind = "mock" as const;
  readonly log: Array<{ dir: "tx" | "rx"; text: string }> = [];

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

describe("INV-62a: the probe is the only thing that may be sent", () => {
  it("classifies a pulse board and writes nothing but the probe to do it", async () => {
    const mock = new MockTransport({ lineage: "pulse", beats: false });
    const spy = new SpyTransport(mock);
    await spy.connect();

    /* Opening a USB serial port resets the board over DTR, so the banner arrives
     * before anything was asked for. It is a hint, never a requirement: the caller
     * hands it in and classification proceeds the same way without it. */
    const banner = spy.log[0];
    expect(banner?.dir).toBe("rx");
    expect(banner?.text).toMatch(/^READY LASER RIG/);

    const found = await classify(spy, { hello: banner?.text ?? "" });

    expect(found.lineage).toBe("pulse");
    expect(spy.writes).toEqual([PROBE]);
    expect(found.hello).toMatch(/^READY LASER RIG/);
    expect(found.wire.bin).toBe(2);
    expect(found.wire.herm).toBe(true);
    expect(found.status["q"]).toBe(47);
    await mock.disconnect();
  });

  it("classifies a step board over a link that never produces a banner", async () => {
    /* A BLE connect never resets the board, so there is no hello line at all. If
     * classification needed one it would work on serial and fail on radio. */
    const mock = new MockTransport({ lineage: "step", hello: null, beats: false });
    const spy = new SpyTransport(mock);
    await spy.connect();

    const found = await classify(spy);

    expect(found.lineage).toBe("step");
    expect(found.hello).toBe("");
    expect(spy.writes).toEqual([PROBE]);
    await mock.disconnect();
  });

  it("returns on the answer rather than sitting out the retry window", async () => {
    /*
     * A retry window three seconds wide that a healthy board never waits on. Without
     * the early wake, classification costs the full spacing on every connect and the
     * probes stop fitting inside the budget the moment a caller widens the spacing,
     * which is the failure that budget arithmetic is there to prevent. Nothing else in
     * this file can see the difference: the write log and the lineage come out
     * identical either way, only slower.
     */
    const mock = new MockTransport({ lineage: "pulse", beats: false });
    const spy = new SpyTransport(mock);
    await spy.connect();

    const found = await classify(spy, { retryMs: 3000, timeoutMs: 9000, maxRetries: 2 });

    expect(found.lineage).toBe("pulse");
    expect(found.probes).toBe(1);
    expect(found.elapsedMs).toBeLessThan(200);
    expect(spy.writes).toEqual([PROBE]);
    await mock.disconnect();
  });

  it("stops when the link drops instead of spending the rest of the budget on a dead port", async () => {
    const mock = new MockTransport({ lineage: "step", hello: null, silent: true });
    const spy = new SpyTransport(mock);
    await spy.connect();

    /* Not awaited: the drop has to land while the probe window is open. */
    const pending = classify(spy, { retryMs: 400, timeoutMs: 3000, maxRetries: 2 });
    await mock.disconnect();
    const found = await pending;

    expect(found.lineage).toBeNull();
    expect(found.probes).toBe(1);
    expect(found.elapsedMs).toBeLessThan(200);
    expect(spy.writes).toEqual([PROBE]);
  });

  it("gives up after two retries and stays in simulator mode, still having sent only probes", async () => {
    const mock = new MockTransport({ lineage: "step", hello: null, silent: true });
    const spy = new SpyTransport(mock);
    await spy.connect();

    const found = await classify(spy, { retryMs: 5, timeoutMs: 20, maxRetries: 2 });

    expect(found.lineage).toBeNull();
    expect(found.probes).toBe(3);
    expect(spy.writes).toEqual([PROBE, PROBE, PROBE]);
    await mock.disconnect();
  });
});

describe("INV-62b: lineage is the case of the status prefix", () => {
  it("uppercase STAT is pulse and lowercase st is step", () => {
    expect(lineageOf("STAT pan=1500 tilt=1500 q=47")).toBe("pulse");
    expect(lineageOf("st q=0 free=255 run=0")).toBe("step");
  });

  it("matches case sensitively, which is what makes the two distinguishable at all", () => {
    /* Both shipped apps already match their own prefix case sensitively, so this
     * costs nothing to adopt and it is the entire discriminator. */
    expect(lineageOf("stat pan=1500")).toBeNull();
    expect(lineageOf("ST q=0 free=255")).toBeNull();
    expect(LINEAGE.pulse.test("STAT ")).toBe(true);
    expect(LINEAGE.step.test("st ")).toBe(true);
  });

  it("only counts at the start of the line", () => {
    expect(lineageOf("ok st q=1")).toBeNull();
  });
});

describe("what the probe is protecting you from", () => {
  /*
   * These run the collision on purpose, against the model of the shipped parser. They
   * are the reason INV-62a is a safety rule and not tidiness.
   */
  it("ECHO 0 sent to a step board releases both coil sets", async () => {
    const mock = new MockTransport({ lineage: "step", hello: null, beats: false });
    await mock.connect();
    expect(boardState(mock).coilsLive).toBe(true);

    /* `E` with rest "CHO 0", which parses as zero. The rig goes limp. */
    await mock.sendLine("ECHO 0");

    expect(boardState(mock).coilsLive).toBe(false);
    await mock.disconnect();
  });

  it("M 1500 1500 0 sent to a step board is a millimetre move, unclamped", async () => {
    const mock = new MockTransport({ lineage: "step", hello: null, beats: false });
    await mock.connect();

    await mock.sendLine("M 1500 1500 0");
    mock.advance(60_000);

    const state = boardState(mock);
    /* The field is 120 mm across, which is about 110 half steps from its centre.
     * This lands several times outside it, beam off but the mirrors gone, because
     * soft limits default off. */
    expect(Math.abs(state.a)).toBeGreaterThan(250);
    expect(Math.abs(state.b)).toBeGreaterThan(250);
    await mock.disconnect();
  });

  it("M 10 20 1 sent to a pulse board clamps to the corner with the beam lit", async () => {
    const mock = new MockTransport({ lineage: "pulse", beats: false });
    await mock.connect();

    await mock.sendLine("M 10 20 1");

    const state = boardState(mock);
    expect(state.a).toBe(500);
    expect(state.b).toBe(500);
    expect(state.laser).toBe(true);
    await mock.disconnect();
  });

  it("PING is one of the harmless ones: P with an unparseable argument only reads", async () => {
    const mock = new MockTransport({ lineage: "step", hello: null, beats: false });
    const seen: string[] = [];
    mock.onLine((l) => seen.push(l));
    await mock.connect();

    await mock.sendLine("PING");

    /* `P` plus "ING" parses no arguments, so it falls to the read only corner dump
     * rather than capturing a corner over whatever was armed. */
    expect(seen.some((l) => l.startsWith("corners set="))).toBe(true);
    expect(boardState(mock).a).toBe(0);
    await mock.disconnect();
  });

  it("the probe itself can never open a binary frame", () => {
    /* 0x3F is outside the 0xA0..0xAF magic range, so it cannot be mistaken for the
     * start of a packet no matter what state the framer is in. */
    expect(PROBE).toBe("?");
    expect(PROBE.charCodeAt(0)).toBe(0x3f);
    expect(PROBE.charCodeAt(0) < 0xa0).toBe(true);
  });
});

describe("reading a status line", () => {
  const stat =
    "STAT pan=1500 tilt=1420 laser=0 hp=1500 ht=1500 min=500 max=2500 pol=1 att=1 " +
    "dm=1500 seg=1 bin=2 herm=1 q=47 echo=0 lost=0 crc=0 qd=0";

  it("pulls every key=value token without counting the prefix", () => {
    const kv = parseKv(stat);
    expect(kv["pan"]).toBe("1500");
    expect(kv["herm"]).toBe("1");
    expect(kv["STAT"]).toBeUndefined();
  });

  it("keeps only the numeric tokens as numbers", () => {
    const kv = parseKv("CFG min=500 sv=micro9g ww=305.0 tl=91.20,88.40");
    const n = numericKv(kv);
    expect(n["min"]).toBe(500);
    expect(n["ww"]).toBe(305);
    /* "micro9g" is not a number and must not become NaN in a numeric record. */
    expect(n["sv"]).toBeUndefined();
  });

  it("reads what THIS board negotiated, and never assumes it", () => {
    const caps = wireCapsFrom(parseKv(stat));
    expect(caps).toEqual({ seg: true, bin: 2, herm: true, ivb: 0, tick: 0, esc: 1, proto: 0 });
  });

  it("infers a queue on a legacy step board, which advertises no tokens at all", () => {
    const caps = wireCapsFrom(parseKv("st q=0 free=255 px=0 py=0 run=0 drop=0 rate=400"));
    expect(caps.seg).toBe(true);
    expect(caps.ivb).toBe(0);
    /* Zero means this board has no step clock the host may divide by. The tick rate
     * comes from the version line instead: it is negotiated, never compiled in. */
    expect(caps.tick).toBe(0);
    expect(caps.proto).toBe(0);
  });

  it("recognises every hello a shipped board can produce", () => {
    expect(isHello("READY LASER RIG 1.4")).toBe(true);
    expect(isHello("detent ready")).toBe(true);
    expect(isHello("detent 1.3 esp32c3 spr=4075.77")).toBe(true);
    expect(isHello("BEAM 2.0")).toBe(true);
    expect(isHello("STAT pan=1500")).toBe(false);
  });
});
