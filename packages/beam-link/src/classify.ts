/*
 * The probe, and the rule that makes connecting safe.
 *
 * INV-62a: the app sends NOTHING but the probe until the peer is classified. Not a
 * config pull, not a report request, not a banner. This module is where that rule is
 * mechanised, and it is the reason it is a module at all rather than three lines in
 * the connect path: everything else in the SDK goes through Device, which refuses to
 * write anything but the probe until this function has returned a lineage.
 *
 * The two text vocabularies collide destructively, verified against the shipped
 * firmware. The step parser dispatches on the FIRST CHARACTER of the line and treats
 * the rest as arguments, so a friendly opening line from the pulse vocabulary is a
 * command over there:
 *
 *   ECHO 0        -> 'E' with rest "CHO 0", which parses as 0 and RELEASES BOTH COIL SETS
 *   M 1500 1500 0 -> a move in MILLIMETRES, full travel, unclamped because soft
 *                    limits default off
 *   STATUS        -> 'S' plus "TATUS", which enters the batch move path
 *
 * The probe is "?", one byte, the status command in both protocols, and it can never
 * open a binary frame because 0x3F is outside the 0xA0..0xAF magic range.
 *
 * INV-62b: lineage is the CASE of the status prefix. Uppercase "STAT " is the pulse
 * lineage, lowercase "st " is the step lineage. Both shipped apps already match their
 * own prefix case sensitively, so this costs nothing to adopt. Retries are spaced at
 * 400 ms, chosen against the 250 ms framer idle abandon so that a board which was
 * mid packet when the probe arrived has had time to give up on that frame.
 */

import {
  HELLO,
  LINEAGE,
  PROBE,
  PROBE_MAX_RETRIES,
  PROBE_RETRY_MS,
  PROBE_TIMEOUT_MS,
  type WireCaps,
} from "@virgilvox/beam-core";
import type { Transport } from "./index.js";

export type Lineage = "pulse" | "step";

export interface ProbeOptions {
  /** Spacing between probes. Defaults to the 400 ms the framer's idle abandon buys. */
  retryMs?: number;
  /** Total budget before giving up and staying in simulator mode. */
  timeoutMs?: number;
  /** Probes after the first. Two, so three go out inside the 1200 ms budget. */
  maxRetries?: number;
  /**
   * A banner seen before classification started. Opening a USB serial port may reset
   * the board over DTR and produce a hello line before anything was asked for; a BLE
   * connect never does, which is why classification cannot depend on one.
   */
  hello?: string;
}

export interface Classification {
  /** Null means unclassified. The caller stays in simulator mode and sends nothing. */
  lineage: Lineage | null;
  /** The status line as it arrived, kept verbatim so an unclaimed board can be shown. */
  statusLine: string;
  /** Every `k=v` token on the status line, as text. */
  kv: Record<string, string>;
  /** The same tokens parsed as numbers, dropping the ones that are not numeric. */
  status: Record<string, number>;
  /** What THIS board negotiated. Discovered, never assumed. */
  wire: WireCaps;
  /** The hello line if one arrived, else empty. */
  hello: string;
  /** How many probes actually went out. Nothing else did. */
  probes: number;
  /** Milliseconds from the first probe to the answer, or to giving up. */
  elapsedMs: number;
}

/** Which lineage claims this line, if either. */
export function lineageOf(line: string): Lineage | null {
  if (LINEAGE.pulse.test(line)) return "pulse";
  if (LINEAGE.step.test(line)) return "step";
  return null;
}

/** Is this line a board announcing itself unprompted? */
export function isHello(line: string): boolean {
  return HELLO.washerLegacy.test(line) || HELLO.detentLegacy.test(line) || HELLO.beam.test(line);
}

/**
 * Every `k=v` token in a line, as text.
 *
 * The leading prefix ("STAT", "st", "CFG", "qc1") carries no equals sign, so it falls
 * out without needing to be counted, which matters because the two lineages do not
 * agree on how many words come before the first token.
 */
export function parseKv(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of line.trim().split(/\s+/)) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out;
}

