/*
 * Packet assembly, from the format table in beam-core.
 *
 * Every number here comes out of `FORMATS`, so the sender cannot drift from the
 * document and the firmware header that are generated from the same table. What lives
 * here is only the byte order and the fit rules, which is the part a table cannot
 * express.
 *
 * Three properties are load bearing and are the reason a packet is built rather than
 * streamed:
 *
 *   Absolute positions. A dropped packet cannot corrupt what follows it, which is why
 *   deltas never span packets: each run starts from its own anchor.
 *
 *   INV-14: one CRC8 over the unescaped bytes from the magic through the last payload
 *   byte. BLE writes arrive in chunks, so a lost chunk splices the head of one packet
 *   onto the tail of another. Unchecked, that lands as a wild axis value and the beam
 *   crosses the room.
 *
 *   INV-12: escaping, with the asymmetry intact. Hermite packets escape 0xA4 through
 *   0xA7 and legacy pulse packets escape only 0xA5 through 0xA7, because firmware
 *   predating the hermite magic mistranslates `A7 04`. The step family uses a uniform
 *   0xA3 floor and ends the asymmetry rather than extending it.
 */

import {
  FLAG,
  FORMATS,
  MAGIC,
  STEP_FMT,
  crc8,
  escapeFrame,
  stepCountByte,
  type PacketFormat,
  type WireCaps,
} from "@virgilvox/beam-core";

/** One timed pulse-domain segment, in the units the wire carries. */
export interface PulseSegment {
  /** Pulse microseconds, already clamped to the board's window. */
  pan: number;
  tilt: number;
  laser: boolean;
  /** Whole milliseconds, 1..255. */
  durMs: number;
  /** Arrival velocity in sixteenths of a microsecond per millisecond, -127..127. */
  velPan?: number;
  velTilt?: number;
}

/** One step-domain point. Absolute logical steps; the board computes its own delta. */
export interface StepPoint {
  x: number;
  y: number;
  laser: boolean;
  /**
   * ISR ticks between dominant axis steps. Present means the host planned this
   * segment's timing, which is what sets the planned bit: the board then executes
   * the timing verbatim and stacks no ramp of its own (INV-36).
   */
  iv?: number;
}

function formatByName(name: string): PacketFormat {
  const f = FORMATS.find((x) => x.name === name);
  if (!f) throw new Error(`no packet format named ${name}`);
  return f;
}

const HERMITE = formatByName("hermite");
const FLAT = formatByName("flat");
const DELTA = formatByName("delta");
const STEP_FLAT = formatByName("step-flat");
const STEP_DELTA = formatByName("step-delta");
const STEP_RUN = formatByName("step-run");

const clampDur = (ms: number): number => Math.max(1, Math.min(255, Math.round(ms)));
const clampVel = (v: number | undefined): number => Math.max(-127, Math.min(127, Math.round(v ?? 0)));
const pulseFlags = (s: PulseSegment): number => (s.laser ? FLAG.LASER : 0);
const stepFlags = (p: StepPoint): number =>
  (p.laser ? FLAG.LASER : 0) | (p.iv !== undefined && p.iv > 0 ? FLAG.PLANNED : 0);

/** A cursor that writes little endian and keeps the offset. */
class Writer {
  private o = 0;
  constructor(readonly buf: Uint8Array) {}
  u8(v: number): void {
    this.buf[this.o++] = v & 0xff;
  }
  u16(v: number): void {
    this.buf[this.o++] = v & 0xff;
    this.buf[this.o++] = (v >> 8) & 0xff;
  }
  /** Signed values ride the same two bytes: the receiver reads them back as int16. */
  i16(v: number): void {
    this.u16(v < 0 ? v + 0x10000 : v);
  }
  i8(v: number): void {
    this.u8(v < 0 ? v + 0x100 : v);
  }
  get offset(): number {
    return this.o;
  }
}

function seal(buf: Uint8Array, w: Writer, escapeLow: number): Uint8Array {
  const end = w.offset;
  buf[end] = crc8(buf, 0, end);
  return escapeFrame(buf.subarray(0, end + 1), escapeLow);
}

/* ------------------------------------------------------------------- pulse -- */

/** A5: every pulse absolute. The format every board with `bin>=1` understands. */
export function packPulseFlat(list: readonly PulseSegment[], seq: number): Uint8Array {
  const buf = new Uint8Array(3 + list.length * 6 + 1);
  const w = new Writer(buf);
  w.u8(MAGIC.FLAT);
  w.u8(list.length);
  w.u8(seq & 0xff);
  for (const s of list) {
    w.u16(s.pan);
    w.u16(s.tilt);
    w.u8(pulseFlags(s));
    w.u8(clampDur(s.durMs));
  }
  return seal(buf, w, FLAT.escapeLow);
}

/**
 * A6: absolute anchor then signed byte deltas.
 *
 * Consecutive segments barely differ. Drawing at 96 mm/s a frame apart moves the
 * pulse by about eight microseconds, so carrying two absolute sixteen bit values each
 * time is mostly carrying zeroes. Four bytes a segment instead of six is what pays
 * for planning the path to a tolerance instead of to a clock.
 */
