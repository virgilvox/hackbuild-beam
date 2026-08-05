/*
 * Board configuration: what came back, and what goes out.
 *
 * INV-59: the board is the source of truth. It is the thing bolted to the wall, so
 * on connect it is the authority on how it is installed, not whatever this browser
 * last had open. Connect pulls its stored setup and adopts it; pushing is always an
 * explicit act by the operator.
 *
 * The two lineages dump their setup differently. The pulse rig answers `CFG` with one
 * long key=value line. The step rig answers `Q` with four lines, qc1 through qc4,
 * because its homography does not fit alongside the rest and qc4 is the terminator
 * that says the dump is complete rather than truncated.
 *
 * INV-61: a pulse config push with all four corners runs close to 200 characters, and
 * the board's line buffer must be at least 300 for it to survive. The old 120 cap was
 * silently destroying exactly that line, which is why corner calibration never
 * seemed to stick on the board.
 */

import {
  DETENT_DEFAULTS,
  WASHER_DEFAULTS,
  type DetentConfig,
  type WasherConfig,
} from "@virgilvox/beam-core";
import { parseKv } from "./classify.js";

/** A captured corner on the pulse rig. Degrees of servo travel, not millimetres. */
export interface CornerAimDeg {
  panDeg: number;
  tiltDeg: number;
}

/** A captured corner on the step rig. Half steps, which is what the board stores. */
export interface CornerAimSteps {
  x: number;
  y: number;
}

export const WASHER_CORNER_KEYS = ["tl", "tr", "bl", "br"] as const;
export type WasherCornerKey = (typeof WASHER_CORNER_KEYS)[number];

export interface WasherBoardConfig {
  kind: "washer";
  minUs: number;
  maxUs: number;
  /** The origin the rig returns to, in pulse microseconds. Set by ZERO, stored in flash. */
  homePanUs: number;
  homeTiltUs: number;
  /** Laser gate polarity. */
  activeHigh: boolean;
  /** The board's own dead man window, milliseconds. */
  deadmanMs: number;
  wallW: number;
  wallH: number;
  distMm: number;
  mountH: number;
  slew: number;
  accel: number;
  deadband: number;
  servo: string;
  dither: boolean;
  leadPan: number;
  leadTilt: number;
  corners: Record<WasherCornerKey, CornerAimDeg | null>;
  cornerCount: number;
  /** INV-84: only ever true when at least one corner actually arrived. */
  calibrationOn: boolean;
}

export interface DetentBoardConfig {
  kind: "detent";
  /** Half steps per second. */
  rate: number;
  rateTravel: number;
  rampSteps: number;
  lashX: number;
  lashY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  limitsOn: boolean;
  invX: boolean;
  invY: boolean;
  throwMm: number;
  sepMm: number;
  fieldW: number;
  fieldH: number;
  /** Coils release after this many idle milliseconds. Zero holds them energised. */
  idleReleaseMs: number;
  /** Bit i set means corner i was captured. */
  cornerSet: number;
  corners: Array<CornerAimSteps | null>;
  /** Eight coefficients, or null when the board is running the ideal model. */
  homography: number[] | null;
  mapValid: boolean;
  /** True once qc4 arrived, which is the board saying the dump is complete. */
  complete: boolean;
}

export type BoardConfig = WasherBoardConfig | DetentBoardConfig;

const num = (kv: Readonly<Record<string, string>>, k: string, dflt: number): number => {
  const v = kv[k];
  if (v === undefined) return dflt;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
};

const flag = (kv: Readonly<Record<string, string>>, k: string, dflt: boolean): boolean => {
  const v = kv[k];
  if (v === undefined) return dflt;
  return v !== "0";
};

/* ------------------------------------------------------------------ washer -- */

/**
 * One `CFG ...` line into a plain object.
 *
 * Every field is optional on the wire: a board running older firmware simply does not
 * print the keys it does not have, and a truncated line loses its tail. So each key
 * falls back to the shipped default rather than to NaN, and the corner count is
 * reported so INV-84 can be enforced by the caller as well as here.
 */
