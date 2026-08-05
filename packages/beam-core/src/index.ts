/**
 * @virgilvox/beam-core
 *
 * The BEAM engine. Machine profiles, geometry, calibration, planner, wire protocol
 * and the firmware reference model. Zero dependencies, no DOM, runs headless in
 * node and unchanged in a browser.
 *
 * The machine profile is the load bearing idea: a servo pan/tilt head and a two
 * mirror stepper scanner are the same geometric model with different parameters,
 * so one planner drives both without ever learning whether an axis unit is a
 * microsecond or a half step. See geometry/gimbal.ts for the derivation.
 */

export * from "./types.js";
export * from "./constants.js";

export {
  MIN_THROW_MM,
  anglesToMm,
  anglesToUV,
  mmToAngles,
  mmToUV,
  sweepDeg,
  uvToAngles,
  uvToMm,
  type Angles,
  type UV,
} from "./geometry/gimbal.js";

export {
  cornerResidualMm,
  createHomographyCalibration,
  invertHomography,
  quadAspect,
  solveHomography,
  type Correspondence,
  type Homography8,
  type Homography9,
} from "./geometry/homography.js";

export {
  createBilinearCalibration,
  type BilinearField,
  type CornerAngles,
} from "./geometry/bilinear.js";

export {
  GAIN_EPSILON,
  dedupeQuantised,
  limitFromGain,
  quantisePath,
  type PlannedPoint,
} from "./planner/guards.js";

export {
  ACC_SHARE,
  CORNER_DEG,
  CORNER_FRAC,
  DEDUPE_EPS_MM,
  DENSE_MM,
  DOT_HOLD_SEC,
  FLAT_TOL_MM,
  JOINTOL_MM,
  JUNCTION_FLOOR_PULL_IN,
  PLAN_DEFAULTS,
  SETTLE_AFTER_MM,
} from "./planner/tuning.js";

export {
  copyStrokes,
  crPoint,
  dedupeChain,
  densifyChain,
  filletChain,
  mergeStrokes,
  optimizePath,
  ptSegDist,
  refineCurves,
  turnAngleDeg,
  type GatedPath,
  type Stroke,
} from "./planner/path.js";

export {
  buildTimeline,
  gateTable,
  nextGate,
  planChainPen,
  planJob,
  resolvePlanOptions,
  sampleAt,
  type ChainMove,
  type HoldMove,
  type Move,
  type PlanOptions,
  type PlanPoint,
  type ResolvedPlanOptions,
  type Sample,
  type Timeline,
} from "./planner/plan.js";

export {
  simulate,
  tracedRuns,
  type SimOptions,
  type SimResult,
  type SimSample,
} from "./sim/sim.js";

export {
  emitSegments,
  type EmitOptions,
  type EmitResult,
  type EmittedSegment,
} from "./planner/emit.js";

export { crc8 } from "./protocol/crc8.js";
export { escapeFrame, isFrameOpener, isMagic, unescapeByte } from "./protocol/frame.js";
export {
  CAP_TOKENS,
  CRC_BYTES,
  ESCAPE_LOW,
  FLAG,
  FORMATS,
  HEADER_BYTES,
  HELLO,
  LINEAGE,
  MAGIC,
  PROBE,
  PROBE_MAX_RETRIES,
  PROBE_RETRY_MS,
  PROBE_TIMEOUT_MS,
  STEP_FMT,
  intervalToDurationMs,
  packetSize,
  parseStepCountByte,
  rateToInterval,
  stepCountByte,
  type WireCaps,
  type Domain,
  type PacketFormat,
  type SegmentField,
} from "./protocol/spec.js";

export {
  SERVO_PRESETS,
  WASHER_DEFAULTS,
  createWasherServo,
  servoResolution,
  type ServoPreset,
  type ServoResolution,
  type WasherConfig,
} from "./profiles/washer-servo.js";

export {
  DETENT_DEFAULTS,
  PULL_OUT_ASSUMED,
  PULL_OUT_DERATE,
  createDetent28byj,
  intervalFor,
  type DetentConfig,
} from "./profiles/detent-28byj.js";

import { createWasherServo } from "./profiles/washer-servo.js";
import { createDetent28byj } from "./profiles/detent-28byj.js";
import type { MachineProfile } from "./types.js";

/**
 * Every profile this build knows about, in the order they are tried.
 *
 * Selection happens from the hello line plus the config dump, never from a
 * dropdown, because a wrong profile aims a live beam through the wrong map. If
 * more than one profile claims a board, or none does, that is an ambiguity the
 * caller must surface rather than resolve: connect read only, show the raw hello
 * line, and ask.
 */
export const PROFILES: ReadonlyArray<() => MachineProfile> = [createWasherServo, createDetent28byj];

export type ProfileMatch =
  | { ok: true; profile: MachineProfile }
  | { ok: false; reason: "none" | "ambiguous"; candidates: string[] };

export function selectProfile(
  hello: string,
  config: Readonly<Record<string, string>> = {},
): ProfileMatch {
  const claims = PROFILES.map((f) => f()).filter((p) => p.matches(hello, config));
  if (claims.length === 1) return { ok: true, profile: claims[0]! };
  return {
    ok: false,
    reason: claims.length === 0 ? "none" : "ambiguous",
    candidates: claims.map((p) => p.id),
  };
}
