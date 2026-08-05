/*
 * A board of either lineage, in software.
 *
 * This is not a stub that answers "OK". It is a model of the two shipped firmwares
 * close enough to drive the whole app with no hardware on the bench: it answers the
 * probe with a real status line, dumps its stored config in its own format, accepts
 * both the text and the binary vocabularies, plays its queue on a clock so the free
 * slot count actually drains, and reports where the beam is as it goes.
 *
 * Two decisions are worth the words.
 *
 * The step board dispatches on the FIRST CHARACTER of the line, exactly like the
 * firmware, and it is the reason this file is worth its length. That parser is what
 * makes the two vocabularies collide destructively, and modelling it faithfully means
 * a test can prove the collision rather than assert that we remembered to avoid it.
 * `ECHO 0` really does release both coil sets in here, because `E` takes the rest of
 * the line as its argument and "CHO 0" parses as zero. `M 1500 1500 0` really is a
 * millimetre move, unclamped, because soft limits default off. See INV-62a.
 *
 * The clock is injected rather than taken from the wall. A test that has to sleep for
 * real to watch a queue drain is a test that is either slow or flaky, so `advance()`
 * moves the board's clock by hand and `autoClock` is what the app uses instead.
 */

import {
  DETENT_QUEUE_LEN,
  MAGIC,
  TICK_HZ,
  WASHER_QUEUE_LEN,
  createDetent28byj,
  crc8,
  intervalFor,
  parseStepCountByte,
  unescapeByte,
  type Point,
} from "@virgilvox/beam-core";
import type { Lineage } from "../classify.js";
import type { Transport } from "../index.js";
import {
  parseDetentConfig,
  parseWasherConfig,
  washerConfigLine,
  type DetentBoardConfig,
  type WasherBoardConfig,
} from "../config.js";

/* --------------------------------------------------------------- decoding -- */

interface DecodedSegment {
  a: number;
  b: number;
  flags: number;
  /** Pulse domain: whole milliseconds. Step domain: 0 when the packet carried none. */
  durMs: number;
  /** Step domain: ISR ticks between dominant axis steps. */
  iv: number;
}

interface DecodedPacket {
  domain: "pulse" | "step";
  seq: number;
  segments: DecodedSegment[];
}

/** Undo the escaping. Byte 0 is the magic and is never escaped. */
function unescape(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let o = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i]!;
    if (i > 0 && v === MAGIC.ESC && i + 1 < bytes.length) {
      out[o++] = unescapeByte(bytes[++i]!);
    } else {
      out[o++] = v;
    }
  }
  return out.subarray(0, o);
}

const u16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const i16 = (b: Uint8Array, i: number): number => {
  const v = u16(b, i);
  return v >= 0x8000 ? v - 0x10000 : v;
};
const i8 = (b: Uint8Array, i: number): number => {
  const v = b[i]!;
  return v >= 0x80 ? v - 0x100 : v;
};

/**
 * Decode one frame, or null if it does not check out.
 *
 * A CRC failure returns null and the caller counts it, which is the whole of what the
 * firmware does too: the sequence stays primed, because unpriming on a bad CRC meant
 * every corrupted packet silently deleted its own time from the drawing and the board
 * ran ahead of the plan (INV-14).
 */
function decodeFrame(raw: Uint8Array): DecodedPacket | null {
  const b = unescape(raw);
  if (b.length < 5) return null;
  const magic = b[0]!;
  const crcAt = b.length - 1;
  if (crc8(b, 0, crcAt) !== b[crcAt]) return null;

  const seq = b[2]!;
  const segments: DecodedSegment[] = [];

  if (magic === MAGIC.HERMITE || magic === MAGIC.FLAT || magic === MAGIC.DELTA) {
    const count = b[1]!;
    let o = 3;
    if (magic === MAGIC.HERMITE) {
      for (let i = 0; i < count; i++, o += 8) {
        segments.push({ a: u16(b, o), b: u16(b, o + 2), flags: b[o + 6]!, durMs: b[o + 7]!, iv: 0 });
      }
    } else if (magic === MAGIC.FLAT) {
      for (let i = 0; i < count; i++, o += 6) {
        segments.push({ a: u16(b, o), b: u16(b, o + 2), flags: b[o + 4]!, durMs: b[o + 5]!, iv: 0 });
      }
    } else {
      let pa = u16(b, o);
      let pb = u16(b, o + 2);
      segments.push({ a: pa, b: pb, flags: b[o + 4]!, durMs: b[o + 5]!, iv: 0 });
      o += 6;
      for (let i = 1; i < count; i++, o += 4) {
        pa += i8(b, o);
        pb += i8(b, o + 1);
        segments.push({ a: pa, b: pb, flags: b[o + 2]!, durMs: b[o + 3]!, iv: 0 });
      }
    }
    return { domain: "pulse", seq, segments };
  }

  if (magic === MAGIC.STEP) {
    const { fmt, count } = parseStepCountByte(b[1]!);
    let o = 3;
    if (fmt === 0) {
      for (let i = 0; i < count; i++, o += 7) {
        segments.push({ a: i16(b, o), b: i16(b, o + 2), flags: b[o + 4]!, durMs: 0, iv: u16(b, o + 5) });
      }
    } else if (fmt === 1) {
      let px = i16(b, o);
      let py = i16(b, o + 2);
      segments.push({ a: px, b: py, flags: b[o + 4]!, durMs: 0, iv: u16(b, o + 5) });
      o += 7;
      for (let i = 1; i < count; i++, o += 5) {
        px += i8(b, o);
        py += i8(b, o + 1);
        segments.push({ a: px, b: py, flags: b[o + 2]!, durMs: 0, iv: u16(b, o + 3) });
      }
    } else if (fmt === 2) {
      const iv = u16(b, o);
      o += 2;
      let px = i16(b, o);
      let py = i16(b, o + 2);
      segments.push({ a: px, b: py, flags: b[o + 4]!, durMs: 0, iv });
      o += 5;
      for (let i = 1; i < count; i++, o += 3) {
        px += i8(b, o);
        py += i8(b, o + 1);
        segments.push({ a: px, b: py, flags: b[o + 2]!, durMs: 0, iv });
      }
    } else {
      return null;
    }
    return { domain: "step", seq, segments };
  }

  return null;
}

