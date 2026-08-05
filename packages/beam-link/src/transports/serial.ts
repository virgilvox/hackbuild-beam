/*
 * Web Serial.
 *
 * Works from file:// in Chromium, which treats it as a secure context. The shipped
 * tools prove it daily and the single file build depends on it, so nothing here may
 * grow a requirement for a server.
 *
 * Web Serial is not in the DOM lib, so the shapes it needs are declared here
 * structurally rather than pulled in as an ambient dependency. They are the four
 * calls this transport actually makes and no more.
 */

import { SERIAL_BAUD } from "@virgilvox/beam-core";
import type { Transport } from "../index.js";

interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  addEventListener?(type: "disconnect", cb: () => void): void;
}

interface SerialLike {
  requestPort(options?: { filters?: unknown[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

function serialApi(): SerialLike {
  const api = (navigator as unknown as { serial?: SerialLike }).serial;
  if (!api) {
    throw new Error("Web Serial is unavailable. Use Chrome or Edge, over https or file://.");
  }
  return api;
}

export interface WebSerialOptions {
  baudRate?: number;
  /** An already chosen port, so a caller can reconnect without a second prompt. */
  port?: SerialPortLike;
}

export class WebSerialTransport implements Transport {
  readonly kind = "serial" as const;
  pending = 0;

  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private lineCbs = new Set<(line: string) => void>();
  private closeCbs = new Set<() => void>();
  private open = false;

  constructor(private readonly opts: WebSerialOptions = {}) {}

  /** Whether this browser can do it at all, without prompting for a port. */
  static available(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  async connect(): Promise<void> {
    if (this.open) return;
    const port = this.opts.port ?? (await serialApi().requestPort());
    await port.open({ baudRate: this.opts.baudRate ?? SERIAL_BAUD });
    this.port = port;
    const writable = port.writable;
    if (!writable) throw new Error("serial port opened with no writable stream");
    this.writer = writable.getWriter();
    this.open = true;
    /*
     * Opening the port may reset the board over DTR, which produces a boot banner
     * before anything has been asked for. That banner is useful and it is also the
     * reason classification cannot depend on one: a BLE connect never resets
     * anything, so the same board is silent until it is probed.
     */
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const readable = this.port?.readable;
    if (!readable) return;
    const reader = readable.getReader();
    this.reader = reader;
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (this.open) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        buf += decoder.decode(value, { stream: true });
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, "").trim();
          buf = buf.slice(i + 1);
          if (line) this.deliver(line);
          i = buf.indexOf("\n");
        }
        /* A line that never ends is framing debris, not a message. Drop it rather
         * than growing a buffer for the rest of the session. */
        if (buf.length > 4096) buf = "";
      }
    } catch {
      /* The reader was cancelled on disconnect, or the device went away. */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
      if (this.open) await this.teardown();
    }
  }

  async sendLine(text: string): Promise<void> {
    await this.write(new TextEncoder().encode(`${text}\n`));
  }

  /** Raw bytes, no newline and no encoding: a packet is built to be sent whole. */
  async sendFrame(bytes: Uint8Array): Promise<void> {
    await this.write(bytes);
  }

  private async write(bytes: Uint8Array): Promise<void> {
    const writer = this.writer;
    if (!writer) throw new Error("serial port is not open");
    this.pending++;
    try {
      await writer.write(bytes);
    } finally {
      this.pending = Math.max(0, this.pending - 1);
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
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    this.open = false;
    const { reader, writer, port } = this;
    this.reader = null;
    this.writer = null;
    this.port = null;
    try {
      if (reader) await reader.cancel();
    } catch {
      /* already gone */
    }
    try {
      if (writer) writer.releaseLock();
    } catch {
      /* already released */
    }
    try {
      if (port) await port.close();
    } catch {
      /* already closed */
    }
    this.pending = 0;
    for (const cb of [...this.closeCbs]) cb();
  }

  private deliver(line: string): void {
    for (const cb of [...this.lineCbs]) cb(line);
  }
}
