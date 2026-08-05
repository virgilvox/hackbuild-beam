/*
 * The wire contract, in one place.
 *
 * This module is the single source for the protocol. `tools/gen-protocol` reads it
 * and writes two things: docs/protocol.md, and a generated C header that both
 * firmware sketches include. That closes the drift question the two original PRDs
 * answered in opposite directions, one making the .ino header authoritative and
 * the other making the JS authoritative. Neither is: this file is, and both sides
 * are generated from it, so they cannot disagree.
 */

/* ------------------------------------------------------------------ domains -- */

/**
 * There are two coordinate domains and they must never be confused.
 *
 * A pulse value is effectively unsigned, 500 to 2500, and its time unit is a whole
 * millisecond that the board interpolates across. A half step is a signed count
 * either side of zero, and its time unit is an exact integer number of ISR ticks
 * between steps. Neither field can carry the other's values.
 *
 * The magic byte is the domain discriminator and nothing else is: no token, no
 * negotiated mode, no header flag. A board that one day drives both a servo head
 * and a stepper head accepts both families with zero ambiguity, because A5 means
 * pulses and A3 means steps at the byte level.
 *
 * This is the direct lesson of the escape asymmetry below. One mechanism with two
 * meanings keyed by a version guess is how that asymmetry got in, and it is still
 * the one place sender and receiver disagree today.
 */
export type Domain = "pulse" | "step";

/* ------------------------------------------------------------------- magics -- */

/**
 * Only 0xA0 through 0xAF can ever be a magic byte, because the receiver
 * reconstructs an escaped byte as `0xA0 | (b & 0x0F)`. That is a hard sixteen value
 * budget, so 0xA3 spends one of it and a sub-format nibble keeps three new step
 * formats inside that one magic.
 */
export const MAGIC = {
  /** Step domain. Sub-format lives in the high nibble of the count byte. */
  STEP: 0xa3,
  /** Pulse domain, hermite: endpoint plus endpoint velocity. */
  HERMITE: 0xa4,
  /** Pulse domain, flat: every pulse absolute. */
  FLAT: 0xa5,
  /** Pulse domain, delta: absolute anchor then signed byte deltas. */
  DELTA: 0xa6,
  /** Escape: the next byte is a literal carried in its low nibble. */
  ESC: 0xa7,
} as const;

/** Step sub-formats, packed as `(fmt << 4) | count` into byte 1. */
export const STEP_FMT = {
  FLAT: 0,
  DELTA: 1,
  /** Packet-wide interval. The cruise case: a straight run at constant planned speed. */
  RUN: 2,
} as const;

/**
 * The escape asymmetry, which is deliberate and load bearing on the legacy formats.
 *
 * Hermite packets escape 0xA4 through 0xA7. Legacy flat and delta packets escape
 * only 0xA5 through 0xA7, because firmware that predates the 0xA4 magic would
 * mistranslate `A7 04`. Byte 0, the magic itself, is never escaped in either case.
 *
 * The new step family does not extend the asymmetry, it ends it: a uniform 0xA3
 * floor, so the escaped set equals the restart set and there is nothing left to get
 * out of step.
 *
 * There is a known consequence on the legacy path, recorded because it is the one
 * place sender and receiver disagree today: a flat or delta payload byte that
 * happens to equal 0xA4 goes out raw, and the shipped receiver treats a raw 0xA4
 * mid packet as a frame restart. It is self limiting, since the restart consumes the
 * tail and the frame either times out or fails CRC while the sequence stays primed,
 * but it costs a packet. The merged receiver fixes it by treating a magic byte as an
 * opener only when no frame is currently open, which is compatible in both
 * directions.
 */
export const ESCAPE_LOW = {
  HERMITE: 0xa4,
  LEGACY: 0xa5,
  /** Merged framer contract, esc=2. Uniform floor across every format. */
  UNIFORM: 0xa3,
} as const;

/* -------------------------------------------------------------------- flags -- */