/* ------------------------------------------------------------------ board -- */

/** What the board is doing, for assertions and for the app's readouts. */
export interface MockBoardState {
  /** Axis pair in this board's own units: pulse microseconds or half steps. */
  a: number;
  b: number;
  laser: boolean;
  queued: number;
  free: number;
  running: boolean;
  /** Step lineage only. False after a coil release, which is what `E 0` does. */
  coilsLive: boolean;
  /** Segments the board threw away because its queue was full. Erased geometry. */
  drops: number;
  /** Segments lost to a sequence gap, as the board counts them. */
  lost: number;
  /** Packets that failed their CRC. */
  crcErrors: number;
  /** How many times config was committed to flash. Persisting is an explicit act. */
  saves: number;
}

export interface MockBoardOptions {
  lineage: Lineage;
  /**
   * The boot banner. Opening a USB serial port may reset the board over DTR and
   * produce one; a BLE connect never does. Pass null to model the BLE case, which is
   * the case classification must not depend on.
   */
  hello?: string | null;
  /** Unsolicited status beats. The real boards are never silent. */
  beats?: boolean;
  /** Answer nothing at all. For exercising the give-up path. */
  silent?: boolean;
  washer?: Partial<WasherBoardConfig>;
  detent?: Partial<DetentBoardConfig>;
}

interface QueueItem {
  a: number;
  b: number;
  laser: boolean;
  durMs: number;
}

export abstract class MockBoard {
  emit: (line: string) => void = () => {};
  nowMs = 0;
  laser = false;
  drops = 0;
  lost = 0;
  crcErrors = 0;
  saves = 0;
  seqPrimed = false;
  expectSeq = 0;
  protected queue: QueueItem[] = [];
  protected playAcc = 0;
  protected lastBeat = 0;
  protected silent: boolean;
  protected beats: boolean;

  constructor(
    readonly lineage: Lineage,
    readonly hello: string | null,
    opts: MockBoardOptions,
  ) {
    this.silent = opts.silent ?? false;
    this.beats = opts.beats ?? true;
  }

  protected say(line: string): void {
    if (!this.silent) this.emit(line);
  }

  abstract queueLen(): number;
  abstract statusLine(): string;
  abstract applyItem(item: QueueItem): void;
  abstract handleLine(line: string): void;
  abstract handleFrame(bytes: Uint8Array): void;
  abstract position(): { a: number; b: number };

  get free(): number {
    /* One slot is burned so head == tail can mean empty, on both boards. */
    return this.queueLen() - 1 - this.queue.length;
  }

  get running(): boolean {
    return this.queue.length > 0;
  }

  push(item: QueueItem): boolean {
    if (this.free <= 0) {
      this.drops++;
      return false;
    }
    this.queue.push(item);
    return true;
  }

  clearQueue(): void {
    this.queue = [];
    this.playAcc = 0;
  }

  /** A sequence gap means packets were dropped. Their positions are gone; count them. */
  protected trackSeq(seq: number, count: number): void {
    if (this.seqPrimed) {
      const gap = (seq - this.expectSeq) & 0xff;
      if (gap) this.lost += gap;
    }
    this.seqPrimed = true;
    this.expectSeq = (seq + count) & 0xff;
  }

  line(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.handleLine(trimmed);
  }

  frame(bytes: Uint8Array): void {
    this.handleFrame(bytes);
  }

  /** Advance the clock, play whatever came due, and beat if it is time. */
  advance(ms: number): void {
    this.nowMs += ms;
    this.playAcc += ms;
    for (;;) {
      const head = this.queue[0];
      if (!head || this.playAcc < head.durMs) break;
      this.playAcc -= head.durMs;
      this.queue.shift();
      this.applyItem(head);
    }
    if (this.queue.length === 0) this.playAcc = 0;
    this.beat();
  }

  protected abstract beat(): void;

  state(): MockBoardState {
    const p = this.position();
    return {
      a: p.a,
      b: p.b,
      laser: this.laser,
      queued: this.queue.length,
      free: this.free,
      running: this.running,
      coilsLive: true,
      drops: this.drops,
      lost: this.lost,
      crcErrors: this.crcErrors,
      saves: this.saves,
    };
  }
}

/* ------------------------------------------------------------ pulse board -- */

const WASHER_BOOT = "READY LASER RIG 1.4";

/**
 * The servo pan/tilt head.
 *
 * Command names are whole words, matched case insensitively on the first token, which
 * is what makes a stray step-vocabulary line land on "ERR unknown" over here rather
 * than doing something. The reverse is not true, which is the entire reason for the
 * probe.
 */