/** The numeric subset of a kv record. A key whose value is not a number is dropped. */
export function numericKv(kv: Readonly<Record<string, string>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(kv)) {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

const int = (kv: Readonly<Record<string, string>>, k: string, dflt: number): number => {
  const v = kv[k];
  if (v === undefined) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

/**
 * What the board's own status line says it can do.
 *
 * This is deliberately not `MachineCapabilities`. That type says what a KIND of
 * machine can do and it is intrinsic to the hardware; this says what one board
 * running one firmware revision negotiated, and two boards of the same rig can
 * disagree. They were one type once and the SDK's Peer silently picked up the wrong
 * one, with `dither` where it needed `tick`, and it compiled.
 *
 * Legacy boards advertise none of these tokens. A legacy step board still has a
 * queue it reports as `q=` and `free=`, which is what `seg` means, so it is inferred
 * rather than assumed absent.
 */
export function wireCapsFrom(kv: Readonly<Record<string, string>>): WireCaps {
  return {
    seg: kv["seg"] === "1" || kv["free"] !== undefined || kv["q"] !== undefined,
    bin: int(kv, "bin", 0),
    herm: kv["herm"] === "1",
    ivb: int(kv, "ivb", 0),
    /* Zero means this board has no step clock and `iv` is meaningless on it. The
     * legacy step board publishes its tick rate on the version line instead, which
     * is why Device asks for that once the lineage is known. Never compiled in: the
     * stale comment in the firmware is exactly how a host ends up off by a factor
     * of two. */
    tick: int(kv, "tick", 0),
    esc: kv["esc"] === "2" ? 2 : 1,
    proto: int(kv, "proto", 0),
  };
}

/** No `proto` token on the status line means an unmodified board of its own lineage. */
export function isLegacy(wire: WireCaps): boolean {
  return wire.proto === 0;
}

const emptyWire = (): WireCaps => ({
  seg: false,
  bin: 0,
  herm: false,
  ivb: 0,
  tick: 0,
  esc: 1,
  proto: 0,
});

/**
 * Probe the peer and read its lineage off the case of the reply.
 *
 * The only thing this writes is `?`. If nothing answers inside the budget the caller
 * gets a null lineage and must stay in simulator mode: guessing the vocabulary is the
 * one move that can release a stepper's coils or slam it across its travel.
 */
export async function classify(
  transport: Transport,
  opts: ProbeOptions = {},
): Promise<Classification> {
  const retryMs = opts.retryMs ?? PROBE_RETRY_MS;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? PROBE_MAX_RETRIES;

  let hello = opts.hello ?? "";
  let statusLine = "";
  let closed = false;
  let probes = 0;
  let wake: (() => void) | null = null;

  const offLine = transport.onLine((raw) => {
    const line = raw.trim();
    if (!line) return;
    if (!hello && isHello(line)) hello = line;
    if (!statusLine && lineageOf(line)) {
      statusLine = line;
      wake?.();
    }
  });
  const offClose = transport.onClose(() => {
    closed = true;
    wake?.();
  });

  /* Resolves early the moment the answer lands, so a healthy board costs one round
   * trip rather than a fixed 400 ms. */
  const waitFor = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const started = Date.now();
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      probes++;
      await transport.sendLine(PROBE);
      /* No await between this check and the executor inside waitFor, so an answer
       * cannot land in the gap and be waited out anyway. */
      if (statusLine || closed) break;
      await waitFor(retryMs);
      if (statusLine || closed) break;
    }
    /* The retries fit inside the budget by construction, but a caller may widen the
     * budget without widening the spacing. Spend whatever is left listening. */
    const left = timeoutMs - (Date.now() - started);
    if (!statusLine && !closed && left > 0) await waitFor(left);
  } finally {
    wake = null;
    offLine();
    offClose();
  }

  const kv = statusLine ? parseKv(statusLine) : {};
  return {
    lineage: statusLine ? lineageOf(statusLine) : null,
    statusLine,
    kv,
    status: numericKv(kv),
    wire: statusLine ? wireCapsFrom(kv) : emptyWire(),
    hello,
    probes,
    elapsedMs: Date.now() - started,
  };
}