/**
 * The per segment flags byte, and the whole of what the stepper rig contributes to
 * the servo rig's framing.
 *
 * DETENT's firmware already packs exactly these two bits into its own per segment
 * field and already reads bit 1 with this meaning, and its enqueue side already
 * builds the byte the same way. So the merge is one bit in an existing byte rather
 * than a new field or a new format.
 *
 * Do not clean these up into two booleans. The serialiser and the ISR must agree
 * that a planned travel move has bit 1 set and bit 0 clear, in one byte.
 */
export const FLAG = {
  /** Beam gate for the whole of this segment. */
  LASER: 0x01,
  /**
   * Planned: the board executes the timing it was given, verbatim, and stacks no
   * ramp of its own. The host owns acceleration.
   *
   * Without this the firmware applies its own standstill ramp on top of a plan that
   * already decelerated into the corner, and the two compound. With it, the bench
   * measured first gap and max gap both landing on the commanded interval rather
   * than at the roughly 3x ramped value.
   *
   * The backlash take-up segment deliberately clears this bit: it happens at a
   * reversal, which is exactly where speed costs steps, so it always gets the
   * firmware's own ramp.
   */
  PLANNED: 0x02,
  /* Bits 2..7 reserved. Sender writes zero, receiver ignores rather than rejects,
   * so a later bit is purely additive and needs no new format number. */
} as const;

/* ------------------------------------------------------------------ formats -- */

export interface SegmentField {
  readonly name: string;
  readonly bytes: number;
  readonly type: "u8" | "i8" | "u16le" | "i16le";
  readonly note: string;
}

export interface PacketFormat {
  readonly name: string;
  readonly domain: Domain;
  readonly magic: number;
  /** Step formats only: the sub-format nibble. */
  readonly fmt?: number;
  /** Segments per packet. Matches the firmware framer's count validation exactly. */
  readonly maxCount: number;
  readonly escapeLow: number;
  /** Fields carried once, before the per segment records. */
  readonly prefix?: readonly SegmentField[];
  readonly anchor?: readonly SegmentField[];
  readonly segment: readonly SegmentField[];
  readonly requires: readonly string[];
}

const PAN: SegmentField = {
  name: "pan",
  bytes: 2,
  type: "u16le",
  note: "servo pulse microseconds, clamped to the board's window, default 500..2500",
};
const TILT: SegmentField = { ...PAN, name: "tilt" };

const STEP_X: SegmentField = {
  name: "x",
  bytes: 2,
  type: "i16le",
  note: "absolute logical step target, signed. The board computes its own delta",
};
const STEP_Y: SegmentField = { ...STEP_X, name: "y" };

const FLAGS: SegmentField = {
  name: "flags",
  bytes: 1,
  type: "u8",
  note: "bit 0 beam gate, bit 1 planned, bits 2-7 reserved zero",
};

const DUR: SegmentField = {
  name: "dur",
  bytes: 1,
  type: "u8",
  note: "duration in whole milliseconds, 1..255. Pulse domain only",
};

const IV: SegmentField = {
  name: "iv",
  bytes: 2,
  type: "u16le",
  note: "ISR ticks between dominant axis steps, 1..65535. Step domain only",
};

