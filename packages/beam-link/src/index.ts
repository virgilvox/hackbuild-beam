/**
 * @virgilvox/beam-link
 *
 * The SDK. This is what someone installs to drive a BEAM machine from their own
 * code, without the studio app.
 *
 * Safety behaviors live here and not in the app, so every consumer inherits them:
 * the dead man contract, the disconnect kill, the keepalive, the stall poke and the
 * starvation gate.
 *
 * The one rule that outranks the rest is INV-62a, and it is mechanised rather than
 * documented: `Device.send` refuses to write anything but the probe until the peer has
 * said which of the two text vocabularies is listening. The two collide destructively,
 * and `ECHO 0` to a step board releases its coils.
 *
 * Browser transports live behind the `/web` entry, which is the only place in the SDK
 * allowed to touch a browser global. Everything here runs headless.
 */

import type { MachineProfile, WireCaps } from "@virgilvox/beam-core";
import type { BoardConfig } from "./config.js";

export interface Transport {
  readonly kind: "serial" | "ble" | "mock";
  /** Writes in flight. This is the backpressure signal, and it is the transport's
   * honest word on how far behind it is running. */
  readonly pending: number;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendLine(text: string): Promise<void>;
  sendFrame(bytes: Uint8Array): Promise<void>;
  onLine(cb: (line: string) => void): () => void;
  onClose(cb: () => void): () => void;
}

/**
 * What a board turned out to be, after classification.
 *
 * INV-62a: nothing is sent but the probe until this exists. The two text
 * vocabularies collide destructively, and `ECHO 0` to a step board releases its
 * coils.
 */
export interface Peer {
  lineage: "pulse" | "step";
  /** No `proto` token on the status line: an unmodified board of its own lineage. */
  legacy: boolean;
  /** What kind of machine this is. Its `caps` are intrinsic to the hardware. */
  profile: MachineProfile;
  /**
   * What THIS board negotiated, which is a different question from what its kind of
   * machine can do. Two boards of the same rig running different firmware revisions
   * have the same `profile.caps` and different `wire`.
   */
  wire: WireCaps;
  hello: string;
}

export type DeviceState =
  | "disconnected"
  | "classifying"
  | "unknown"
  | "adopting"
  | "idle"
  | "running"
  | "paused";

export interface DeviceEvents {
  state: DeviceState;
  peer: Peer;
  status: Record<string, number>;
  config: Record<string, string>;
  position: { a: number; b: number; laser: boolean; free: number };
  log: { level: "info" | "warn" | "error" | "tx" | "rx"; text: string };
  error: Error;
  /** The board's stored setup, parsed into its own lineage's shape. */
  board: BoardConfig;
  progress: { sent: number; total: number };
  /**
   * INV-25: a rising drop counter is erased geometry and is never silent. Nothing
   * else in the system can tell that the drawing on the wall is missing a piece.
   */
  drops: { total: number; delta: number };
  /**
   * INV-44: every flush is paired with zeroing what the host assumed about the board,
   * because the board's own clear zeroes its velocity. A consumer running a local twin
   * of the playback resets it here.
   */
  flush: { reason: string };
}

export { Emitter, type Listener, type Unsubscribe } from "./emitter.js";

export {
  classify,
  isHello,
  isLegacy,
  lineageOf,
  numericKv,
  parseKv,
  wireCapsFrom,
  type Classification,
  type Lineage,
  type ProbeOptions,
} from "./classify.js";

export {
  WASHER_CORNER_KEYS,
  detentConfigLines,
  detentProfileConfig,
  parseDetentConfig,
  parseWasherConfig,
  washerConfigLine,
  washerProfileConfig,
  type BoardConfig,
  type CornerAimDeg,
  type CornerAimSteps,
  type DetentBoardConfig,
  type WasherBoardConfig,
  type WasherCornerKey,
} from "./config.js";

export {
  formatStepBatch,
  packPulseBatch,
  packPulseDelta,
  packPulseFlat,
  packPulseHermite,
  packStepBatch,
  packStepDelta,
  packStepFlat,
  packStepRun,
  pulseDeltaRun,
  stepDeltaRun,
  type PulsePacket,
  type PulseSegment,
  type StepPacket,
  type StepPoint,
} from "./packet.js";

export {
  BLOCKED_POLLS_BEFORE_REQUERY,
  BLOCKED_POLL_MS,
  PulseCredit,
  QUEUE_FULL_BACKOFF_MS,
  StepCredit,
  drainQueue,
  sleep,
  streamPulseSegments,
  streamStepPoints,
  type DrainOptions,
  type StreamHooks,
  type StreamResult,
} from "./stream.js";

export {
  DEADMAN_MS,
  KEEPALIVE_MS,
  Keepalive,
  SAFE_PROBE,
  StarvationGate,
  isBoardDeadman,
  isErrorLine,
  isQueueFull,
  killBeam,
  stopSequence,
} from "./safety.js";

export { Device, type DeviceOptions, type Job } from "./device.js";

export {
  MockBoard,
  MockTransport,
  boardState,
  type MockBoardOptions,
  type MockBoardState,
  type MockTransportOptions,
  type TrafficEntry,
} from "./transports/mock.js";