export function parseWasherConfig(line: string): WasherBoardConfig | null {
  if (!/^CFG\b/.test(line)) return null;
  const kv = parseKv(line);

  const corners: Record<WasherCornerKey, CornerAimDeg | null> = {
    tl: null,
    tr: null,
    bl: null,
    br: null,
  };
  let cornerCount = 0;
  for (const key of WASHER_CORNER_KEYS) {
    const v = kv[key];
    if (v === undefined) continue;
    const comma = v.indexOf(",");
    if (comma <= 0) continue;
    const panDeg = Number.parseFloat(v.slice(0, comma));
    const tiltDeg = Number.parseFloat(v.slice(comma + 1));
    if (!Number.isFinite(panDeg) || !Number.isFinite(tiltDeg)) continue;
    corners[key] = { panDeg, tiltDeg };
    cornerCount++;
  }

  return {
    kind: "washer",
    minUs: num(kv, "min", WASHER_DEFAULTS.minUs),
    maxUs: num(kv, "max", WASHER_DEFAULTS.maxUs),
    homePanUs: num(kv, "hp", WASHER_DEFAULTS.homeA),
    homeTiltUs: num(kv, "ht", WASHER_DEFAULTS.homeB),
    activeHigh: flag(kv, "pol", true),
    deadmanMs: num(kv, "dm", 1500),
    wallW: num(kv, "ww", WASHER_DEFAULTS.wallW),
    wallH: num(kv, "wh", WASHER_DEFAULTS.wallH),
    distMm: num(kv, "ds", WASHER_DEFAULTS.distMm),
    mountH: num(kv, "mh", WASHER_DEFAULTS.mountH),
    slew: num(kv, "sl", 240),
    accel: num(kv, "ac", 1800),
    deadband: num(kv, "db", 8),
    servo: kv["sv"] ?? WASHER_DEFAULTS.servo,
    dither: flag(kv, "dit", false),
    leadPan: num(kv, "ffp", 0),
    leadTilt: num(kv, "fft", 0),
    corners,
    cornerCount,
    /*
     * INV-84: a stored "calibration on" flag is honoured only if at least one corner
     * actually arrived. A board that stores the flag and then loses its corners to a
     * truncated line would otherwise enable a calibration with nothing behind it,
     * which aims a live beam through an empty map.
     */
    calibrationOn: cornerCount > 0 && flag(kv, "cal", false),
  };
}

/**
 * The `CFG k=v ...` line that pushes a setup back.
 *
 * Only the keys present in the patch go out, because CFG is applied key by key and a
 * full rewrite would push defaults over fields this app never touched. Corners are
 * written as `tl=pan,tilt` with two decimals, exactly as the board prints them.
 */
export function washerConfigLine(patch: Partial<WasherBoardConfig>): string {
  const parts: string[] = [];
  const put = (k: string, v: number | string | undefined, digits?: number) => {
    if (v === undefined) return;
    parts.push(`${k}=${typeof v === "number" && digits !== undefined ? v.toFixed(digits) : v}`);
  };
  put("min", patch.minUs !== undefined ? Math.round(patch.minUs) : undefined);
  put("max", patch.maxUs !== undefined ? Math.round(patch.maxUs) : undefined);
  put("hp", patch.homePanUs !== undefined ? Math.round(patch.homePanUs) : undefined);
  put("ht", patch.homeTiltUs !== undefined ? Math.round(patch.homeTiltUs) : undefined);
  if (patch.activeHigh !== undefined) parts.push(`pol=${patch.activeHigh ? 1 : 0}`);
  put("dm", patch.deadmanMs !== undefined ? Math.round(patch.deadmanMs) : undefined);
  put("ww", patch.wallW, 1);
  put("wh", patch.wallH, 1);
  put("ds", patch.distMm, 1);
  put("mh", patch.mountH, 1);
  put("sl", patch.slew, 0);
  put("ac", patch.accel, 0);
  put("db", patch.deadband, 1);
  put("sv", patch.servo);
  if (patch.calibrationOn !== undefined) parts.push(`cal=${patch.calibrationOn ? 1 : 0}`);
  if (patch.dither !== undefined) parts.push(`dit=${patch.dither ? 1 : 0}`);
  put("ffp", patch.leadPan, 1);
  put("fft", patch.leadTilt, 1);
  if (patch.corners) {
    for (const key of WASHER_CORNER_KEYS) {
      const c = patch.corners[key];
      if (c) parts.push(`${key}=${c.panDeg.toFixed(2)},${c.tiltDeg.toFixed(2)}`);
    }
  }
  return `CFG ${parts.join(" ")}`;
}

