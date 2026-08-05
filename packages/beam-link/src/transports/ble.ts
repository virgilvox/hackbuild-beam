/*
 * Web Bluetooth, over the Nordic UART Service.
 *
 * INV-62c: discovery filters on the SERVICE UUID and never on the device name. The
 * step app filters on a "DETENT" name prefix today, which cannot see a "LASER RIG"
 * board at all. Both firmwares call addServiceUUID with the NUS service, so one
 * service filter finds both rigs and every future one for free. The advertised name
 * is for display only.
 *
 * INV-20: writes go WITH RESPONSE, through one serialised chain. Without-response
 * writes vanish silently the moment the radio queue congests, and a vanished packet
 * is dropped geometry under a lit laser. The bench log that forced this rework showed
 * the board's lost counter jumping by twenty-nine in one beat.
 *
 * INV-21: the chunk starts at the large MTU modern stacks negotiate and falls back to
 * the twenty byte floor the first time a write is refused, stickily, resending what
 * the refusal bounced. The retry does not advance the cursor, because a bounced write
 * delivered nothing.
 *
 * Web Bluetooth is not in the DOM lib, so the shapes are declared structurally here.
 */

import {
  BLE_CHUNK_FLOOR,
  BLE_CHUNK_START,
  NUS_RX,
  NUS_SERVICE,
  NUS_TX,
} from "@virgilvox/beam-core";
import type { Transport } from "../index.js";

interface GattCharacteristicLike {
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  writeValue?(value: BufferSource): Promise<void>;
  startNotifications(): Promise<GattCharacteristicLike>;
  stopNotifications?(): Promise<GattCharacteristicLike>;
  addEventListener(type: string, cb: (ev: Event) => void): void;
  removeEventListener(type: string, cb: (ev: Event) => void): void;
  readonly value?: DataView;
}

interface GattServiceLike {
  getCharacteristic(uuid: string): Promise<GattCharacteristicLike>;
}

interface GattServerLike {
  readonly connected: boolean;
  connect(): Promise<GattServerLike>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<GattServiceLike>;
}

interface BluetoothDeviceLike {
  readonly name?: string;
  readonly gatt?: GattServerLike;
  addEventListener(type: string, cb: () => void): void;
}

interface BluetoothLike {
  requestDevice(options: {
    filters?: Array<{ services?: string[]; namePrefix?: string }>;
    optionalServices?: string[];
    acceptAllDevices?: boolean;
  }): Promise<BluetoothDeviceLike>;
}

function bluetoothApi(): BluetoothLike {
  const api = (navigator as unknown as { bluetooth?: BluetoothLike }).bluetooth;
  if (!api) throw new Error("Web Bluetooth is unavailable in this browser.");
  return api;
}

export interface WebBleOptions {
  /** An already paired device, so a caller can reconnect without a second prompt. */
  device?: BluetoothDeviceLike;
  service?: string;
  rx?: string;
  tx?: string;
}

export class WebBleTransport implements Transport {
  readonly kind = "ble" as const;
  pending = 0;

  /** Sticky, and reset to the long value on every fresh connection. */
  chunkSize = BLE_CHUNK_START;

  private device: BluetoothDeviceLike | null = null;
  private write$: GattCharacteristicLike | null = null;
  private notify$: GattCharacteristicLike | null = null;
  private chain: Promise<void> = Promise.resolve();
  private lineCbs = new Set<(line: string) => void>();
  private closeCbs = new Set<() => void>();
  private buf = "";
  private open = false;

  constructor(private readonly opts: WebBleOptions = {}) {}

