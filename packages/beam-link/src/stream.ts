/*
 * Credit window streaming, ported from both shipped tools.
 *
 * The two rigs solve the same problem with the same idea and different numbers. The
 * board publishes how many free slots it has; everything launched since that report
 * is already spending them, and so is everything pooled locally waiting to flush.
 * Emit only while the projection leaves headroom. The board's own word beats any
 * model here, because overflowing its queue drops segments and a dropped segment is
 * dropped geometry (INV-25).
 *
 * Pulse lineage, from the servo rig:
 *   INV-23  the emit gate wants 6 free slots on `boardFree - sentSinceReport - pooled`
 *   INV-22  the emitter halts while more than 3 BLE writes are in flight
 *   INV-16  a packet grown past one BLE write by escaping hands segments back
 *   INV-26  everything pooled this tick is flushed this tick
 *
 * Step lineage, from the stepper rig:
 *   INV-24  require free >= 6 + 8 = 14 before sending a batch of 6, poll every 40 ms
 *           while blocked, and re-query with `?` after 25 consecutive blocked polls,
 *           which is one second of no progress
 *
 * Both gates fail open when the board has never reported. That is deliberate and it is
 * what both originals do: a board that has said nothing about its queue is a board
 * whose queue this host cannot model, and the alternative is a link that never starts.
 * Classification always lands a status line first, so in practice the credit is known
 * before a job ever begins.
 */

import {
  BLE_MAX_WRITES_IN_FLIGHT,
  BLE_PACKET_BUDGET,
  DETENT_BATCH_MAX_POINTS,
  DETENT_CREDIT_HEADROOM,
  PROBE,
  WASHER_EMIT_GATE_SLOTS,
  type WireCaps,
} from "@virgilvox/beam-core";
import type { Transport } from "./index.js";
import {
  formatStepBatch,
  packPulseBatch,
  packStepBatch,
  type PulseSegment,
  type StepPoint,
} from "./packet.js";

/** How long a blocked emitter waits before looking again. */
export const BLOCKED_POLL_MS = 40;
/** Consecutive blocked polls before poking the board for a fresh credit report. */
export const BLOCKED_POLLS_BEFORE_REQUERY = 25;
/** How long the emitter stands off after the board says its queue is full. */
export const QUEUE_FULL_BACKOFF_MS = 200;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface StreamHooks {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** INV-45: the stop flag is checked BEFORE emission within a tick, never after. */
  shouldStop?: () => boolean;
  onProgress?: (sent: number, total: number) => void;
  onLog?: (level: "info" | "warn" | "error", text: string) => void;
}

export interface StreamResult {
  sent: number;
  packets: number;
  /** True when the stop flag ended it early. */
  stopped: boolean;
}

/* ------------------------------------------------------------ pulse credit -- */

/**
 * The servo rig's credit window.
 *
 * `boardFree` is the board's own last word. `sentSinceReport` is everything launched
 * since, because those slots are spent even though the board has not said so yet.
 * Anything pooled locally is spending slots too, which is why the caller passes it in
 * rather than the class guessing.
 */
export class PulseCredit {
  /** Free slots as of the last report. -1 means the board has never said. */
  boardFree = -1;
  sentSinceReport = 0;
  /** The board's drop counter as of the last status line. -1 means never seen. */
  drops = -1;
  private holdUntil = 0;

  /** A fresh report resets the projection: everything before it is accounted for. */
  report(free: number): void {
    this.boardFree = free;
    this.sentSinceReport = 0;
  }

  room(pooled = 0): number {
    if (this.boardFree < 0) return Number.POSITIVE_INFINITY;
    return this.boardFree - this.sentSinceReport - pooled;
  }

  spend(n: number): void {
    this.sentSinceReport += n;
  }

  /** The board said "ERR segq full". Stand off and let it drain. */
  hold(now: number, ms = QUEUE_FULL_BACKOFF_MS): void {
    this.holdUntil = now + ms;
  }

  /**
   * May the emitter run right now?
   *
   * INV-22: the write chain is serialised, so its depth is the transport's honest
   * word on how far behind the radio is running. Emitting into a lagging chain is how
   * the board hears silence for a second and then a burst: the dead man fires into a
   * healthy plot and the late burst lands on a queue nobody measured.
   */
  gate(opts: { pooled?: number; pending: number; kind: Transport["kind"]; now: number }): boolean {
    if (opts.now < this.holdUntil) return false;
    if (opts.kind === "ble" && opts.pending > BLE_MAX_WRITES_IN_FLIGHT) return false;
    return this.room(opts.pooled ?? 0) >= WASHER_EMIT_GATE_SLOTS;
  }