class PulseBoard extends MockBoard {
  cfg: WasherBoardConfig;
  panUs: number;
  tiltUs: number;
  echo = false;
  attached = true;
  reportMs = 0;
  private lastReport = 0;
  private jobArmed = false;

  constructor(opts: MockBoardOptions) {
    super("pulse", opts.hello === undefined ? WASHER_BOOT : opts.hello, opts);
    const base = parseWasherConfig("CFG ")!;
    this.cfg = { ...base, ...(opts.washer ?? {}) };
    this.panUs = this.cfg.homePanUs;
    this.tiltUs = this.cfg.homeTiltUs;
  }

  override queueLen(): number {
    return WASHER_QUEUE_LEN;
  }

  override position(): { a: number; b: number } {
    return { a: this.panUs, b: this.tiltUs };
  }

  private clampUs(v: number): number {
    return Math.min(this.cfg.maxUs, Math.max(this.cfg.minUs, Math.round(v)));
  }

  override statusLine(): string {
    return (
      `STAT pan=${this.panUs} tilt=${this.tiltUs} laser=${this.laser ? 1 : 0} ` +
      `hp=${Math.round(this.cfg.homePanUs)} ht=${Math.round(this.cfg.homeTiltUs)} ` +
      `min=${Math.round(this.cfg.minUs)} max=${Math.round(this.cfg.maxUs)} ` +
      `pol=${this.cfg.activeHigh ? 1 : 0} att=${this.attached ? 1 : 0} ` +
      `dm=${Math.round(this.cfg.deadmanMs)} seg=1 bin=2 herm=1 q=${this.free} ` +
      `echo=${this.echo ? 1 : 0} lost=${this.lost} crc=${this.crcErrors} qd=${this.drops}`
    );
  }

  private positionLine(): string {
    return `@ ${this.panUs} ${this.tiltUs} ${this.laser ? 1 : 0} ${this.free}`;
  }

  override applyItem(item: QueueItem): void {
    this.panUs = item.a;
    this.tiltUs = item.b;
    this.laser = item.laser;
  }

  protected override beat(): void {
    if (this.reportMs > 0 && this.nowMs - this.lastReport >= this.reportMs) {
      this.lastReport = this.nowMs;
      this.say(this.positionLine());
    }
    /* The servo firmware answers status on request rather than beating, except that
     * a plot with REPORT on is already a heartbeat. Keep a slow one anyway so a host
     * that never asks still sees its queue drain. */
    if (this.beats && this.nowMs - this.lastBeat >= 1000) {
      this.lastBeat = this.nowMs;
      if (this.reportMs === 0) this.say(this.statusLine());
    }
  }

  override handleFrame(bytes: Uint8Array): void {
    const packet = decodeFrame(bytes);
    if (!packet) {
      this.crcErrors++;
      return;
    }
    if (packet.domain !== "pulse") return;
    this.trackSeq(packet.seq, packet.segments.length);
    for (const s of packet.segments) {
      const ok = this.push({
        a: this.clampUs(s.a),
        b: this.clampUs(s.b),
        laser: (s.flags & 1) !== 0,
        durMs: Math.max(1, s.durMs),
      });
      if (!ok) {
        this.say("ERR segq full");
        break;
      }
    }
  }

