/*
 * The safety contract, client half.
 *
 * These behaviors live in the SDK and not in the app, so every consumer inherits
 * them: the dead man, the keepalive, the starvation gate, the stop ordering and the
 * disconnect kill. An app that forgets one of these is an app that leaves a lit beam
 * pointed at a wall, and there will be more than one app.
 *
 * Each half of the contract belongs to the side that can actually see the failure.
 * The BOARD owns the dead man, because only the board knows the host has gone quiet.
 * The HOST owns the keepalive, because only the host knows it is still there and
 * deliberately holding a beam on while an operator lines up a corner.
 */

import {
  DETENT_DEADMAN_MS,
  PROBE,
  STARVATION_GATE_MS,
  WASHER_DEADMAN_MS,
} from "@virgilvox/beam-core";
import type { Lineage } from "./classify.js";

/**
 * The board's dead man window per lineage, milliseconds.
 *
 * These are the shipped defaults and the keepalive periods below are chosen to sit
 * inside them with margin. A board that reports a different `dm` on its config line
 * is the authority for that board and the caller should prefer it.
 */
export const DEADMAN_MS: Record<Lineage, number> = {
  pulse: WASHER_DEADMAN_MS,
  step: DETENT_DEADMAN_MS,
};

/**
 * Keepalive periods, both ported.
 *
 * INV-48 `[washer]`: idle polls once a second whenever connected, and the in-plot poll
 * is every 1.2 s, inside the 1.5 s dead man. An operator jogging corners sends no
 * traffic at all for long stretches, and the board cannot tell that apart from a dead
 * host.
 *
 * INV-47 `[detent]`: poll every 2 s while the beam is manually held on, inside the
 * board's 5 s dead man, so a deliberate alignment hold is not cut. While the beam is
 * off there is nothing to protect, and while a plot is running the stream itself is
 * the traffic, so both cases poll nothing and stay off the wire.
 */
export const KEEPALIVE_MS = {
  pulseIdle: 1000,
  pulseRunning: 1200,
  stepBeamHeld: 2000,
} as const;

/**
 * The keepalive clock.
 *
 * Written as a predicate over an injected `now` rather than as a timer, because the
 * period changes with what the operator is doing and re-arming an interval on every
 * state change is how a keepalive ends up firing twice or not at all. The owner calls
 * `due()` on whatever tick it already has; `start()` is the convenience for a consumer
 * that has no tick of its own.
 */
export class Keepalive {
  running = false;
  beamOn = false;
  private last = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly lineage: Lineage) {}

  /** Zero means this state needs no polling at all. */
  periodMs(): number {
    if (this.lineage === "pulse") return this.running ? KEEPALIVE_MS.pulseRunning : KEEPALIVE_MS.pulseIdle;
    if (this.beamOn && !this.running) return KEEPALIVE_MS.stepBeamHeld;
    return 0;
  }

  /** True exactly once per period. Records the time, so the caller may just send. */
  due(now: number): boolean {
    const period = this.periodMs();
    if (period <= 0) return false;
    if (now - this.last < period) return false;
    this.last = now;
    return true;
  }

  reset(now: number): void {
    this.last = now;
  }

  /**
   * Poll on an interval of our own. The granularity is deliberately finer than the
   * shortest period so that a change of state takes effect at the next tick rather
   * than at the end of the period that was running when it changed.
   */
  start(send: () => void, now: () => number = Date.now, granularityMs = 100): void {
    this.stop();
    this.reset(now());
    this.timer = setInterval(() => {
      if (this.due(now())) send();
    }, granularityMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/* ------------------------------------------------------------- board words -- */

/**
 * The board saying it cut the beam because nothing reached it in time.
 *
 * Streaming on regardless would draw from the wrong place, so the caller pauses here
 * and lets the operator resume from where the beam stopped. Both lineages announce it,
 * in their own words.
 */
export function isBoardDeadman(line: string): boolean {
  return /^ERR deadman\b/.test(line) || /^warn deadman\b/.test(line);
}

/** The board saying its queue is full. The emitter stands off rather than piling on. */
export function isQueueFull(line: string): boolean {
  return line === "ERR segq full" || /^err full\b/.test(line);
}

/** A board error line worth surfacing, in either vocabulary. */
export function isErrorLine(line: string): boolean {
  return /^ERR\b/.test(line) || /^err\b/.test(line) || /^warn\b/.test(line);
}

/* ---------------------------------------------------------------- stopping -- */

/**
 * INV-43: stop is flush THEN beam off, never the reverse.
 *
 * Sending only the gate and leaving the board's queue standing meant every queued
 * segment relit the beam and the board kept drawing an entire buffer of stale frames
 * while the app believed it was paused.
 *
 * On the step lineage `X` does both atomically inside the board's critical section,
 * which is strictly better than two lines; the explicit `L 0` after it costs one line
 * and removes the question of what happens if the first one is lost.
 *
 * `L 0` is the one command that is identical in name, arity and meaning on both
 * boards, which is why it is safe to be the last word in either vocabulary.
 */
export function stopSequence(lineage: Lineage): string[] {
  return lineage === "pulse" ? ["FLUSH", "L 0"] : ["X", "L 0"];
}

/**
 * INV-46: a BLE disconnect kills the beam, flushes the queue and re-advertises. That
 * is the board's own behavior and it needs no help. There is no USB CDC equivalent,
 * so on a serial link the board's dead man is the only backstop, and a host that is
 * about to close the port deliberately should not rely on it: it should stop first.
 *
 * Best effort by construction. A link that is already gone will throw here, and
 * throwing out of a disconnect path would leave the transport open.
 */
export async function killBeam(
  lineage: Lineage,
  sendLine: (line: string) => Promise<void>,
): Promise<void> {
  for (const line of stopSequence(lineage)) {
    try {
      await sendLine(line);
    } catch {
      return;
    }
  }
}

/* -------------------------------------------------------------- starvation -- */

/**
 * INV-42: the starvation gate cuts the beam within 300 ms when an armed job runs dry,
 * and zeroes tracked velocity.
 *
 * Holding the beam lit at a dead stop burns a dot into the glow paint until the dead
 * man notices, which on the servo rig is 1.5 s away. The next segment relights it,
 * because every segment carries its own gate, so this costs nothing on a link that
 * recovers.
 *
 * The board runs this itself. The host copy exists for the legacy boards that do not,
 * and because the host is the one that knows a job was armed at all.
 */
export class StarvationGate {
  armed = false;
  private lastFed = 0;

  constructor(readonly windowMs: number = STARVATION_GATE_MS) {}

  /** Something reached the board. */
  fed(now: number): void {
    this.lastFed = now;
  }

  arm(now: number): void {
    this.armed = true;
    this.lastFed = now;
  }

  disarm(): void {
    this.armed = false;
  }

  /** True once the armed job has produced nothing for the whole window. */
  starved(now: number): boolean {
    return this.armed && now - this.lastFed >= this.windowMs;
  }
}

/**
 * The one line that is safe to send to an unclassified peer.
 *
 * Re-exported here so a consumer writing its own connect path does not have to know
 * that the probe lives in the protocol spec. INV-62a: nothing else may go out until
 * the lineage is known.
 */
export const SAFE_PROBE = PROBE;