  reset(): void {
    this.boardFree = -1;
    this.sentSinceReport = 0;
    this.holdUntil = 0;
  }
}

/* ------------------------------------------------------------- step credit -- */

/**
 * The stepper rig's credit window.
 *
 * INV-24: a batch is 6 points and the window wants 14 free before sending one. The
 * eight point margin is not arbitrary: the board splits a long move into as many
 * segments as it takes to keep each one under 2000 steps on the dominant axis, and it
 * inserts a backlash take-up segment of its own at a reversal, so six points on the
 * wire can become more than six slots on the board.
 */
export class StepCredit {
  free = -1;
  queued = 0;
  running = false;
  drops = -1;
  private blockedPolls = 0;

  report(free: number, queued = 0, running = false): void {
    this.free = free;
    this.queued = queued;
    this.running = running;
  }

  blocked(batchMax = DETENT_BATCH_MAX_POINTS): boolean {
    if (this.free < 0) return false;
    return this.free < batchMax + (DETENT_CREDIT_HEADROOM - DETENT_BATCH_MAX_POINTS);
  }

  spend(n: number): void {
    if (this.free >= 0) this.free = Math.max(0, this.free - n);
  }

  /** Count one blocked poll. True when it is time to ask the board again. */
  pollBlocked(): boolean {
    if (++this.blockedPolls > BLOCKED_POLLS_BEFORE_REQUERY) {
      this.blockedPolls = 0;
      return true;
    }
    return false;
  }

  clearBlocked(): void {
    this.blockedPolls = 0;
  }

  reset(): void {
    this.free = -1;
    this.queued = 0;
    this.running = false;
    this.blockedPolls = 0;
  }
}

/* ---------------------------------------------------------------- streams -- */

interface Runner {
  transport: Transport;
  hooks: StreamHooks;
}

const nap = (h: StreamHooks) => h.sleep ?? sleep;
const clock = (h: StreamHooks) => h.now ?? Date.now;
const stopped = (h: StreamHooks) => h.shouldStop?.() ?? false;

/**
 * Stream timed pulse segments, in whatever packet format the board negotiated.
 *
 * A board that never advertised a binary level still gets its segments, one text
 * `SEG` line at a time. That path exists because already flashed boards keep working
 * (INV-63), not because it is good.
 */
export async function streamPulseSegments(
  run: Runner & {
    segments: readonly PulseSegment[];
    wire: Readonly<WireCaps>;
    credit: PulseCredit;
    startSeq?: number;
  },
): Promise<StreamResult> {
  const { transport, hooks, segments, wire, credit } = run;
  const wait = nap(hooks);
  const now = clock(hooks);
  let seq = (run.startSeq ?? 0) & 0xff;
  let i = 0;
  let packets = 0;
  let blocked = 0;

  while (i < segments.length) {
    /* INV-45: with the check at the bottom of the tick, an e-stop's flush could be
     * followed by one more burst of segments in the same tick, each carrying its own
     * gate, and the beam blinked back on after the kill. */
    if (stopped(hooks)) return { sent: i, packets, stopped: true };

    if (!credit.gate({ pending: transport.pending, kind: transport.kind, now: now() })) {
      await wait(BLOCKED_POLL_MS);
      if (++blocked > BLOCKED_POLLS_BEFORE_REQUERY) {
        blocked = 0;
        /* A lost report is indistinguishable from a full queue from here. Ask. */
        await transport.sendLine(PROBE);
      }
      continue;
    }
    blocked = 0;

    const rest = segments.slice(i);
    if (wire.bin >= 1) {
      /*
       * A packet may not be larger than the credit the gate just measured. The gate
       * clears at 6 free slots and a packet carries up to 10, so without this a full
       * packet can overshoot the queue by four and the board drops the difference.
       * The shipped tool got this for free by accounting per segment as it pooled
       * them; accounting per packet has to say it out loud.
       */
      const room = credit.room(0);
      const cap = Number.isFinite(room) ? Math.max(1, Math.floor(room)) : undefined;
      let packet = packPulseBatch(rest, seq, wire, cap);
      /*
       * INV-16: escaping can grow a packet past one BLE write. These used to be
       * dropped whole, sequence gap and all. Hand segments back until it fits and
       * they ride the next packet with the sequence intact.
       */
      while (
        transport.kind === "ble" &&
        packet.bytes.length > BLE_PACKET_BUDGET &&
        packet.count > 1
      ) {
        packet = packPulseBatch(rest, seq, wire, packet.count - 1);
      }

      await transport.sendFrame(packet.bytes);
      seq = (seq + packet.count) & 0xff;
      credit.spend(packet.count);
      i += packet.count;
      packets++;
    } else {
      const s = rest[0]!;
      await transport.sendLine(
        `SEG ${Math.round(s.pan)} ${Math.round(s.tilt)} ${s.laser ? 1 : 0} ${Math.max(1, Math.round(s.durMs))}`,
      );
      credit.spend(1);
      i++;
      packets++;
    }
    hooks.onProgress?.(i, segments.length);
  }
  return { sent: i, packets, stopped: false };
}