  override handleLine(line: string): void {
    const tok = line.split(/\s+/);
    const cmd = (tok[0] ?? "").toUpperCase();
    const n = (i: number, dflt = 0): number => {
      const v = Number.parseInt(tok[i] ?? "", 10);
      return Number.isFinite(v) ? v : dflt;
    };
    const ok = () => {
      if (this.echo) this.say("OK");
    };

    switch (cmd) {
      case "?":
      case "STATUS":
        this.say(this.statusLine());
        return;

      case "M":
        if (tok.length < 4) {
          this.say("ERR M needs p t l");
          return;
        }
        /* A direct aim wins over the queue, and ends the job as far as the gate
         * cares. This is also the clamp that makes a step-vocabulary `M 10 20 1`
         * land on a corner WITH THE BEAM LIT. */
        this.clearQueue();
        this.jobArmed = false;
        this.panUs = this.clampUs(n(1));
        this.tiltUs = this.clampUs(n(2));
        this.laser = n(3) !== 0;
        ok();
        return;

      case "P":
        if (tok.length < 3) {
          this.say("ERR P needs p t");
          return;
        }
        this.clearQueue();
        this.jobArmed = false;
        this.panUs = this.clampUs(n(1));
        this.tiltUs = this.clampUs(n(2));
        ok();
        return;

      case "L":
        if (tok.length < 2) {
          this.say("ERR L needs 0/1");
          return;
        }
        this.jobArmed = false;
        this.laser = n(1) !== 0;
        ok();
        return;

      case "SEG": {
        if (tok.length < 5) {
          this.say("ERR SEG needs p t l ms");
          return;
        }
        const pushed = this.push({
          a: this.clampUs(n(1)),
          b: this.clampUs(n(2)),
          laser: n(3) !== 0,
          durMs: Math.max(1, n(4, 1)),
        });
        if (!pushed) this.say("ERR segq full");
        else ok();
        return;
      }

      case "FLUSH":
        this.clearQueue();
        this.jobArmed = false;
        this.seqPrimed = false;
        this.say("OK");
        return;

      case "JOB":
        this.clearQueue();
        this.seqPrimed = false;
        this.lost = 0;
        this.crcErrors = 0;
        this.drops = 0;
        this.jobArmed = true;
        this.say("OK");
        return;

      case "CFG": {
        if (tok.length < 2) {
          this.say(washerConfigLine(this.cfg));
          return;
        }
        const merged = parseWasherConfig(`CFG ${tok.slice(1).join(" ")}`);
        if (merged) {
          const patch = parseKvPresent(line);
          this.cfg = applyWasherPatch(this.cfg, merged, patch);
        }
        /* The shipped firmware commits to flash on every CFG assignment. INV-60
         * moves that behind an explicit persist; until the firmware follows, the
         * board counts the write so a test can see it happen. */
        this.saves++;
        this.say("OK");
        return;
      }

      case "DITHER":
        this.cfg = { ...this.cfg, dither: tok.length > 1 ? n(1) !== 0 : true };
        this.say("OK");
        return;

      case "REPORT":
        this.reportMs = tok.length > 1 ? n(1) : 0;
        this.lastReport = 0;
        this.say("OK");
        return;

      case "ECHO":
        if (tok.length < 2) {
          this.say("ERR ECHO needs 0/1");
          return;
        }
        this.echo = n(1) !== 0;
        this.say("OK");
        return;

      case "RANGE": {
        if (tok.length < 3) {
          this.say("ERR RANGE needs a b");
          return;
        }
        const a = n(1);
        const b = n(2);
        /* Nothing changed: no servo glitch and no flash write. The app sends RANGE
         * at every plot start, and re-arming for the same window was a twitch at the
         * top of every job. */
        if (a !== this.cfg.minUs || b !== this.cfg.maxUs) {
          this.cfg = { ...this.cfg, minUs: a, maxUs: b };
          this.panUs = this.clampUs(this.panUs);
          this.tiltUs = this.clampUs(this.tiltUs);
          this.saves++;
        }
        this.say(this.statusLine());
        return;
      }

      case "POL":
        if (tok.length < 2) {
          this.say("ERR POL needs 0/1");
          return;
        }
        this.cfg = { ...this.cfg, activeHigh: n(1) !== 0 };
        this.saves++;
        this.say(this.statusLine());
        return;

      case "ZERO":
        this.cfg = {
          ...this.cfg,
          homePanUs: tok.length >= 3 ? this.clampUs(n(1)) : this.panUs,
          homeTiltUs: tok.length >= 3 ? this.clampUs(n(2)) : this.tiltUs,
        };
        this.saves++;
        this.say(this.statusLine());
        return;

      case "CENTER":
      case "HOME":
        this.clearQueue();
        this.jobArmed = false;
        this.panUs = this.clampUs(this.cfg.homePanUs);
        this.tiltUs = this.clampUs(this.cfg.homeTiltUs);
        this.laser = false;
        this.say("OK");
        return;

      case "DET":
        this.clearQueue();
        this.jobArmed = false;
        this.laser = false;
        this.attached = false;
        this.say("OK");
        return;

      case "ATT":
        this.attached = true;
        this.say("OK");
        return;

      case "DM":
        if (tok.length < 2) {
          this.say("ERR DM needs ms");
          return;
        }
        this.cfg = { ...this.cfg, deadmanMs: n(1) };
        this.saves++;
        this.say(this.statusLine());
        return;

      case "PING":
        this.say("OK");
        return;

      default:
        /* Only complain about something that looks like a command. A line of stray
         * bytes is framing debris and answering it makes things worse: the reply is
         * long, it goes out one notify at a time, and it holds up the loop that is
         * trying to keep the segment queue fed. */
        if (cmd.length <= 12 && /^[\x20-\x7e]*$/.test(cmd)) this.say(`ERR unknown ${cmd}`);
        return;
    }
  }

  override state(): MockBoardState {
    return { ...super.state(), coilsLive: this.attached };
  }

  get armed(): boolean {
    return this.jobArmed;
  }
}

/** Which keys a CFG push actually mentioned. Absent keys must not be overwritten. */
function parseKvPresent(line: string): Set<string> {
  const out = new Set<string>();
  for (const t of line.trim().split(/\s+/)) {
    const i = t.indexOf("=");
    if (i > 0) out.add(t.slice(0, i));
  }
  return out;
}

const WASHER_KEY_FIELD: Record<string, keyof WasherBoardConfig> = {
  min: "minUs",
  max: "maxUs",
  hp: "homePanUs",
  ht: "homeTiltUs",
  pol: "activeHigh",
  dm: "deadmanMs",
  ww: "wallW",
  wh: "wallH",
  ds: "distMm",
  mh: "mountH",
  sl: "slew",
  ac: "accel",
  db: "deadband",
  sv: "servo",
  cal: "calibrationOn",
  dit: "dither",
  ffp: "leadPan",
  fft: "leadTilt",
};

function applyWasherPatch(
  current: WasherBoardConfig,
  parsed: WasherBoardConfig,
  present: Set<string>,
): WasherBoardConfig {
  const next: WasherBoardConfig = { ...current };
  for (const [key, field] of Object.entries(WASHER_KEY_FIELD)) {
    if (!present.has(key)) continue;
    /* One assignment per key, typed through the field map rather than by index, so a
     * renamed field is a compile error rather than a silently ignored push. */
    Object.assign(next, { [field]: parsed[field] });
  }
  let corners = current.corners;
  let count = current.cornerCount;
  for (const key of ["tl", "tr", "bl", "br"] as const) {
    if (!present.has(key)) continue;
    corners = { ...corners, [key]: parsed.corners[key] };
    count = Object.values(corners).filter((c) => c !== null).length;
  }
  next.corners = corners;
  next.cornerCount = count;
  /* INV-84 again, on the write path: a stored flag with no corners behind it is a
   * calibration that aims through an empty map. */
  next.calibrationOn = count > 0 && next.calibrationOn;
  return next;
}