export function packPulseDelta(list: readonly PulseSegment[], seq: number): Uint8Array {
  if (list.length < 2) return packPulseFlat(list, seq);
  const first = list[0]!;
  const buf = new Uint8Array(3 + 6 + (list.length - 1) * 4 + 1);
  const w = new Writer(buf);
  w.u8(MAGIC.DELTA);
  w.u8(list.length);
  w.u8(seq & 0xff);
  w.u16(first.pan);
  w.u16(first.tilt);
  w.u8(pulseFlags(first));
  w.u8(clampDur(first.durMs));
  let pp = first.pan;
  let pt = first.tilt;
  for (let i = 1; i < list.length; i++) {
    const s = list[i]!;
    w.i8(s.pan - pp);
    w.i8(s.tilt - pt);
    w.u8(pulseFlags(s));
    w.u8(clampDur(s.durMs));
    pp = s.pan;
    pt = s.tilt;
  }
  return seal(buf, w, DELTA.escapeLow);
}

/**
 * A4: endpoint plus endpoint velocity.
 *
 * The board curves from wherever it actually is to each endpoint, so these are
 * targets rather than spans and they survive loss gracefully. Eight bytes a segment.
 */
export function packPulseHermite(list: readonly PulseSegment[], seq: number): Uint8Array {
  const buf = new Uint8Array(3 + list.length * 8 + 1);
  const w = new Writer(buf);
  w.u8(MAGIC.HERMITE);
  w.u8(list.length);
  w.u8(seq & 0xff);
  for (const s of list) {
    w.u16(s.pan);
    w.u16(s.tilt);
    w.i8(clampVel(s.velPan));
    w.i8(clampVel(s.velTilt));
    w.u8(pulseFlags(s));
    w.u8(clampDur(s.durMs));
  }
  return seal(buf, w, HERMITE.escapeLow);
}

/**
 * How many of these may travel together as deltas: as many as keep every delta inside
 * a signed byte. A delta that will not fit ends the packet and the next starts fresh
 * from its own anchor.
 */
export function pulseDeltaRun(list: readonly PulseSegment[], cap: number): number {
  if (list.length === 0) return 0;
  let n = 1;
  let pp = list[0]!.pan;
  let pt = list[0]!.tilt;
  while (n < list.length && n < cap) {
    const s = list[n]!;
    const d1 = s.pan - pp;
    const d2 = s.tilt - pt;
    if (d1 < -128 || d1 > 127 || d2 < -128 || d2 > 127) break;
    pp = s.pan;
    pt = s.tilt;
    n++;
  }
  return n;
}

/* -------------------------------------------------------------------- step -- */

/** A3 fmt 0: absolute step target, flags and interval per segment. */
export function packStepFlat(list: readonly StepPoint[], seq: number): Uint8Array {
  const buf = new Uint8Array(3 + list.length * 7 + 1);
  const w = new Writer(buf);
  w.u8(MAGIC.STEP);
  w.u8(stepCountByte(STEP_FMT.FLAT, list.length));
  w.u8(seq & 0xff);
  for (const p of list) {
    w.i16(p.x);
    w.i16(p.y);
    w.u8(stepFlags(p));
    w.u16(p.iv ?? 0);
  }
  return seal(buf, w, STEP_FLAT.escapeLow);
}

/** A3 fmt 1: anchor then signed byte deltas, each still carrying its own interval. */
export function packStepDelta(list: readonly StepPoint[], seq: number): Uint8Array {
  if (list.length < 2) return packStepFlat(list, seq);
  const first = list[0]!;
  const buf = new Uint8Array(3 + 7 + (list.length - 1) * 5 + 1);
  const w = new Writer(buf);
  w.u8(MAGIC.STEP);
  w.u8(stepCountByte(STEP_FMT.DELTA, list.length));
  w.u8(seq & 0xff);
  w.i16(first.x);
  w.i16(first.y);
  w.u8(stepFlags(first));
  w.u16(first.iv ?? 0);
  let px = first.x;
  let py = first.y;
  for (let i = 1; i < list.length; i++) {
    const p = list[i]!;
    w.i8(p.x - px);
    w.i8(p.y - py);
    w.u8(stepFlags(p));
    w.u16(p.iv ?? 0);
    px = p.x;
    py = p.y;
  }
  return seal(buf, w, STEP_DELTA.escapeLow);
}

/**
 * A3 fmt 2: one interval for the whole packet.
 *
 * The cruise case, and the cheapest per point of anything on the wire: a straight run
 * at constant planned speed spends three bytes a point. A segment whose planned bit is
 * clear ignores the packet interval and takes the board's own rate and ramp, so a run
 * may legitimately mix the two, which is what a lash take-up landing mid run looks
 * like.
 */