  static available(): boolean {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  /** The advertised name, for display only. Never for discovery. */
  get deviceName(): string {
    return this.device?.name ?? "";
  }

  async connect(): Promise<void> {
    if (this.open) return;
    const service = this.opts.service ?? NUS_SERVICE;
    const device =
      this.opts.device ??
      (await bluetoothApi().requestDevice({
        /* The service filter, and nothing else. A name filter cannot see the other
         * rig at all. */
        filters: [{ services: [service] }],
        optionalServices: [service],
      }));
    this.device = device;
    device.addEventListener("gattserverdisconnected", () => {
      if (this.open) this.teardown();
    });

    const gatt = device.gatt;
    if (!gatt) throw new Error("this device exposes no GATT server");
    const server = await gatt.connect();
    const svc = await server.getPrimaryService(service);
    this.write$ = await svc.getCharacteristic(this.opts.rx ?? NUS_RX);
    this.notify$ = await svc.getCharacteristic(this.opts.tx ?? NUS_TX);
    await this.notify$.startNotifications();
    this.notify$.addEventListener("characteristicvaluechanged", this.onNotify);

    /* A fresh link: probe the long write path again. The fallback is sticky within a
     * connection and only within one. */
    this.chunkSize = BLE_CHUNK_START;
    this.chain = Promise.resolve();
    this.buf = "";
    this.pending = 0;
    this.open = true;
  }

  private readonly onNotify = (ev: Event): void => {
    const target = ev.target as GattCharacteristicLike | null;
    const view = target?.value;
    if (!view) return;
    this.buf += new TextDecoder().decode(view);
    let i = this.buf.indexOf("\n");
    while (i >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "").trim();
      this.buf = this.buf.slice(i + 1);
      if (line) for (const cb of [...this.lineCbs]) cb(line);
      i = this.buf.indexOf("\n");
    }
    if (this.buf.length > 4096) this.buf = "";
  };

  async sendLine(text: string): Promise<void> {
    await this.enqueue(new TextEncoder().encode(`${text}\n`));
  }

  async sendFrame(bytes: Uint8Array): Promise<void> {
    await this.enqueue(bytes);
  }

  /**
   * One serialised writer for everything.
   *
   * The depth of this chain is `pending`, and it is the transport's honest word on how
   * far behind the radio is running. The emitter reads it and stops (INV-22): emitting
   * into a lagging chain is how the board hears silence for a second and then a burst.
   */
  private enqueue(bytes: Uint8Array): Promise<void> {
    if (!this.open || !this.write$) return Promise.reject(new Error("bluetooth link is not open"));
    this.pending++;
    const next = this.chain.then(() => this.writeChunks(bytes));
    /* The chain must survive a failed write or every later write is skipped. Errors
     * are surfaced to this caller and swallowed for the chain. */
    this.chain = next.catch(() => {});
    return next.finally(() => {
      this.pending = Math.max(0, this.pending - 1);
    });
  }

  private async writeChunks(bytes: Uint8Array): Promise<void> {
    const ch = this.write$;
    if (!ch) throw new Error("bluetooth link is not open");
    for (let i = 0; i < bytes.length; ) {
      const chunk = bytes.slice(i, i + this.chunkSize);
      try {
        if (ch.writeValueWithResponse) await ch.writeValueWithResponse(chunk);
        else if (ch.writeValue) await ch.writeValue(chunk);
        else if (ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(chunk);
        else throw new Error("characteristic accepts no write");
        i += chunk.length;
      } catch (err) {
        /* Sticky fallback, and the cursor does not advance: the refused chunk is
         * resent at the floor size. Already at the floor means the link is genuinely
         * broken and the caller has to hear about it. */
        if (this.chunkSize > BLE_CHUNK_FLOOR) this.chunkSize = BLE_CHUNK_FLOOR;
        else throw err;
      }
    }
  }

  onLine(cb: (line: string) => void): () => void {
    this.lineCbs.add(cb);
    return () => this.lineCbs.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  async disconnect(): Promise<void> {
    if (!this.open) return;
    const gatt = this.device?.gatt;
    this.teardown();
    try {
      if (gatt?.connected) gatt.disconnect();
    } catch {
      /* already gone */
    }
    await Promise.resolve();
  }

  /**
   * INV-46: the board kills the beam, flushes its queue and re-advertises when the
   * link drops, on its own initiative. Nothing here has to make that happen, and
   * nothing here should assume it did not.
   */
  private teardown(): void {
    this.open = false;
    try {
      this.notify$?.removeEventListener("characteristicvaluechanged", this.onNotify);
    } catch {
      /* the characteristic went away with the link */
    }
    this.write$ = null;
    this.notify$ = null;
    this.pending = 0;
    for (const cb of [...this.closeCbs]) cb();
  }
}