/* ------------------------------------------------------------- step board -- */

const DETENT_BOOT = "detent ready";
const DETENT_VERSION = `detent 1.3 esp32c3 spr=4075.77 dps=0.088327 tick=${TICK_HZ}`;

/**
 * The two mirror stepper scanner.
 *
 * Dispatch is on `line.charAt(0)` with the rest taken as arguments, faithfully,
 * because that is the behavior INV-62a exists to protect against. Do not "fix" it
 * into whole word matching: the point of this model is that it misbehaves the same
 * way the real board does.
 */
class StepBoard extends MockBoard {
  cfg: DetentBoardConfig;
  /** Where the shaft is now: the ISR's own count, lash take-up included. */
  physX = 0;
  physY = 0;
  /** Where the host has commanded to, which runs ahead of the shaft by a queue. */
  logX = 0;
  logY = 0;
  /**
   * Where the shaft will be once everything already queued has played.
   *
   * The firmware queues deltas and the ISR adds them to the physical count as it
   * goes, so it needs no such field. A model that queues absolute endpoints does:
   * without it, every segment queued behind another is computed from a physical
   * position that has not moved yet, and a fourteen point line plays as one step.
   */
  private qx = 0;
  private qy = 0;
  coilsLive = true;
  lashDirX = 1;
  lashDirY = 1;

  constructor(opts: MockBoardOptions) {
    super("step", opts.hello === undefined ? DETENT_BOOT : opts.hello, opts);
    const base = parseDetentConfig(["qc1", "qc4 end"])!;
    this.cfg = { ...base, ...(opts.detent ?? {}) };
  }

  override queueLen(): number {
    return DETENT_QUEUE_LEN;
  }

  override position(): { a: number; b: number } {
    return { a: this.physX, b: this.physY };
  }

  private mmToSteps(p: Point): { x: number; y: number } {
    const profile = createDetent28byj({
      throwMm: this.cfg.throwMm,
      sepMm: this.cfg.sepMm,
      fieldW: this.cfg.fieldW,
      fieldH: this.cfg.fieldH,
    });
    const q = profile.quantise(profile.inverse(p));
    return { x: q.a, y: q.b };
  }

  override statusLine(): string {
    const profile = createDetent28byj({ throwMm: this.cfg.throwMm, sepMm: this.cfg.sepMm });
    const mm = profile.forward({ a: this.physX, b: this.physY });
    return (
      `st q=${this.queue.length} free=${this.free} px=${this.physX} py=${this.physY} ` +
      `lx=${this.logX} ly=${this.logY} mx=${mm.x.toFixed(2)} my=${mm.y.toFixed(2)} ` +
      `run=${this.running ? 1 : 0} drop=${this.drops} rate=${Math.round(this.cfg.rate)} ` +
      `lon=${this.cfg.limitsOn ? 1 : 0} map=${this.cfg.mapValid ? 1 : 0} cs=${this.cfg.cornerSet}`
    );
  }

  override applyItem(item: QueueItem): void {
    this.physX = item.a;
    this.physY = item.b;
    this.laser = item.laser;
  }

  protected override beat(): void {
    if (!this.beats) return;
    /*
     * INV-28: the board is never silent. Every 150 ms while running or with a
     * non-empty queue, every 700 ms while fully idle, so a lost notify cannot wedge
     * the host waiting for a credit update that never comes.
     */
    const period = this.running || this.queue.length > 0 ? 150 : 700;
    if (this.nowMs - this.lastBeat < period) return;
    this.lastBeat = this.nowMs;
    this.say(this.statusLine());
  }

