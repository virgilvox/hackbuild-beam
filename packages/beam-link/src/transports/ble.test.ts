import { describe, expect, it } from "vitest";
import { BLE_CHUNK_FLOOR, BLE_CHUNK_START, NUS_RX, NUS_SERVICE, NUS_TX } from "@virgilvox/beam-core";
import { WebBleTransport } from "./ble.js";

/*
 * A GATT stack thin enough to see through.
 *
 * The transport takes an already paired device, so these tests never touch
 * `navigator.bluetooth` and never need a browser. What they do exercise is the part
 * that was paid for on the bench: one serialised writer, writes with response, and the
 * sticky fall back to the twenty byte floor that does not advance the cursor.
 */
class FakeCharacteristic {
  readonly writes: Uint8Array[] = [];
  /** Refuse this many writes, then start accepting. */
  refusals = 0;
  private listener: ((ev: Event) => void) | null = null;
  value?: DataView;

  async writeValueWithResponse(value: BufferSource): Promise<void> {
    if (this.refusals > 0) {
      this.refusals--;
      throw new Error("GATT operation failed for unknown reason");
    }
    this.writes.push(new Uint8Array(value as ArrayBufferLike as ArrayBuffer).slice());
  }

  async startNotifications(): Promise<FakeCharacteristic> {
    return this;
  }

  async stopNotifications(): Promise<FakeCharacteristic> {
    return this;
  }

  addEventListener(_type: string, cb: (ev: Event) => void): void {
    this.listener = cb;
  }

  removeEventListener(): void {
    this.listener = null;
  }

  /** What a notify looks like arriving: a chunk, not a line. */
  notify(text: string): void {
    const bytes = new TextEncoder().encode(text);
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.listener?.({ target: this } as unknown as Event);
  }
}

function fakeDevice(): {
  device: { name: string; gatt: unknown; addEventListener: () => void };
  rx: FakeCharacteristic;
  tx: FakeCharacteristic;
  asked: string[];
} {
  const rx = new FakeCharacteristic();
  const tx = new FakeCharacteristic();
  const asked: string[] = [];
  const service = {
    getCharacteristic: async (uuid: string) => {
      asked.push(uuid);
      return uuid === NUS_RX ? rx : tx;
    },
  };
  const gatt = {
    connected: true,
    connect: async () => gatt,
    disconnect: () => {},
    getPrimaryService: async (uuid: string) => {
      asked.push(uuid);
      return service;
    },
  };
  return {
    device: { name: "LASER RIG", gatt, addEventListener: () => {} },
    rx,
    tx,
    asked,
  };
}

/* The transport's device option is structurally typed against the GATT shapes it
 * declares, and the fake above is exactly that shape. */
const make = (d: ReturnType<typeof fakeDevice>) =>
  new WebBleTransport({ device: d.device as never });

describe("the Nordic UART service, on both rigs", () => {
  it("takes the write characteristic for writing and the notify one for listening", async () => {
    const d = fakeDevice();
    const link = make(d);
    await link.connect();
    expect(d.asked).toEqual([NUS_SERVICE, NUS_RX, NUS_TX]);
    /* The advertised name is for display only. Discovery filters on the service. */
    expect(link.deviceName).toBe("LASER RIG");
    await link.disconnect();
  });

  it("reassembles lines out of whatever the radio happens to deliver", async () => {
    const d = fakeDevice();
    const link = make(d);
    const lines: string[] = [];
    link.onLine((l) => lines.push(l));
    await link.connect();

    /* A notify is a chunk of bytes, not a message. A status line routinely arrives in
     * three of them and two lines routinely arrive in one. */
    d.tx.notify("STAT pan=1500 til");
    expect(lines).toHaveLength(0);
    d.tx.notify("t=1500 q=47\nOK\n");

    expect(lines).toEqual(["STAT pan=1500 tilt=1500 q=47", "OK"]);
    await link.disconnect();
  });
});