export const FORMATS: readonly PacketFormat[] = [
  {
    name: "hermite",
    domain: "pulse",
    magic: MAGIC.HERMITE,
    maxCount: 8,
    escapeLow: ESCAPE_LOW.HERMITE,
    segment: [
      PAN,
      TILT,
      {
        name: "velP",
        bytes: 1,
        type: "i8",
        note: "arrival velocity, sixteenths of a microsecond per millisecond",
      },
      { name: "velT", bytes: 1, type: "i8", note: "as velP" },
      FLAGS,
      DUR,
    ],
    requires: ["bin"],
  },
  {
    name: "flat",
    domain: "pulse",
    magic: MAGIC.FLAT,
    maxCount: 10,
    escapeLow: ESCAPE_LOW.LEGACY,
    segment: [PAN, TILT, FLAGS, DUR],
    requires: ["bin"],
  },
  {
    name: "delta",
    domain: "pulse",
    magic: MAGIC.DELTA,
    maxCount: 10,
    escapeLow: ESCAPE_LOW.LEGACY,
    anchor: [PAN, TILT, FLAGS, DUR],
    segment: [
      {
        name: "dPan",
        bytes: 1,
        type: "i8",
        note: "signed delta from the previous segment. Deltas never span packets",
      },
      { name: "dTilt", bytes: 1, type: "i8", note: "as dPan" },
      FLAGS,
      DUR,
    ],
    requires: ["bin>=2"],
  },
  {
    name: "step-flat",
    domain: "step",
    magic: MAGIC.STEP,
    fmt: STEP_FMT.FLAT,
    maxCount: 8,
    escapeLow: ESCAPE_LOW.UNIFORM,
    segment: [STEP_X, STEP_Y, FLAGS, IV],
    requires: ["ivb>=1"],
  },
  {
    name: "step-delta",
    domain: "step",
    magic: MAGIC.STEP,
    fmt: STEP_FMT.DELTA,
    maxCount: 10,
    escapeLow: ESCAPE_LOW.UNIFORM,
    anchor: [STEP_X, STEP_Y, FLAGS, IV],
    segment: [
      {
        name: "dx",
        bytes: 1,
        type: "i8",
        note: "signed half step delta. Quantise samples at most one step apart, so this rarely binds",
      },
      { name: "dy", bytes: 1, type: "i8", note: "as dx" },
      FLAGS,
      IV,
    ],
    requires: ["ivb>=2"],
  },
  {
    name: "step-run",
    domain: "step",
    magic: MAGIC.STEP,
    fmt: STEP_FMT.RUN,
    maxCount: 15,
    escapeLow: ESCAPE_LOW.UNIFORM,
    /* One interval for every segment in the packet whose planned bit is set. A
     * segment with the bit clear ignores it and takes the board's own rate and ramp,
     * so a run may legitimately mix planned and unplanned segments: a lash take-up
     * landing mid run, for example. */
    prefix: [IV],
    anchor: [STEP_X, STEP_Y, FLAGS],
    segment: [
      { name: "dx", bytes: 1, type: "i8", note: "signed half step delta" },
      { name: "dy", bytes: 1, type: "i8", note: "as dx" },
      FLAGS,
    ],
    requires: ["ivb>=3"],
  },
] as const;

/** Header is magic, count, seq. Trailer is one CRC8 byte over the unescaped bytes. */
export const HEADER_BYTES = 3;
export const CRC_BYTES = 1;

const width = (fs: readonly SegmentField[] | undefined): number =>
  (fs ?? []).reduce((n, f) => n + f.bytes, 0);

export function packetSize(fmt: PacketFormat, count: number): number {
  const head = HEADER_BYTES + width(fmt.prefix);
  if (fmt.anchor) {
    return head + width(fmt.anchor) + (count - 1) * width(fmt.segment) + CRC_BYTES;
  }
  return head + count * width(fmt.segment) + CRC_BYTES;
}

/** Byte 1 for a step packet: the sub-format nibble above the count. */
export function stepCountByte(fmt: number, count: number): number {
  return ((fmt & 0x0f) << 4) | (count & 0x0f);
}

export function parseStepCountByte(b: number): { fmt: number; count: number } {
  return { fmt: (b >> 4) & 0x0f, count: b & 0x0f };
}

/* ------------------------------------------------------------- capabilities -- */

/**
 * Capability tokens as they appear in a status line.
 *
 * `bin` and `ivb` are independent ladders. A board may advertise both, either, or
 * neither, and nothing about that is ambiguous because the magic byte keys the
 * domain. The coordinate domain is deliberately NOT a token: it is derivable from
 * the magic byte, from `tick`, and from which ladder is nonzero, and a fourth
 * statement of it is a fourth thing that can disagree.
 */
export const CAP_TOKENS = {
  seg: { token: "seg", meaning: "board takes timed segments at all" },
  bin: { token: "bin", meaning: "pulse binary level. 1 flat, 2 also delta" },
  herm: { token: "herm", meaning: "A4 hermite understood. Only meaningful with bin" },
  ivb: { token: "ivb", meaning: "step binary level. 1 flat, 2 also delta, 3 also run" },
  tick: { token: "tick", meaning: "ISR base rate in hertz, the denominator for iv" },
  esc: { token: "esc", meaning: "framer contract. 1 legacy floors, 2 uniform 0xA3 floor" },
  proto: { token: "proto", meaning: "merged protocol level. Absent means legacy" },
} as const;