/** The board's stored setup as machine profile parameters. */
export function washerProfileConfig(cfg: WasherBoardConfig): Partial<WasherConfig> {
  return {
    distMm: cfg.distMm,
    wallW: cfg.wallW,
    wallH: cfg.wallH,
    mountH: cfg.mountH,
    minUs: cfg.minUs,
    maxUs: cfg.maxUs,
    homeA: cfg.homePanUs,
    homeB: cfg.homeTiltUs,
    servo: cfg.servo,
    dither: cfg.dither,
  };
}

/* ------------------------------------------------------------------ detent -- */

/**
 * The qc1..qc4 dump into a plain object.
 *
 * qc3 only appears when the board holds a solved mapping, and qc4 is the terminator.
 * A dump without qc4 is a dump that was cut short, and `complete` says so rather than
 * letting a half read config be adopted as if it were the whole thing.
 */
export function parseDetentConfig(lines: readonly string[]): DetentBoardConfig | null {
  let saw1 = false;
  const cfg: DetentBoardConfig = {
    kind: "detent",
    rate: DETENT_DEFAULTS.rate,
    rateTravel: DETENT_DEFAULTS.rateTravel,
    rampSteps: 150,
    lashX: DETENT_DEFAULTS.lashA,
    lashY: DETENT_DEFAULTS.lashB,
    minX: DETENT_DEFAULTS.minA,
    maxX: DETENT_DEFAULTS.maxA,
    minY: DETENT_DEFAULTS.minB,
    maxY: DETENT_DEFAULTS.maxB,
    limitsOn: DETENT_DEFAULTS.limitsOn,
    invX: false,
    invY: false,
    throwMm: DETENT_DEFAULTS.throwMm,
    sepMm: DETENT_DEFAULTS.sepMm,
    fieldW: DETENT_DEFAULTS.fieldW,
    fieldH: DETENT_DEFAULTS.fieldH,
    idleReleaseMs: 4000,
    cornerSet: 0,
    corners: [null, null, null, null],
    homography: null,
    mapValid: false,
    complete: false,
  };

  for (const raw of lines) {
    const line = raw.trim();
    const kv = parseKv(line);
    if (line.startsWith("qc1")) {
      saw1 = true;
      cfg.rate = num(kv, "rate", cfg.rate);
      cfg.rateTravel = num(kv, "travel", cfg.rateTravel);
      cfg.rampSteps = num(kv, "ramp", cfg.rampSteps);
      cfg.lashX = num(kv, "lashx", cfg.lashX);
      cfg.lashY = num(kv, "lashy", cfg.lashY);
      cfg.minX = num(kv, "minx", cfg.minX);
      cfg.maxX = num(kv, "maxx", cfg.maxX);
      cfg.minY = num(kv, "miny", cfg.minY);
      cfg.maxY = num(kv, "maxy", cfg.maxY);
      cfg.limitsOn = flag(kv, "lon", cfg.limitsOn);
      cfg.invX = flag(kv, "invx", cfg.invX);
      cfg.invY = flag(kv, "invy", cfg.invY);
      cfg.throwMm = num(kv, "throw", cfg.throwMm);
      cfg.sepMm = num(kv, "sep", cfg.sepMm);
      cfg.fieldW = num(kv, "fw", cfg.fieldW);
      cfg.fieldH = num(kv, "fh", cfg.fieldH);
      cfg.idleReleaseMs = num(kv, "idle", cfg.idleReleaseMs);
    } else if (line.startsWith("qc2")) {
      cfg.cornerSet = num(kv, "cs", 0);
      cfg.mapValid = flag(kv, "map", false);
      for (let i = 0; i < 4; i++) {
        /* The bitmask is the authority on which corners exist. The board prints 0,0
         * for a corner it never captured, and 0,0 is a legal aim. */
        if (!((cfg.cornerSet >> i) & 1)) {
          cfg.corners[i] = null;
          continue;
        }
        const v = kv[`c${i}`] ?? "0,0";
        const comma = v.indexOf(",");
        const x = Number.parseFloat(comma > 0 ? v.slice(0, comma) : v);
        const y = Number.parseFloat(comma > 0 ? v.slice(comma + 1) : "0");
        cfg.corners[i] = { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
      }
    } else if (line.startsWith("qc3")) {
      const h = (kv["h"] ?? "").split(",").map((s) => Number.parseFloat(s));
      if (h.length === 8 && h.every((v) => Number.isFinite(v))) cfg.homography = h;
    } else if (line.startsWith("qc4")) {
      cfg.complete = true;
    }
  }

  if (!saw1) return null;
  /* A mapping the board says is valid but did not send is not a mapping this host
   * can reason about. Say so rather than quietly running the ideal model while the
   * board runs a measured one. */
  if (cfg.mapValid && !cfg.homography) cfg.mapValid = false;
  return cfg;
}

/**
 * The command sequence that pushes a setup back, ported from the shipped tool.
 *
 * Order matters in one place: `U` turns limits on and must come after `N` has set
 * them, or the board enforces the previous window for as long as it takes the next
 * line to arrive.
 */
export function detentConfigLines(cfg: Partial<DetentBoardConfig>): string[] {
  const out: string[] = [];
  if (
    cfg.throwMm !== undefined &&
    cfg.sepMm !== undefined &&
    cfg.fieldW !== undefined &&
    cfg.fieldH !== undefined
  ) {
    out.push(`G ${cfg.throwMm} ${cfg.sepMm} ${cfg.fieldW} ${cfg.fieldH}`);
  }
  if (cfg.rate !== undefined && cfg.rateTravel !== undefined) {
    out.push(`R ${Math.round(cfg.rate)} ${Math.round(cfg.rateTravel)} ${Math.round(cfg.rampSteps ?? 150)}`);
  }
  if (cfg.idleReleaseMs !== undefined) out.push(`D ${Math.round(cfg.idleReleaseMs)}`);
  if (cfg.lashX !== undefined && cfg.lashY !== undefined) {
    out.push(`B ${Math.round(cfg.lashX)} ${Math.round(cfg.lashY)}`);
  }
  if (cfg.invX !== undefined && cfg.invY !== undefined) {
    out.push(`I ${cfg.invX ? 1 : 0} ${cfg.invY ? 1 : 0}`);
  }
  if (
    cfg.minX !== undefined &&
    cfg.maxX !== undefined &&
    cfg.minY !== undefined &&
    cfg.maxY !== undefined
  ) {
    out.push(`N ${Math.round(cfg.minX)} ${Math.round(cfg.maxX)} ${Math.round(cfg.minY)} ${Math.round(cfg.maxY)}`);
  }
  if (cfg.limitsOn !== undefined) out.push(`U ${cfg.limitsOn ? 1 : 0}`);
  if (cfg.homography && cfg.homography.length === 8) {
    out.push(`Y ${cfg.homography.map((v) => v.toPrecision(9)).join(" ")}`);
  }
  return out;
}

/** The board's stored setup as machine profile parameters. */
export function detentProfileConfig(cfg: DetentBoardConfig): Partial<DetentConfig> {
  return {
    throwMm: cfg.throwMm,
    sepMm: cfg.sepMm,
    fieldW: cfg.fieldW,
    fieldH: cfg.fieldH,
    rate: cfg.rate,
    rateTravel: cfg.rateTravel,
    minA: cfg.minX,
    maxA: cfg.maxX,
    minB: cfg.minY,
    maxB: cfg.maxY,
    limitsOn: cfg.limitsOn,
    lashA: cfg.lashX,
    lashB: cfg.lashY,
  };
}