export function packStepRun(list: readonly StepPoint[], seq: number, iv: number): Uint8Array {
  const first = list[0];
  if (!first) throw new Error("a run packet needs at least one point");
  const buf = new Uint8Array(3 + 2 + 5 + (list.length - 1) * 3 + 1);
  const w = new Writer(buf);
  w.u8(MAGIC.STEP);
  w.u8(stepCountByte(STEP_FMT.RUN, list.length));
  w.u8(seq & 0xff);
  w.u16(iv);
  w.i16(first.x);
  w.i16(first.y);
  w.u8(stepFlags(first));
  let px = first.x;
  let py = first.y;
  for (let i = 1; i < list.length; i++) {
    const p = list[i]!;
    w.i8(p.x - px);
    w.i8(p.y - py);
    w.u8(stepFlags(p));
    px = p.x;
    py = p.y;
  }
  return seal(buf, w, STEP_RUN.escapeLow);
}

export function stepDeltaRun(list: readonly StepPoint[], cap: number): number {
  if (list.length === 0) return 0;
  let n = 1;
  let px = list[0]!.x;
  let py = list[0]!.y;
  while (n < list.length && n < cap) {
    const p = list[n]!;
    const dx = p.x - px;
    const dy = p.y - py;
    if (dx < -128 || dx > 127 || dy < -128 || dy > 127) break;
    px = p.x;
    py = p.y;
    n++;
  }
  return n;
}

/* ------------------------------------------------------------- format pick -- */

export interface PulsePacket {
  bytes: Uint8Array;
  /** How many segments actually travelled. The rest go in the next packet. */
  count: number;
  format: "hermite" | "flat" | "delta";
}

/**
 * Build one pulse packet out of the head of the queue, in the best format this board
 * negotiated. Never assumes: `bin` and `herm` are what the board itself reported.
 */
export function packPulseBatch(
  list: readonly PulseSegment[],
  seq: number,
  wire: Readonly<WireCaps>,
  cap?: number,
): PulsePacket {
  /* The cap is how the fit loop shrinks a packet that escaping grew past one BLE
   * write. Segments handed back ride the next packet with the sequence intact
   * (INV-16), so this must never silently drop the tail. */
  const limit = (max: number) => Math.max(1, Math.min(max, cap ?? max, list.length));
  if (wire.herm && wire.bin >= 1) {
    const count = limit(HERMITE.maxCount);
    const take = list.slice(0, count);
    return { bytes: packPulseHermite(take, seq), count, format: "hermite" };
  }
  if (wire.bin >= 2) {
    const count = Math.min(pulseDeltaRun(list, DELTA.maxCount), limit(DELTA.maxCount));
    const take = list.slice(0, count);
    return { bytes: packPulseDelta(take, seq), count, format: "delta" };
  }
  const count = limit(FLAT.maxCount);
  const take = list.slice(0, count);
  return { bytes: packPulseFlat(take, seq), count, format: "flat" };
}

export interface StepPacket {
  bytes: Uint8Array;
  count: number;
  format: "step-flat" | "step-delta" | "step-run";
}

/**
 * Build one step packet out of the head of the queue.
 *
 * The run format only applies when every point in the run shares one interval, which
 * is the definition of a cruise. Anything else falls back to delta, and a board that
 * only advertises `ivb=1` gets flat.
 */
export function packStepBatch(
  list: readonly StepPoint[],
  seq: number,
  wire: Readonly<WireCaps>,
  cap?: number,
): StepPacket {
  const limit = (max: number) => Math.max(1, Math.min(max, cap ?? max, list.length));
  if (wire.ivb >= 3) {
    const iv = list[0]?.iv ?? 0;
    if (iv > 0) {
      const room = Math.min(stepDeltaRun(list, STEP_RUN.maxCount), limit(STEP_RUN.maxCount));
      let n = 0;
      while (n < room && (list[n]!.iv ?? 0) === iv) n++;
      if (n >= 2) {
        const take = list.slice(0, n);
        return { bytes: packStepRun(take, seq, iv), count: n, format: "step-run" };
      }
    }
  }
  if (wire.ivb >= 2) {
    const count = Math.min(stepDeltaRun(list, STEP_DELTA.maxCount), limit(STEP_DELTA.maxCount));
    if (count >= 2) {
      const take = list.slice(0, count);
      return { bytes: packStepDelta(take, seq), count, format: "step-delta" };
    }
  }
  const count = limit(STEP_FLAT.maxCount);
  const take = list.slice(0, count);
  return { bytes: packStepFlat(take, seq), count, format: "step-flat" };
}

/**
 * The text form of a step batch, which is what a legacy board takes.
 *
 * INV-18: `x,y,l` with an optional fourth `iv`, space joined, `S ` prefixed. A
 * trailing comma for a missing `iv` breaks the board's tokeniser, so the field is
 * omitted rather than left empty.
 */
export function formatStepBatch(points: readonly StepPoint[]): string {
  const toks = points.map((p) => {
    const head = `${Math.round(p.x)},${Math.round(p.y)},${p.laser ? 1 : 0}`;
    return p.iv !== undefined && p.iv > 0 ? `${head},${Math.round(p.iv)}` : head;
  });
  return `S ${toks.join(" ")}`;
}