  /** Queue a move to an absolute logical step position, folding in backlash take-up. */
  private moveToSteps(tx: number, ty: number, laser: boolean, ivOverride = 0): boolean {
    let x = Math.round(tx);
    let y = Math.round(ty);
    if (this.cfg.limitsOn) {
      x = Math.min(this.cfg.maxX, Math.max(this.cfg.minX, x));
      y = Math.min(this.cfg.maxY, Math.max(this.cfg.minY, y));
    }
    const dx = x - this.logX;
    const dy = y - this.logY;
    const iv = ivOverride > 0 ? ivOverride : intervalFor(laser ? this.cfg.rate : this.cfg.rateTravel);

    if (dx === 0 && dy === 0) {
      /* A gate change with no movement is still a segment: the beam state has to
       * land somewhere in time. One tick is what the firmware queues. */
      return this.push({ a: this.qx, b: this.qy, laser, durMs: msFor(1, 1) });
    }

    /*
     * INV-38: the take-up is its own segment, beam off, at the SLOWER of the two
     * rates, because it happens at a reversal and a reversal is exactly where speed
     * costs steps.
     */
    let extraX = 0;
    let extraY = 0;
    if (dx > 0 && this.lashDirX < 0) {
      extraX = this.cfg.lashX;
      this.lashDirX = 1;
    }
    if (dx < 0 && this.lashDirX > 0) {
      extraX = -this.cfg.lashX;
      this.lashDirX = -1;
    }
    if (dy > 0 && this.lashDirY < 0) {
      extraY = this.cfg.lashY;
      this.lashDirY = 1;
    }
    if (dy < 0 && this.lashDirY > 0) {
      extraY = -this.cfg.lashY;
      this.lashDirY = -1;
    }
    if (extraX || extraY) {
      const slower = Math.max(intervalFor(this.cfg.rate), intervalFor(this.cfg.rateTravel));
      this.qx += extraX;
      this.qy += extraY;
      const ok = this.push({
        a: this.qx,
        b: this.qy,
        laser: false,
        durMs: msFor(Math.max(Math.abs(extraX), Math.abs(extraY)), slower),
      });
      if (!ok) return false;
    }

    this.logX = x;
    this.logY = y;

    /*
     * INV-39: long moves split so no single segment exceeds 2000 steps on the
     * dominant axis. INV-64: the division truncates toward zero the way C does, so
     * Math.trunc and never Math.floor.
     */
    let rx = dx;
    let ry = dy;
    while (rx || ry) {
      let cx = rx;
      let cy = ry;
      const m = Math.max(Math.abs(cx), Math.abs(cy));
      if (m > 2000) {
        cx = Math.trunc((rx * 2000) / m);
        cy = Math.trunc((ry * 2000) / m);
        if (cx === 0 && cy === 0) {
          cx = rx;
          cy = ry;
        }
      }
      this.qx += cx;
      this.qy += cy;
      if (!this.push({ a: this.qx, b: this.qy, laser, durMs: msFor(Math.max(Math.abs(cx), Math.abs(cy)), iv) })) {
        return false;
      }
      rx -= cx;
      ry -= cy;
    }
    return true;
  }

  override handleFrame(bytes: Uint8Array): void {
    const packet = decodeFrame(bytes);
    if (!packet) {
      this.crcErrors++;
      return;
    }
    if (packet.domain !== "step") return;
    this.trackSeq(packet.seq, packet.segments.length);
    for (const s of packet.segments) {
      /* Bit 1 clear means the board owns the pacing, so it uses its own rate. */
      const planned = (s.flags & 2) !== 0;
      if (!this.moveToSteps(s.a, s.b, (s.flags & 1) !== 0, planned ? s.iv : 0)) {
        this.say("err full");
        break;
      }
    }
  }