/**
 * Stream step points.
 *
 * The text path is the shipped one and it is ported verbatim in shape: batches of six,
 * `S x,y,l[,iv]`, sleep 40 ms while the window is shut, re-query after 25 blocked
 * polls. A board advertising a step binary level gets packets instead, through the
 * same window.
 */
export async function streamStepPoints(
  run: Runner & {
    points: readonly StepPoint[];
    credit: StepCredit;
    wire?: Readonly<WireCaps>;
    batchMax?: number;
    startSeq?: number;
  },
): Promise<StreamResult> {
  const { transport, hooks, points, credit } = run;
  const wait = nap(hooks);
  const batchMax = run.batchMax ?? DETENT_BATCH_MAX_POINTS;
  const wire = run.wire;
  let seq = (run.startSeq ?? 0) & 0xff;
  let i = 0;
  let packets = 0;

  while (i < points.length) {
    if (stopped(hooks)) return { sent: i, packets, stopped: true };

    if (credit.blocked(batchMax)) {
      await wait(BLOCKED_POLL_MS);
      if (credit.pollBlocked()) await transport.sendLine(PROBE);
      continue;
    }
    credit.clearBlocked();

    const rest = points.slice(i);
    if (wire && wire.ivb >= 1) {
      let packet = packStepBatch(rest, seq, wire, batchMax);
      while (
        transport.kind === "ble" &&
        packet.bytes.length > BLE_PACKET_BUDGET &&
        packet.count > 1
      ) {
        packet = packStepBatch(rest, seq, wire, packet.count - 1);
      }
      await transport.sendFrame(packet.bytes);
      seq = (seq + packet.count) & 0xff;
      credit.spend(packet.count);
      i += packet.count;
    } else {
      const chunk = rest.slice(0, batchMax);
      await transport.sendLine(formatStepBatch(chunk));
      credit.spend(chunk.length);
      i += chunk.length;
    }
    packets++;
    hooks.onProgress?.(i, points.length);
  }
  return { sent: i, packets, stopped: false };
}

/* ------------------------------------------------------------------ drain -- */

export interface DrainOptions {
  isDrained: () => boolean;
  /** Ask the board where it is. Called at most once per `pokeEveryMs`. */
  poke: () => Promise<void>;
  hooks?: StreamHooks;
  timeoutMs?: number;
  pollMs?: number;
  pokeEveryMs?: number;
}

/**
 * Wait for the board to finish what it already holds.
 *
 * INV-82: a board that stretched segments to cover lost packets is still playing a
 * tail, so cutting the beam when the host's timeline ends lands the cut in the middle
 * of the last stroke. Bounded, because a board that never reports drained must not
 * hold the beam on forever: two seconds, polled at 40 ms.
 */
export async function drainQueue(opts: DrainOptions): Promise<boolean> {
  const hooks = opts.hooks ?? {};
  const wait = nap(hooks);
  const now = clock(hooks);
  const timeoutMs = opts.timeoutMs ?? 2000;
  const pollMs = opts.pollMs ?? 40;
  const pokeEveryMs = opts.pokeEveryMs ?? 200;

  const started = now();
  let lastPoke = Number.NEGATIVE_INFINITY;
  for (;;) {
    /*
     * Poke first, always, and only believe the answer that comes back after it. The
     * host's last credit report was taken before the tail was sent, so a queue that
     * looks empty from here has simply not been asked about yet: returning on it cuts
     * the beam in the middle of the last stroke, which is the exact failure INV-82
     * exists to prevent.
     */
    if (now() - lastPoke >= pokeEveryMs) {
      lastPoke = now();
      await opts.poke();
    }
    await wait(pollMs);
    if (opts.isDrained()) return true;
    if (now() - started >= timeoutMs) return false;
  }
}