/*
 * INV-20: writes go with response, through one serialised writer. Without-response
 * writes vanish silently the moment the radio queue congests.
 *
 * INV-21: adaptive chunking starts at 180 bytes, drops to 20 stickily the first time
 * a write is refused, resends what the refusal bounced, and resets to 180 on a new
 * connection. The retry does not advance the cursor.
 */
describe("writing", () => {
  it("chunks a long frame and writes every chunk with response", async () => {
    const d = fakeDevice();
    const link = make(d);
    await link.connect();

    await link.sendFrame(new Uint8Array(200).fill(7));

    expect(link.chunkSize).toBe(BLE_CHUNK_START);
    expect(d.rx.writes.map((w) => w.length)).toEqual([BLE_CHUNK_START, 20]);
    await link.disconnect();
  });

  it("falls back to the twenty byte floor on a refusal, stickily, without losing the chunk", async () => {
    const d = fakeDevice();
    const link = make(d);
    await link.connect();
    d.rx.refusals = 1;

    await link.sendFrame(new Uint8Array(60).fill(1));

    /* The refused chunk is resent at the floor size: the cursor does not advance,
     * because a bounced write delivered nothing. Sixty bytes then take three writes
     * of twenty rather than one of sixty. */
    expect(link.chunkSize).toBe(BLE_CHUNK_FLOOR);
    expect(d.rx.writes.map((w) => w.length)).toEqual([20, 20, 20]);
    expect(d.rx.writes.reduce((n, w) => n + w.length, 0)).toBe(60);

    /* Sticky: the next frame stays at the floor rather than probing the long path
     * again mid session. */
    await link.sendLine("?");
    expect(link.chunkSize).toBe(BLE_CHUNK_FLOOR);
    await link.disconnect();
  });

  it("resets to the long write on a fresh connection", async () => {
    const d = fakeDevice();
    const link = make(d);
    await link.connect();
    d.rx.refusals = 1;
    await link.sendFrame(new Uint8Array(40));
    expect(link.chunkSize).toBe(BLE_CHUNK_FLOOR);

    await link.disconnect();
    await link.connect();

    expect(link.chunkSize).toBe(BLE_CHUNK_START);
    await link.disconnect();
  });

  it("serialises writes, and its depth is the backpressure signal", async () => {
    const d = fakeDevice();
    const link = make(d);
    await link.connect();

    const a = link.sendLine("one");
    const b = link.sendLine("two");
    const c = link.sendLine("three");
    /* Three writes in flight. The emitter reads exactly this and stops above three,
     * because emitting into a lagging chain is how the board hears silence and then
     * a burst. */
    expect(link.pending).toBe(3);
    await Promise.all([a, b, c]);
    expect(link.pending).toBe(0);

    /* In order, and each one whole. */
    expect(d.rx.writes.map((w) => new TextDecoder().decode(w))).toEqual([
      "one\n",
      "two\n",
      "three\n",
    ]);
    await link.disconnect();
  });

  it("a write that fails at the floor reaches the caller instead of vanishing", async () => {
    const d = fakeDevice();
    const link = make(d);
    await link.connect();
    d.rx.refusals = 2;

    await expect(link.sendFrame(new Uint8Array(10))).rejects.toThrow(/GATT/);
    /* And the chain survives it: a failed write must not skip every write after it. */
    d.rx.refusals = 0;
    await link.sendLine("?");
    expect(d.rx.writes).toHaveLength(1);
    await link.disconnect();
  });

  it("refuses to write at all once the link is gone", async () => {
    const d = fakeDevice();
    const link = make(d);
    await link.connect();
    await link.disconnect();
    await expect(link.sendLine("?")).rejects.toThrow(/not open/);
  });

  it("tells its listeners when the link drops", async () => {
    const d = fakeDevice();
    const link = make(d);
    let closed = 0;
    link.onClose(() => closed++);
    await link.connect();
    await link.disconnect();
    expect(closed).toBe(1);
  });
});