  override handleLine(line: string): void {
    /*
     * First character, rest as arguments. This is the collision surface, modelled on
     * purpose. See INV-62a.
     */
    const c = line.charAt(0);
    const rest = line.slice(1).trim();
    const args = parseArgs(rest);
    const argi = (i: number, dflt = 0): number => {
      const v = args[i];
      return v === undefined ? dflt : Math.trunc(v);
    };
    const argf = (i: number, dflt = 0): number => args[i] ?? dflt;

    switch (c) {
      case "?":
        this.say(this.statusLine());
        return;

      case "V":
        this.say(DETENT_VERSION);
        return;

      case "H":
        this.clearQueue();
        this.laser = false;
        this.physX = this.physY = 0;
        this.logX = this.logY = 0;
        this.qx = this.qy = 0;
        this.lashDirX = this.lashDirY = 1;
        this.say("ok home");
        return;

      case "S": {
        /* Batch of `x,y,l[,iv]` tokens. A trailing comma for a missing iv breaks
         * this tokeniser, which is why the formatter omits the field (INV-18). */
        let n = 0;
        let ok = 0;
        for (const t of rest.split(/\s+/)) {
          if (!t) continue;
          const parts = t.split(",");
          if (parts.length < 3) continue;
          n++;
          const sx = Number.parseInt(parts[0] ?? "", 10) || 0;
          const sy = Number.parseInt(parts[1] ?? "", 10) || 0;
          const lz = (Number.parseInt(parts[2] ?? "", 10) || 0) !== 0;
          const iv = parts.length > 3 ? Number.parseInt(parts[3] ?? "", 10) || 0 : 0;
          if (this.moveToSteps(sx, sy, lz, Math.max(0, Math.min(65535, iv)))) ok++;
          else break;
        }
        this.say(`ok ${ok}/${n} free=${this.free}`);
        return;
      }

      case "M": {
        /*
         * A move in MILLIMETRES, unclamped because soft limits default off. This is
         * the line that makes a pulse-vocabulary `M 1500 1500 0` a full travel slam
         * on this board.
         */
        const s = this.mmToSteps({ x: argf(0, 0), y: argf(1, 0) });
        this.say(this.moveToSteps(s.x, s.y, argi(2, 0) !== 0) ? `ok free=${this.free}` : "err full");
        return;
      }

      case "J":
        this.say(this.moveToSteps(this.logX + argi(0, 0), this.logY + argi(1, 0), false) ? "ok" : "err full");
        return;

      case "L":
        this.laser = Number.parseInt(rest, 10) > 0;
        this.say("ok");
        return;

      case "R": {
        if (argi(0, 0) > 0) this.cfg = { ...this.cfg, rate: argi(0) };
        if (argi(1, 0) > 0) this.cfg = { ...this.cfg, rateTravel: argi(1) };
        if (argi(2, 0) > 0) this.cfg = { ...this.cfg, rampSteps: argi(2) };
        this.say(`ok rate=${this.cfg.rate} travel=${this.cfg.rateTravel} ramp=${this.cfg.rampSteps}`);
        return;
      }

      case "B":
        this.cfg = { ...this.cfg, lashX: argi(0, this.cfg.lashX), lashY: argi(1, this.cfg.lashY) };
        this.say(`ok lash=${this.cfg.lashX},${this.cfg.lashY}`);
        return;

      case "G":
        this.cfg = {
          ...this.cfg,
          throwMm: argf(0, this.cfg.throwMm),
          sepMm: argf(1, this.cfg.sepMm),
          fieldW: argf(2, this.cfg.fieldW),
          fieldH: argf(3, this.cfg.fieldH),
        };
        this.say(`ok geom throw=${this.cfg.throwMm} sep=${this.cfg.sepMm}`);
        return;

      case "I":
        this.cfg = { ...this.cfg, invX: argi(0, 0) !== 0, invY: argi(1, 0) !== 0 };
        this.say(`ok inv=${this.cfg.invX ? 1 : 0},${this.cfg.invY ? 1 : 0}`);
        return;

      case "N": {
        if (args.length >= 4) {
          const minX = Math.min(argi(0), argi(1));
          const maxX = Math.max(argi(0), argi(1));
          const minY = Math.min(argi(2), argi(3));
          const maxY = Math.max(argi(2), argi(3));
          this.cfg = { ...this.cfg, minX, maxX, minY, maxY };
        }
        this.say(
          `lim x=${this.cfg.minX}..${this.cfg.maxX} y=${this.cfg.minY}..${this.cfg.maxY} on=${this.cfg.limitsOn ? 1 : 0}`,
        );
        return;
      }

      case "U":
        this.cfg = { ...this.cfg, limitsOn: argi(0, 0) !== 0 };
        this.say(`ok limits=${this.cfg.limitsOn ? 1 : 0}`);
        return;

      case "P": {
        if (args.length >= 1) {
          const idx = argi(0);
          if (idx < 0 || idx > 3) {
            this.say("err corner 0..3");
            return;
          }
          const corners = [...this.cfg.corners];
          corners[idx] = { x: this.logX, y: this.logY };
          this.cfg = { ...this.cfg, corners, cornerSet: this.cfg.cornerSet | (1 << idx) };
          this.say(`ok corner ${idx} = ${this.logX},${this.logY} set=${this.cfg.cornerSet}`);
          return;
        }
        /* `PING` lands here: `P` with an unparseable argument falls to the read-only
         * dump rather than capturing a corner. Not every collision is dangerous. */
        const c4 = this.cfg.corners;
        this.say(
          `corners set=${this.cfg.cornerSet} tl=${fmtCorner(c4[0])} tr=${fmtCorner(c4[1])} ` +
            `br=${fmtCorner(c4[2])} bl=${fmtCorner(c4[3])}`,
        );
        return;
      }

      case "A":
        if (this.cfg.cornerSet !== 0x0f) {
          this.say("err need all four corners");
          return;
        }
        this.say(`ok lim x=${this.cfg.minX}..${this.cfg.maxX} y=${this.cfg.minY}..${this.cfg.maxY} on=1`);
        return;

      case "Y":
        if (args.length < 8) {
          this.cfg = { ...this.cfg, mapValid: false, homography: null };
          this.say("ok mapping cleared, using ideal model");
          return;
        }
        this.cfg = { ...this.cfg, homography: args.slice(0, 8), mapValid: true };
        this.say("ok mapping loaded");
        return;

      case "E":
        /*
         * The one that costs the most. `ECHO 0` from the pulse vocabulary arrives
         * here as `E` with rest "CHO 0", which parses as zero and releases both coil
         * sets. The rig goes limp and whatever it was pointing at moves.
         */
        this.coilsLive = Number.parseInt(rest, 10) > 0;
        this.say("ok");
        return;

      case "D":
        this.cfg = { ...this.cfg, idleReleaseMs: argi(0, this.cfg.idleReleaseMs) };
        this.say(`ok idle=${this.cfg.idleReleaseMs}`);
        return;

      case "X":
        this.clearQueue();
        this.laser = false;
        this.logX = this.physX;
        this.logY = this.physY;
        this.qx = this.physX;
        this.qy = this.physY;
        this.drops = 0;
        this.say("ok stop");
        return;

      case "W":
        this.saves++;
        this.say("ok saved");
        return;

      case "Q": {
        const q = this.cfg;
        this.say(
          `qc1 rate=${Math.round(q.rate)} travel=${Math.round(q.rateTravel)} ramp=${Math.round(q.rampSteps)} ` +
            `lashx=${q.lashX} lashy=${q.lashY} minx=${q.minX} maxx=${q.maxX} miny=${q.minY} maxy=${q.maxY} ` +
            `lon=${q.limitsOn ? 1 : 0} invx=${q.invX ? 1 : 0} invy=${q.invY ? 1 : 0} ` +
            `throw=${q.throwMm.toFixed(2)} sep=${q.sepMm.toFixed(2)} fw=${q.fieldW.toFixed(1)} ` +
            `fh=${q.fieldH.toFixed(1)} idle=${Math.round(q.idleReleaseMs)}`,
        );
        this.say(
          `qc2 cs=${q.cornerSet} c0=${fmtCorner(q.corners[0])} c1=${fmtCorner(q.corners[1])} ` +
            `c2=${fmtCorner(q.corners[2])} c3=${fmtCorner(q.corners[3])} map=${q.mapValid ? 1 : 0}`,
        );
        if (q.mapValid && q.homography) {
          this.say(`qc3 h=${q.homography.map((v) => v.toPrecision(9)).join(",")}`);
        }
        this.say("qc4 end");
        return;
      }

      case "C":
        this.say(
          `cfg rate=${Math.round(this.cfg.rate)} travel=${Math.round(this.cfg.rateTravel)} ` +
            `throw=${this.cfg.throwMm.toFixed(1)} sep=${this.cfg.sepMm.toFixed(1)}`,
        );
        return;

      default:
        this.say(`err unknown ${c}`);
        return;
    }
  }