/**
 * What a particular BOARD reported on its status line. Discovered at connect, never
 * assumed, and distinct from what the machine kind can do (`MachineCapabilities`).
 */
export interface WireCaps {
  seg: boolean;
  bin: number;
  herm: boolean;
  ivb: number;
  /** Hertz. 0 means this board has no step clock and `iv` is meaningless on it. */
  tick: number;
  esc: 1 | 2;
  proto: number;
}

/* ---------------------------------------------------------------- lineage -- */

/**
 * Classification, and the rule that makes connecting safe.
 *
 * The app sends NOTHING but the probe until the peer is classified. Not a config
 * pull, not a report request, not a banner.
 *
 * This is a safety rule, not tidiness. The two text vocabularies collide
 * destructively because the step firmware dispatches on the first character of the
 * line and treats the rest as arguments. Verified against the shipped firmware:
 *
 *   ECHO 0          -> `E` with rest "CHO 0", parses as 0, RELEASES BOTH COIL SETS
 *   M 1500 1500 0   -> `M x y l` in MILLIMETRES, a full travel slam, unclamped
 *                      because soft limits default off
 *   M 10 20 1       -> on the pulse board, clamps to the corner with the BEAM LIT
 *
 * Not every collision is dangerous. PING lands on `P` with an unparseable argument,
 * so it falls to the read-only corner dump rather than capturing a corner, and
 * FLUSH is simply unknown. But the two above are enough on their own.
 */
export const PROBE = "?";

/**
 * The lineage discriminator is the case of the first token, and it is free: both
 * shipped apps already match their own status prefix case sensitively.
 */
export const LINEAGE = {
  pulse: /^STAT /,
  step: /^st /,
} as const;

/** Retry spacing chosen against the framer: an incomplete frame is abandoned at 250 ms. */
export const PROBE_RETRY_MS = 400;
export const PROBE_TIMEOUT_MS = 1200;
export const PROBE_MAX_RETRIES = 2;

/**
 * How a board announces itself unprompted. Opening a USB serial port may reset the
 * board via DTR and produce a boot banner; a BLE connect never does.
 */
export const HELLO = {
  washerLegacy: /^READY LASER RIG\b/,
  detentLegacy: /^detent\s+(ready|\d+\.\d+)\b/,
  beam: /^BEAM\s+(\d+\.\d+)\b/,
} as const;

/* ---------------------------------------------------------------- timing -- */

/**
 * Interval and duration are NOT the same field and neither is derived from the
 * other on the wire. This helper exists for the planner and the simulator, which do
 * need to reason across both, and for nothing else.
 *
 * An earlier draft proposed making millisecond duration universal and having a
 * stepper derive its interval from it. That is wrong. In the step domain the
 * duration is fully determined: a segment takes `dmaj * iv` ticks, an exact integer
 * relation at 50 microsecond granularity. Forcing a whole millisecond field in
 * between reintroduces precisely the rounding that the residual carry exists to
 * compensate, except worse, because it would happen on the board where the host's
 * residual cannot reach it.
 *
 * `tickHz` is negotiated, never compiled in. The board publishes it and the app
 * divides by what it read, which is why the stale comment in the firmware can never
 * again make a host off by a factor of two.
 */
export function intervalToDurationMs(intervalTicks: number, dominantAxisSteps: number, tickHz: number): number {
  if (tickHz <= 0) return 0;
  return (intervalTicks * dominantAxisSteps * 1000) / tickHz;
}

/** Rate in steps per second to interval in ticks. Truncating, to match C. */
export function rateToInterval(stepsPerSec: number, tickHz: number): number {
  const sps = Math.max(1, stepsPerSec);
  return Math.min(65535, Math.max(1, Math.trunc(tickHz / sps)));
}