  override state(): MockBoardState {
    return { ...super.state(), coilsLive: this.coilsLive };
  }
}

const fmtCorner = (c: { x: number; y: number } | null | undefined): string =>
  c ? `${c.x},${c.y}` : "0,0";

/** How long a segment of `steps` dominant axis steps takes at `iv` ticks per step. */
const msFor = (steps: number, iv: number): number =>
  Math.max(1, Math.round((steps * iv * 1000) / TICK_HZ));

/**
 * The firmware's own argument parser, in shape.
 *
 * It walks tokens with strtof and stops at the first thing that is not a number,
 * which is why `PING` reaches the corner command with zero arguments instead of
 * capturing corner zero.
 */
function parseArgs(rest: string): number[] {
  const out: number[] = [];
  for (const t of rest.split(/\s+/)) {
    if (!t) continue;
    const v = Number.parseFloat(t);
    if (!Number.isFinite(v)) break;
    out.push(v);
  }
  return out;
}

/* -------------------------------------------------------------- transport -- */

export interface TrafficEntry {
  kind: "line" | "frame";
  text?: string;
  bytes?: Uint8Array;
  atMs: number;
}

export interface MockTransportOptions extends MockBoardOptions {
  /**
   * Drive the board's clock from real time. What the app wants and what a test does
   * not: a test calls `advance()` and gets the same answer every run.
   */
  autoClock?: boolean;
  /** How often the auto clock ticks. Finer than any beat period, so beats land on time. */
  autoClockMs?: number;
}

/**
 * A Transport backed by a board of the chosen lineage.
 *
 * Every write is recorded before it is delivered, which is what lets a test assert the
 * thing that matters most: that nothing but the probe went out before the peer was
 * classified.
 */
export class MockTransport implements Transport {
  readonly kind = "mock" as const;
  pending = 0;
  readonly board: MockBoard;
  readonly traffic: TrafficEntry[] = [];
  /** Hold writes to exercise the backpressure gate. */
  stalled = false;

  private connected = false;
  private lineCbs = new Set<(line: string) => void>();
  private closeCbs = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAuto = 0;
  private readonly autoClock: boolean;
  private readonly autoClockMs: number;

  constructor(private readonly opts: MockTransportOptions) {
    this.board = opts.lineage === "pulse" ? new PulseBoard(opts) : new StepBoard(opts);
    this.board.emit = (line) => this.deliver(line);
    this.autoClock = opts.autoClock ?? false;
    this.autoClockMs = opts.autoClockMs ?? 20;
  }

  /** Every text line this host has written, in order. */
  get sentLines(): string[] {
    return this.traffic.filter((t) => t.kind === "line").map((t) => t.text ?? "");
  }

  get sentFrames(): Uint8Array[] {
    return this.traffic.flatMap((t) => (t.kind === "frame" && t.bytes ? [t.bytes] : []));
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connected = true;
    if (this.autoClock) {
      this.lastAuto = Date.now();
      this.timer = setInterval(() => {
        const now = Date.now();
        this.board.advance(now - this.lastAuto);
        this.lastAuto = now;
      }, this.autoClockMs);
    }
    /*
     * The banner, if this link produces one. A USB serial open may reset the board
     * over DTR; a BLE connect never does, so classification can never depend on it.
     */
    if (this.board.hello) {
      const hello = this.board.hello;
      queueMicrotask(() => {
        if (this.connected && !this.opts.silent) this.deliver(hello);
      });
    }
    await Promise.resolve();
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const cb of [...this.closeCbs]) cb();
    await Promise.resolve();
  }

  async sendLine(text: string): Promise<void> {
    this.traffic.push({ kind: "line", text, atMs: this.board.nowMs });
    await this.write(() => this.board.line(text));
  }

  async sendFrame(bytes: Uint8Array): Promise<void> {
    this.traffic.push({ kind: "frame", bytes: bytes.slice(), atMs: this.board.nowMs });
    await this.write(() => this.board.frame(bytes));
  }

  onLine(cb: (line: string) => void): () => void {
    this.lineCbs.add(cb);
    return () => this.lineCbs.delete(cb);
  }

  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  /** Move the board's clock by hand: play the queue, fire the beats. */
  advance(ms: number): void {
    this.board.advance(ms);
  }

  /** Release a stall, letting every held write through. */
  release(): void {
    this.stalled = false;
  }

  private async write(apply: () => void): Promise<void> {
    if (!this.connected) throw new Error("mock transport is not connected");
    this.pending++;
    try {
      /* One turn of the microtask queue, so a reply can never arrive before the
       * write that caused it has returned. */
      await Promise.resolve();
      while (this.stalled) await new Promise<void>((r) => setTimeout(r, 1));
      if (!this.connected) return;
      apply();
    } finally {
      this.pending = Math.max(0, this.pending - 1);
    }
  }

  private deliver(line: string): void {
    for (const cb of [...this.lineCbs]) cb(line);
  }
}

/** The board behind a MockTransport, typed for assertions. */
export function boardState(t: MockTransport): MockBoardState {
  return t.board.state();
}
