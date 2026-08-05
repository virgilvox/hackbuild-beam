<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { MIN_THROW_MM, mmToAngles } from "@virgilvox/beam-core";
import type { AxisPair, Calibration, MachineProfile, Point } from "@virgilvox/beam-core";
import { DETENT_MESH, type DetentMeshName } from "./detent-meshes.js";
import {
  beamPath as detentBeamPath,
  benchY as detentBenchY,
  bodyExtent as detentBodyExtent,
  placeDetent,
} from "./detent-assembly.js";
import { decodeMesh, decodeQuantised, mat34, unitCylinder, type Mesh } from "./mesh.js";
import {
  headFrame,
  MOUNT,
  muzzleOf,
  PIVOT_OFF_MM,
  STAND_HEIGHT_MM,
  placeGalvoBody,
  placeGalvoBrack,
  placeServoBase,
  type HeadFrame,
  type Placement,
} from "./rig-assembly.js";
import { beginFrame, drawGl, initGl, type GlView } from "./mesh-gl.js";

/**
 * The rig itself, seen from off to one side, with the live beam on it.
 *
 * Ported from detent-plot.html drawRig and generalised to both machines, because
 * this app drives both. There is no three.js here and there does not need to be:
 * the stepper tool proved that a hand rolled projection of about thirty quads
 * reads as a physical rig, and the offline single file budget cannot carry a
 * scene graph anyway.
 *
 * Two geometries, picked from the profile and never from a setting:
 *
 *   beamAnglePerAxisAngle 2   two mirrors. An X mirror, sepMm of travel to a Y
 *                             mirror, then the reach to the target plane. A mirror
 *                             deflects the beam by TWICE its own rotation, so the
 *                             quads sit at PI/4 plus half the beam angle.
 *   beamAnglePerAxisAngle 1   a pan/tilt head. One yoke that yaws, one barrel that
 *                             tilts on top of it, one pivot. The servo angle IS the
 *                             beam angle here.
 */
const props = defineProps<{
  profile: MachineProfile | null;
  /** Live position in axis units, as last reported by the board. */
  live: AxisPair;
  beamOn: boolean;
  /** What the machine will really do, after quantisation and the error model. */
  simulated: { x: number; y: number; on: boolean }[];
  fieldW: number;
  fieldH: number;
  /**
   * The active four corner map, if one is solved.
   *
   * Not optional in spirit. laser-rig.html shipped a version where the aiming used
   * the calibration and the rig view did not, so the moment four corners were
   * captured the picture was drawn through a different mapping than the beam was
   * being sent through. Pass what the aiming passes.
   */
  cal?: Calibration | null;
}>();

const cv = ref<HTMLCanvasElement | null>(null);
/*
 * The solids live on their own canvas, underneath.
 *
 * They need a depth buffer and everything else on this view does not: the beam,
 * the target plane, the trace and every label are lines and text that belong in
 * front of the rig anyway. Two stacked surfaces keeps each one doing what it is
 * good at, and the overlay stays transparent so the GL clear is the background.
 */
const glCv = ref<HTMLCanvasElement | null>(null);
const wrap = ref<HTMLDivElement | null>(null);
let ro: ResizeObserver | null = null;
let view: GlView | null = null;
/** Camera rotation for the shader, rebuilt each frame. Column major for WebGL. */
const glRot = new Float32Array(9);
const glBasis = new Float32Array(9);

/* ------------------------------------------------------------------ colours */

/*
 * Canvas cannot read a CSS custom property, so the tokens are spelled out. These
 * are the same values theme/tokens.css carries and they came from the two shipped
 * tools: ink surface, one pink accent, everything else a wash of paper at low
 * alpha.
 */
const INK = "#1a1a1a";
const INK_2 = "#0a0a0a";
const PINK = "#FE0386";
const RULE = "rgba(245,240,230,.20)";
const FAINT = "rgba(245,240,230,.09)";
const DIM = "#5e574f";
/* An unlit beam is still a beam. Dark grey keeps the geometry legible without
 * competing with the one solid colour in the system. */
const BEAM_OFF = "#3a3630";
const UIFONT = "13px 'VT323', ui-monospace, monospace";

/* ---------------------------------------------------------------- model size */

/*
 * The rig is drawn at a fixed readable size and only the RATIOS that carry meaning
 * are scaled. A 28BYJ mirror is 13 model units across whether the throw is 150 mm
 * or 600 mm, exactly as drawRig had it, because the point of this view is the
 * angles and not the parts catalogue.
 */
const MIRROR_R = 13;
/** Model units from the last pivot to the target plane, at a comfortable throw. */
const REACH_MAX = 132;
/**
 * How tall the target plane is allowed to get, in model units.
 *
 * The scale is forced by angle honesty: model units per millimetre is reach over
 * throw, so a field that is wide compared to its throw draws a genuinely huge
 * plane and squashes the rig into nothing. Rather than capping the plane and
 * lying about where the beam lands on it, shorten the reach until the plane fits.
 * Every angle stays true and the whole picture just gets more compact.
 */
const PLANE_CAP = 96;
/** A separation this small is unreadable, so it is floored rather than drawn true. */
const SEP_MIN = 8;
/** Half length of the pan/tilt barrel, muzzle to pivot. */
const BARREL_HALF = 17;
const BARREL_R = 5;

/*
 * The MOUNT table, the part placements and the constant that says how far the
 * tilt axis sits from the pan axis all live in rig-assembly.ts, where they are
 * pinned to landmarks by rig-assembly.test.ts. Nothing about where a part goes is
 * decided in this file.
 */
const PLATE_FACE_MM = MOUNT.plateFaceX;

/* ------------------------------------------------------------------- camera */

/*
 * The camera breathes until somebody takes hold of it.
 *
 * Yaw oscillates about 0.66 rad by plus or minus 0.20 at roughly a 21 second
 * period. It is the cheapest thing in this file and it is the reason a static
 * three quarter view reads as a live instrument instead of a diagram.
 *
 * The original counted animation frames and multiplied by 0.005, which is 0.3
 * rad/s only if the display happens to run at 60 Hz. Wall time is used here so a
 * 120 Hz panel breathes at the same rate rather than twice as fast.
 *
 * The moment the view is dragged the breathing stops for good, because a camera
 * that drifts away from where it was just put is not a camera, it is a fight.
 * Double click puts it back and starts it breathing again.
 */
const CAM_YAW = 0.66;
const CAM_SWING = 0.2;
const CAM_RATE = 0.3;
const CAM_PITCH = -0.3;
const CAM_DIST = 620;

/** Radians per pixel of drag. laser-rig's figure, and it feels right. */
const ORBIT_RATE = 0.0052;
/*
 * Pitch stops short of straight down and of the horizon.
 *
 * Level with the bench the whole rig collapses into a line, and past vertical
 * the scene turns over. Neither is a view of anything, so they are not reachable.
 */
const PITCH_MIN = -1.35;
const PITCH_MAX = 0.35;
const ZOOM_MIN = 0.45;
const ZOOM_MAX = 4;

const orbit = { yaw: CAM_YAW, pitch: CAM_PITCH, zoom: 1 };
/** Set by the first drag or wheel. Freezes the breath and the reset hint. */
const touched = ref(false);
const dragging = ref(false);

/* ------------------------------------------------------------------- meshes */

/*
 * The parts, once they have inflated.
 *
 * Held as plain module state and not as a ref, because nothing in the template
 * depends on them and making them reactive would hand Vue a Float32Array of ten
 * thousand floats to walk. `meshesReady` is the one bit of it the UI cares about.
 */
const meshes: { servoBase: Mesh | null; galvoBody: Mesh | null; galvoBrack: Mesh | null } = {
  servoBase: null,
  galvoBody: null,
  galvoBrack: null,
};
/* The two mirror rig's mechanism. Loaded separately and on demand: a session that
 * only ever drives one machine should not inflate the other one's parts. */
const dm: Record<DetentMeshName, Mesh | null> = {
  chassis: null,
  motor: null,
  hub: null,
  mirror: null,
  laser: null,
};
const meshesReady = ref(false);
const detentReady = ref(false);
const meshError = ref("");

/* Rebuilt every frame. Allocating a matrix per frame is how a renderer turns into
 * a garbage collector. */
const camMat = mat34();
/* The head's laser module. Not an STL, so it is generated once. */
const moduleMesh = unitCylinder();

/*
 * The materials, as the two endpoints of each one's shading ramp.
 *
 * The shader interpolates between them per pixel, so a material is two colours
 * rather than a set of quantised steps. All four are struck between ink and paper
 * instead of toward white, so the rig belongs to the same surface as the rest of
 * the canvas rather than glowing out of it.
 */
type Rgb = [number, number, number];
const MAT = {
  /** Printed PLA: warm, matte, and never brighter than the paper token. */
  printed: [[21, 20, 18], [198, 189, 172]] as [Rgb, Rgb],
  /** The bracket, and the stepper cans. Cooler, so the metal reads apart. */
  steel: [[26, 28, 31], [176, 180, 186]] as [Rgb, Rgb],
  /** The laser module's anodised barrel, warm the way the original drew it. */
  brass: [[32, 25, 12], [196, 158, 82]] as [Rgb, Rgb],
  /**
   * A front surface mirror.
   *
   * The only part on either rig allowed near the beam's own colour. It is the
   * surface the whole machine exists to point, and at this size it is a 20 mm
   * disc that would otherwise disappear into the hub carrying it.
   */
  mirror: [[30, 46, 44], [150, 236, 218]] as [Rgb, Rgb],
} as const;
const unit8 = (c: Rgb): Rgb => [c[0] / 255, c[1] / 255, c[2] / 255];

/**
 * Light direction in camera space.
 *
 * Camera z runs away from the viewer, so the negative z term is what puts the
 * light behind the shoulder. Up and slightly left of it is the convention every
 * CAD viewer uses and the reason a part reads as convex rather than as a hole.
 */
const LIGHT: readonly [number, number, number] = (() => {
  const v = [-0.42, 0.62, -0.66];
  const n = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / n, v[1]! / n, v[2]! / n] as const;
})();

let raf = 0;
let phase = 0;
let started = 0;

/**
 * Someone who has asked the system for less motion does not want a wall of
 * instrument panels swaying. Holding the phase at zero parks the camera at the
 * centre of its swing, which is a view the animation passes through anyway, and
 * the frame loop is then never started at all.
 */
function wantsStillness(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/* -------------------------------------------------------------- model space */

/**
 * Rig space: +X runs down the beam axis toward the target, +Y is up, +Z is
 * lateral. Target millimetres map in as y = y + vOff and z = -x.
 *
 * The negation is not cosmetic. The camera sits off to one side and yaws by a
 * positive angle, which puts +Z on the left of the frame, so mapping target x
 * straight onto z draws the whole rig view mirrored against the target view: a
 * stroke on the right of one is on the left of the other. drawRig did exactly
 * that, and got away with it because its rig view had nothing in it to compare
 * against. Here the two canvases sit side by side.
 */
type V3 = [number, number, number];

/** Target millimetres to the lateral model axis. */
function lateral(xMm: number, scale: number): number {
  return -xMm * scale;
}

interface Layout {
  kind: "mirrors" | "head";
  throwMm: number;
  vOffMm: number;
  /** Model units per millimetre. Fixed by reach over throw so the angles are true. */
  scale: number;
  reach: number;
  sep: number;
  /** Mirror separation in millimetres, which is what places the real parts. */
  sepMm: number;
  /** Distance from the first pivot to the target plane. */
  planeX: number;
  halfY: number;
  halfZ: number;
  /** Height of the target centre above the head, in model units. */
  centreY: number;
  /** How far the rig extends behind the first pivot. */
  backLen: number;
  boreModel: number;
  plateModel: number;
  /**
   * The bench line, in model units.
   *
   * A schematic can put its bench wherever it reads best. Real parts cannot: the
   * base sits on the table and the tilt axis is MOUNT.tiltY above it, and this
   * view has already committed to the tilt axis being model y = 0. So on the head
   * the bench is not a styling constant, it is where the table actually is.
   */
  benchY: number;
  /** Half the lateral extent of the physical rig, for framing. Zero on a schematic. */
  bodyHalfZ: number;
  /** How far the physical rig reaches above the tilt axis. */
  bodyTopY: number;
}

function buildLayout(p: MachineProfile): Layout {
  const g = p.geometry;
  const throwMm = Math.max(g.throwMm, MIN_THROW_MM);
  const kind: Layout["kind"] = p.beamAnglePerAxisAngle >= 2 ? "mirrors" : "head";

  /* Half the tallest thing the plane has to show, including the vertical offset
   * that lifts the target centre above a floor standing head. */
  const halfMm = Math.max(props.fieldW, props.fieldH) / 2 + Math.abs(g.vOffMm);
  const reach = halfMm > 1e-6 ? Math.min(REACH_MAX, (PLANE_CAP * throwMm) / halfMm) : REACH_MAX;
  const scale = reach / throwMm;

  /*
   * On the mirrors rig this is a VERTICAL separation, not a run along the optical
   * axis. The model origin is the upper mirror, which is where the beam leaves,
   * so the lower mirror sits one separation below it and the target is a straight
   * reach forward from the origin.
   */
  const sep = kind === "mirrors" ? Math.max(SEP_MIN, g.sepMm * scale) : 0;
  /* What the camera has to fit. On the mirrors rig that is the printed body, which
   * dwarfs the mechanism bolted to it. */
  const body = detentBodyExtent(g.sepMm);

  return {
    kind,
    throwMm: g.throwMm,
    vOffMm: g.vOffMm,
    scale,
    reach,
    sep,
    sepMm: g.sepMm,
    planeX: reach,
    halfY: (props.fieldH / 2) * scale,
    halfZ: (props.fieldW / 2) * scale,
    centreY: g.vOffMm * scale,
    /*
     * The servo base reaches 28.15 mm behind the pan axis, which at any real
     * scale is further back than the schematic barrel ever went. Framing to the
     * blocks and then drawing the meshes would clip the base off the back of the
     * panel, so the head measures its own hardware.
     */
    /* The two mirror rig reaches sideways for its source rather than backwards,
     * so almost nothing of it is behind the exit mirror. */
    backLen: kind === "mirrors" ? body.back * scale : 30 * scale,
    boreModel: PIVOT_OFF_MM * scale,
    plateModel: PLATE_FACE_MM * scale,
    benchY: kind === "mirrors" ? detentBenchY(scale, g.sepMm) : -STAND_HEIGHT_MM * scale,
    /* Half the base's 51 mm width, which is the widest thing on the head. */
    /* The module's tail is the widest thing on the mirrors rig, out at 48 mm. */
    bodyHalfZ: kind === "mirrors" ? body.halfZ * scale : 25.5 * scale,
    /* Top of the galvobody: its own 51 mm above the pan horn at 20.2. */
    bodyTopY: kind === "mirrors" ? body.top * scale : (51 - MOUNT.tiltY) * scale,
  };
}

/*
 * Two caches, and neither of them is a bitmap.
 *
 * TargetCanvas blits a cached static layer because its slow half never moves. Here
 * the camera moves every single frame, so a pixel cache would miss every single
 * frame and the offscreen canvas would be pure overhead. What IS cacheable is
 * everything upstream of the camera: the layout, and the decimation of the
 * simulated path down to a few hundred model space points. That is the O(n) work,
 * a plot can carry fifty thousand samples, and it is done once per replan instead
 * of sixty times a second.
 *
 * Keyed by identity exactly as TargetCanvas is, and for the same reason: the
 * arrays are replaced wholesale on replan rather than mutated, so a reference test
 * is both correct and free. Serialising them, or deep watching them, is what made
 * the preview crawl once already.
 */
let layout: Layout | null = null;
let layoutKey: { profile: unknown; fieldW: number; fieldH: number } | null = null;

function layoutFor(p: MachineProfile): Layout {
  if (
    !layout ||
    !layoutKey ||
    layoutKey.profile !== p ||
    layoutKey.fieldW !== props.fieldW ||
    layoutKey.fieldH !== props.fieldH
  ) {
    layout = buildLayout(p);
    layoutKey = { profile: p, fieldW: props.fieldW, fieldH: props.fieldH };
  }
  return layout;
}

/**
 * At most this many points of the simulated path are drawn on the plane.
 *
 * A raster fills the sim buffer with tens of thousands of samples and none of the
 * detail past a few hundred survives the projection anyway. drawRig used the same
 * budget.
 */
const TRACE_MAX = 420;

interface Trace {
  /** Flat triples in model space. */
  pts: Float64Array;
  lit: Uint8Array;
  n: number;
}
let trace: Trace | null = null;
let traceKey: { sim: unknown; layout: unknown } | null = null;

function traceFor(L: Layout): Trace {
  const sim = props.simulated;
  if (trace && traceKey && traceKey.sim === sim && traceKey.layout === L) return trace;

  const stride = Math.max(1, Math.floor(sim.length / TRACE_MAX));
  const n = sim.length === 0 ? 0 : Math.ceil(sim.length / stride);
  const pts = new Float64Array(n * 3);
  const lit = new Uint8Array(n);
  let w = 0;
  for (let i = 0; i < sim.length; i += stride) {
    const s = sim[i]!;
    pts[w * 3] = L.planeX;
    pts[w * 3 + 1] = (s.y + L.vOffMm) * L.scale;
    pts[w * 3 + 2] = lateral(s.x, L.scale);
    lit[w] = s.on ? 1 : 0;
    w += 1;
  }
  trace = { pts, lit, n: w };
  traceKey = { sim, layout: L };
  return trace;
}

/* ---------------------------------------------------------------- kinematics */

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < lo ? lo : v > hi ? hi : v;
}

interface Aim {
  /** Where the beam lands, in model space. */
  hit: V3;
  /** Beam angles in radians: first axis then second. */
  t1: number;
  t2: number;
}

/**
 * Where the beam actually goes, and therefore where the joints must be pointing.
 *
 * The rig is posed FROM the hit point rather than from the raw axis units. That is
 * the expensive lesson in laser-rig.html: an axis value only becomes a direction
 * after the home reference and the vertical mount offset are applied, and under a
 * four corner map it never becomes one at all, because the angles relate to the
 * target through the measured quad and not through any ideal model. Posing from
 * the raw angle left the drawn rig aimed 28 degrees off the beam it was drawing.
 */
function aimOf(L: Layout, p: MachineProfile): Aim {
  const at: Point = p.forward(props.live, props.cal ?? null);
  /* A wild aim past the field is legitimate, an infinity is not: the tangents blow
   * up near a quarter turn. Clamp wide enough that clipping is still visible. */
  const x = clamp(at.x, -props.fieldW, props.fieldW);
  const y = clamp(at.y, -props.fieldH, props.fieldH);
  const ang = mmToAngles({ x, y }, p.geometry);
  return {
    hit: [L.planeX, (y + L.vOffMm) * L.scale, lateral(x, L.scale)],
    t1: ang.t1,
    t2: ang.t2,
  };
}

/**
 * Yaw and tilt for a pan/tilt head whose tilt axis does not sit on its pan axis.
 *
 * The laser hangs off to one side by the bracket bore offset, so the pivot swings
 * as the yoke turns and the yaw that aims the head is not the yaw to the target.
 * Solve for the yaw that aims the OFFSET pivot at the target instead. Three fixed
 * point passes is well past convergence for a lever arm worth about a degree.
 */
function poseHead(L: Layout, hit: V3): { yaw: number; tilt: number; pivot: V3 } {
  let yaw = Math.atan2(hit[2], hit[0]);
  let dx = hit[0];
  let dz = hit[2];
  let px = 0;
  let pz = 0;
  for (let i = 0; i < 3; i++) {
    /* The offset is measured to the right of the beam, which is where the bracket
     * hangs, so it rides on the perpendicular and not on the forward axis. */
    px = -L.boreModel * Math.sin(yaw);
    pz = L.boreModel * Math.cos(yaw);
    dx = hit[0] - px;
    dz = hit[2] - pz;
    yaw = Math.atan2(dz, dx);
  }
  return { yaw, tilt: Math.atan2(hit[1], Math.hypot(dx, dz)), pivot: [px, 0, pz] };
}

/* --------------------------------------------------------------------- fit */

/* Room for the labels, which are drawn centred on a model point and therefore
 * hang outside whatever the fit measured, and for the two readout lines. */
const PAD_X = 34;
const PAD_TOP = 20;
const PAD_BOT = 34;

/**
 * The points the frame has to contain: the target plane, the extent of the rig,
 * and the tallest label anchor on it.
 *
 * The rig corner points are taken from the layout rather than from the drawing
 * constants, so on the head they describe the actual bounding box of the three
 * printed parts. Framing to a schematic and then drawing hardware is how the
 * base ends up hanging off the back edge of the panel.
 */
function fitPoints(L: Layout): V3[] {
  const top = L.centreY + L.halfY + 8;
  const bot = L.centreY - L.halfY;
  const back = -L.backLen;
  return [
    [L.planeX, top, -L.halfZ],
    [L.planeX, top, L.halfZ],
    [L.planeX, bot, -L.halfZ],
    [L.planeX, bot, L.halfZ],
    [back, MIRROR_R * 1.4, 0],
    [back, L.benchY, -L.bodyHalfZ],
    [back, L.benchY, L.bodyHalfZ],
    [0, L.bodyTopY + 10, L.bodyHalfZ],
    [0, L.bodyTopY + 10, -L.bodyHalfZ],
    [L.sep, L.benchY, L.bodyHalfZ],
    [L.sep, L.benchY, -L.bodyHalfZ],
  ];
}

/**
 * Projected extent of those points, in units of one model unit at unit scale.
 *
 * The perspective divide depends only on camera depth, never on the fit, so the
 * projection can be evaluated before the scale is known and then scaled once.
 */
function fitBox(L: Layout): { cx: number; cy: number; w: number; h: number } {
  const pts = fitPoints(L);
  const cp = Math.cos(orbit.pitch);
  const sp = Math.sin(orbit.pitch);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  /*
   * Measured across the whole breath while it is breathing, so the fit is
   * constant as the camera swings: a fit recomputed at the live yaw would pulse
   * the zoom in time with the oscillation and read as a wobble rather than as a
   * camera move. Once the view is under the pointer there is no swing to
   * anticipate, and framing to the angle actually being looked at is what keeps
   * the rig filling the panel at every orbit position.
   */
  const swing = touched.value ? 0 : CAM_SWING;
  for (const yaw of [orbit.yaw - swing, orbit.yaw, orbit.yaw + swing]) {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    for (const q of pts) {
      const x = q[0] * cy - q[2] * sy;
      const z0 = q[0] * sy + q[2] * cy;
      const y = q[1] * cp - z0 * sp;
      const z = q[1] * sp + z0 * cp;
      const k = CAM_DIST / (CAM_DIST + z * 0.9);
      const ux = x * k;
      const uy = y * k;
      if (ux < minX) minX = ux;
      if (ux > maxX) maxX = ux;
      if (uy < minY) minY = uy;
      if (uy > maxY) maxY = uy;
    }
  }
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}

/* -------------------------------------------------------------------- paint */

function paint() {
  const c = cv.value;
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (w === 0 || h === 0) return;
  if (c.width !== Math.round(w * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  /* The GL layer underneath owns the background when it is up, so the overlay
   * must be cleared to nothing rather than filled, or it hides the rig. */
  ctx.clearRect(0, 0, w, h);
  if (!view) {
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.font = UIFONT;
  ctx.textBaseline = "alphabetic";

  const p = props.profile;
  if (!p) {
    ctx.fillStyle = DIM;
    ctx.fillText("no machine", 12, h - 12);
    return;
  }

  const L = layoutFor(p);

  /*
   * Fit by measuring, not by the original's hand tuned span constants.
   *
   * drawRig could divide the width by 1.14 times a span it knew, because it drew
   * exactly one rig at one throw. Here the geometry comes from whichever board
   * answered and the field is set by the operator, so the picture is framed from
   * the projected extent of the thing being drawn.
   *
   * The fit frames the rig; the wheel then scales that framing. Zooming by
   * multiplying the fitted scale rather than by moving the camera in keeps the
   * weak perspective constant, so a zoom does not also quietly change how much
   * the picture converges.
   */
  const box = fitBox(L);
  const fit = Math.min((w - PAD_X * 2) / box.w, (h - PAD_TOP - PAD_BOT) / box.h);
  const sc = fit * orbit.zoom;
  const ox = PAD_X + (w - PAD_X * 2) / 2 - box.cx * sc;
  const oy = PAD_TOP + (h - PAD_TOP - PAD_BOT) / 2 + box.cy * sc;

  const yaw = orbit.yaw + (touched.value ? 0 : Math.sin(phase) * CAM_SWING);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(orbit.pitch);
  const sp = Math.sin(orbit.pitch);

  /** Camera space, kept separate from the projection so faces can be depth sorted. */
  const V = (q: V3): V3 => {
    const x = q[0] * cy - q[2] * sy;
    const z0 = q[0] * sy + q[2] * cy;
    const y = q[1] * cp - z0 * sp;
    const z = q[1] * sp + z0 * cp;
    return [x, y, z];
  };
  const P = (q: V3): [number, number] => {
    const v = V(q);
    /* Weak perspective. 0.9 on the depth term is the original's: enough parallax to
     * read as depth, not enough to bend a straight optical bench. */
    const k = CAM_DIST / (CAM_DIST + v[2] * 0.9);
    return [ox + v[0] * k * sc, oy - v[1] * k * sc];
  };

  /*
   * The same rotation V applies, written out as a matrix so the mesh renderer can
   * fold it into each part's transform and spend one matrix per vertex instead of
   * two. Derived from V by expanding it, not by re-deriving it: if these two ever
   * disagree the meshes drift away from the beam line drawn through V, which is
   * the exact bug laser-rig.html shipped when its rig view and its aiming used
   * different mappings.
   */
  camMat[0] = cy;
  camMat[1] = 0;
  camMat[2] = -sy;
  camMat[3] = 0;
  camMat[4] = -sy * sp;
  camMat[5] = cp;
  camMat[6] = -cy * sp;
  camMat[7] = 0;
  camMat[8] = sy * cp;
  camMat[9] = sp;
  camMat[10] = cy * cp;
  camMat[11] = 0;

  /*
   * The same rotation, as a 3x3 for the shader. WebGL takes column major, and the
   * rows of camMat are the camera's own axes, so writing rows down columns is the
   * transpose GL is asking for.
   */
  glRot[0] = camMat[0]!;
  glRot[1] = camMat[4]!;
  glRot[2] = camMat[8]!;
  glRot[3] = camMat[1]!;
  glRot[4] = camMat[5]!;
  glRot[5] = camMat[9]!;
  glRot[6] = camMat[2]!;
  glRot[7] = camMat[6]!;
  glRot[8] = camMat[10]!;
  if (view) {
    beginFrame(
      view,
      { rot: glRot, ox, oy, sc, dist: CAM_DIST, w, h, clear: [0.102, 0.102, 0.102], light: LIGHT },
      dpr,
    );
  }



  const line = (a: V3, b: V3, col: string, wd = 1, dash: number[] = []) => {
    const A = P(a);
    const B = P(b);
    ctx.strokeStyle = col;
    ctx.lineWidth = wd;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(A[0], A[1]);
    ctx.lineTo(B[0], B[1]);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const quad = (pts: V3[], fill: string | null, stroke: string | null) => {
    ctx.beginPath();
    pts.forEach((q, i) => {
      const s = P(q);
      if (i) ctx.lineTo(s[0], s[1]);
      else ctx.moveTo(s[0], s[1]);
    });
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  };
  const tag = (q: V3, txt: string, col = DIM) => {
    const s = P(q);
    ctx.fillStyle = col;
    ctx.fillText(txt, s[0] - ctx.measureText(txt).width / 2, s[1]);
  };

  /*
   * A box, drawn back to front by face depth.
   *
   * There is no z buffer and there does not need to be one: six faces of one
   * convex box sort exactly by their centre depth, and the head is the only thing
   * in this view with volume.
   */
  const FACES: number[][] = [
    [0, 2, 6, 4],
    [1, 3, 7, 5],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [0, 1, 3, 2],
    [4, 5, 7, 6],
  ];
  const prism = (c0: V3, ex: V3, ey: V3, ez: V3, fill: string, stroke: string) => {
    const corner: V3[] = [];
    for (let i = 0; i < 8; i++) {
      const a = i & 1 ? 1 : -1;
      const b = i & 2 ? 1 : -1;
      const d = i & 4 ? 1 : -1;
      corner.push([
        c0[0] + ex[0] * a + ey[0] * b + ez[0] * d,
        c0[1] + ex[1] * a + ey[1] * b + ez[1] * d,
        c0[2] + ex[2] * a + ey[2] * b + ez[2] * d,
      ]);
    }
    const depth = corner.map((q) => V(q)[2]);
    const order = FACES.map((f, i) => ({
      i,
      z: (depth[f[0]!]! + depth[f[1]!]! + depth[f[2]!]! + depth[f[3]!]!) / 4,
    }));
    /* Larger camera z is farther away, so it is painted first. */
    order.sort((a, b) => b.z - a.z);
    for (const o of order) {
      const f = FACES[o.i]!;
      quad([corner[f[0]!]!, corner[f[1]!]!, corner[f[2]!]!, corner[f[3]!]!], fill, stroke);
    }
  };

  const aim = aimOf(L, p);
  const lit = props.beamOn;
  const beamCol = lit ? PINK : BEAM_OFF;

  /* Optical bench reference. Everything the rig stands on hangs off this line. */
  line([-L.backLen, L.benchY, 0], [L.planeX, L.benchY, 0], FAINT, 1);

  /* The target plane, drawn before the rig so the rig sits in front of it. */
  const planeTop = L.centreY + L.halfY;
  const planeBot = L.centreY - L.halfY;
  quad(
    [
      [L.planeX, planeBot, -L.halfZ],
      [L.planeX, planeBot, L.halfZ],
      [L.planeX, planeTop, L.halfZ],
      [L.planeX, planeTop, -L.halfZ],
    ],
    null,
    FAINT,
  );
  line([L.planeX, L.centreY, -L.halfZ], [L.planeX, L.centreY, L.halfZ], FAINT, 1);
  line([L.planeX, planeBot, 0], [L.planeX, planeTop, 0], FAINT, 1);

  if (L.kind === "mirrors") {
    const mech = p.beamAnglePerAxisAngle || 2;
    /*
     * Mechanical radians, not beam radians. A mirror deflects the beam by twice
     * its own rotation, so handing the beam angle straight to the parts would
     * swing them through double what the metal does.
     */
    const t1 = -aim.t1 / mech;
    const t2 = aim.t2 / mech;
    const path = detentBeamPath(L.scale, p.geometry.sepMm);

    if (detentReady.value && view) {
      drawDetentMeshes(t1, t2, L);
    } else {
      drawMirrorBlocks(L, t1, t2, { line, quad, tag });
    }

    /*
     * The folded path, in the order the light actually travels it: across the rig
     * from the module to the lower mirror, up through the separation to the upper
     * mirror, and only then out to the wall. The old drawing ran all three legs
     * along the optical axis, which reads cleanly and is not this machine.
     */
    line(path.lens, path.lower, beamCol, 1.5);
    line(path.lower, path.upper, beamCol, 1.5);
    line(path.upper, aim.hit, beamCol, 1.5);

    /*
     * Labels off to the side with leaders. The two mirrors are one separation
     * apart and that separation is a fraction of the throw, so their anchors sit
     * nearly on top of each other on screen and two centred labels collide at
     * every camera angle. Only a lateral split survives the yaw, and once a label
     * is no longer over the thing it names it needs a line back to it.
     */
    /*
     * Labels outside the body, with leaders back to what they name.
     *
     * The lateral offset has to clear the printed body, which is 49 mm out on this
     * side. Anything less puts the text on top of the very part it is pointing
     * into, which was the old failure in a new place: the first fix pushed the
     * labels apart from each other and straight onto the chassis.
     */
    const lx = 64 * L.scale;
    const xTag: V3 = [0, path.lower[1], -lx];
    const yTag: V3 = [0, path.upper[1] + 14 * L.scale, lx];
    const sTag: V3 = [0, L.benchY - 13, -lx * 0.72];
    line([0, path.lower[1], -6 * L.scale], [xTag[0], xTag[1] - 4, xTag[2] + 10], FAINT, 1);
    line([0, path.upper[1], 6 * L.scale], [yTag[0], yTag[1] - 4, yTag[2] - 10], FAINT, 1);
    line(path.tail, [sTag[0], sTag[1] - 4, sTag[2]], FAINT, 1);
    tag(xTag, "X MIRROR");
    tag(yTag, "Y MIRROR");
    tag(sTag, "SOURCE");
  } else {
    const pose = headPose(L, aim);
    const s = L.scale;
    /*
     * The laser module, living in the bracket's bore.
     *
     * Same dimensions and the same position the original used: it starts 10 mm
     * behind the bore and runs the module's own length forward, which puts its
     * lens face on the muzzle the beam is drawn from.
     */
    if (meshesReady.value && view) {
      drawHeadMeshes(pose);
      glPart(
        moduleMesh,
        {
          ex: mul(pose.fwd, MOUNT.moduleLen * s),
          ey: mul(pose.up, MOUNT.moduleR * s),
          ez: mul(pose.right, MOUNT.moduleR * s),
          origin: add(pose.pivot, mul(pose.fwd, -10 * s)),
        },
        MAT.brass,
      );
    } else {
      drawHeadBlocks(L, pose, { line, prism, tag });
    }
    line(pose.muzzle, aim.hit, beamCol, 1.5);
    /*
     * Out to the side of the module, on the open side away from the plate.
     *
     * Under it does not work: the module tail sits about five model units above
     * the top of the base, which is not enough room for a line of text, so a
     * label placed below lands on the base casting. Riding on `right` also keeps
     * it with the head as the head yaws instead of sliding across the parts.
     */
    /*
     * Directly above the module, riding the module's own tilt.
     *
     * Anchoring it in world up does not work on this rig: the head yaws through
     * tens of degrees and tilts as well, so any fixed offset that clears the
     * parts at one aim lands on the base or the bracket at another. Offsetting
     * along the barrel's own up keeps the label square to the thing it names, and
     * the space immediately off the module is the one place that is empty at
     * every aim.
     */
    tag(
      add(add(pose.pivot, mul(pose.fwd, 4 * s)), mul(pose.up, (MOUNT.moduleR + 15) * s)),
      "SOURCE",
    );
    tag([0, (51 - MOUNT.tiltY) * s + 10, 0], "HEAD");
  }

  tag([L.planeX, planeTop + 8, 0], "TARGET " + Math.round(L.throwMm) + " mm");

  /* Where the beam has already been. Under the live beam, because the live beam is
   * the only thing on this canvas allowed to be solid pink. */
  const tr = traceFor(L);
  if (tr.n > 1) {
    ctx.strokeStyle = "rgba(254,3,134,.42)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < tr.n; i++) {
      if (!tr.lit[i]) {
        pen = false;
        continue;
      }
      const s = P([tr.pts[i * 3]!, tr.pts[i * 3 + 1]!, tr.pts[i * 3 + 2]!]);
      if (pen) ctx.lineTo(s[0], s[1]);
      else {
        ctx.moveTo(s[0], s[1]);
        pen = true;
      }
    }
    ctx.stroke();
  }

  /* The hit. A dot and a ring, because a dot alone disappears against a trace. */
  const H = P(aim.hit);
  if (lit) {
    ctx.fillStyle = PINK;
    ctx.beginPath();
    ctx.arc(H[0], H[1], 3.4, 0, 7);
    ctx.fill();
    ctx.strokeStyle = "rgba(254,3,134,.35)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(H[0], H[1], 9, 0, 7);
    ctx.stroke();
  } else {
    ctx.fillStyle = BEAM_OFF;
    ctx.beginPath();
    ctx.arc(H[0], H[1], 2.6, 0, 7);
    ctx.fill();
    ctx.strokeStyle = BEAM_OFF;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(H[0], H[1], 7, 0, 7);
    ctx.stroke();
  }

  /* Readout. Axis units are what the board was told; degrees are what the metal
   * did with them, and on a mirror rig those differ by the factor of two that this
   * whole view exists to make obvious. */
  const RAD = 180 / Math.PI;
  const mech = p.beamAnglePerAxisAngle || 1;
  const part = L.kind === "mirrors" ? "mirror" : "servo";
  const unit = p.axis.a.name;
  ctx.fillStyle = DIM;
  ctx.fillText(
    "A " + Math.round(props.live.a) + " " + unit + " / " + ((aim.t1 / mech) * RAD).toFixed(2) + " deg " + part,
    10,
    h - 24,
  );
  ctx.fillText(
    "B " + Math.round(props.live.b) + " " + unit + " / " + ((aim.t2 / mech) * RAD).toFixed(2) + " deg " + part,
    10,
    h - 11,
  );
}

interface Pens {
  line: (a: V3, b: V3, col: string, wd?: number, dash?: number[]) => void;
  quad: (pts: V3[], fill: string | null, stroke: string | null) => void;
  tag: (q: V3, txt: string, col?: string) => void;
}

/**
 * The two mirror mechanism, as the detent sim builds it.
 *
 * Where each part goes is decided in detent-assembly.ts and checked against that
 * page's own matrix code in detent-assembly.test.ts. Nothing here chooses a
 * position; this only picks materials and draw order.
 */
/**
 * One part, through the depth buffered layer.
 *
 * The placement's three axes go in as the shader's basis and its origin as the
 * translation, which is the same decomposition the 2D path used: the geometry
 * stays in its own millimetres and the placement carries the scale.
 */
function glPart(mesh: Mesh | null, place: Placement, mat: readonly [Rgb, Rgb]) {
  if (!mesh || !view) return;
  glBasis[0] = place.ex[0];
  glBasis[1] = place.ex[1];
  glBasis[2] = place.ex[2];
  glBasis[3] = place.ey[0];
  glBasis[4] = place.ey[1];
  glBasis[5] = place.ey[2];
  glBasis[6] = place.ez[0];
  glBasis[7] = place.ez[1];
  glBasis[8] = place.ez[2];
  drawGl(view, mesh, glBasis, place.origin, unit8(mat[0]), unit8(mat[1]));
}

function drawDetentMeshes(t1: number, t2: number, L: Layout) {
  const P = placeDetent(t1, t2, L.scale, L.sepMm);
  glPart(dm.chassis, P.chassis, MAT.printed);
  glPart(dm.motor, P.motorA, MAT.steel);
  glPart(dm.motor, P.motorB, MAT.steel);
  glPart(dm.laser, P.laser, MAT.brass);
  glPart(dm.hub, P.hub1, MAT.printed);
  glPart(dm.hub, P.hub2, MAT.printed);
  glPart(dm.mirror, P.mirror1, MAT.mirror);
  glPart(dm.mirror, P.mirror2, MAT.mirror);
}

/**
 * Two mirrors on posts, for the moment before the parts have inflated.
 *
 * Each mirror sits at 45 degrees plus its own rotation. Drawn in the folded layout
 * the real rig uses, so the fallback and the meshes describe the same machine: the
 * lower mirror one separation below the upper one, not alongside it.
 */
function drawMirrorBlocks(L: Layout, t1: number, t2: number, pen: Pens) {
  const R = MIRROR_R;
  const CORNERS: number[][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const lowY = -L.sep;

  /* The lower mirror turns about the vertical, taking the lateral source beam and
   * sending it up the stack. */
  const ax = Math.PI / 4 - t1;
  const uX: V3 = [R * Math.cos(ax), 0, R * Math.sin(ax)];
  pen.quad(
    CORNERS.map(([a, b]): V3 => [uX[0] * a!, lowY + R * b!, uX[2] * a!]),
    INK_2,
    RULE,
  );

  /* The upper one tilts in the vertical plane and turns the beam out to the wall. */
  const ay = Math.PI / 4 + t2;
  const vY: V3 = [R * Math.cos(ay), R * Math.sin(ay), 0];
  pen.quad(
    CORNERS.map(([a, b]): V3 => [vY[0] * b!, vY[1] * b!, R * a!]),
    INK_2,
    RULE,
  );

  /* The post the pair stands on. */
  pen.line([0, L.benchY, 0], [0, R * 0.4, 0], RULE, 3);
}

interface HeadPens {
  line: (a: V3, b: V3, col: string, wd?: number, dash?: number[]) => void;
  prism: (c0: V3, ex: V3, ey: V3, ez: V3, fill: string, stroke: string) => void;
  tag: (q: V3, txt: string, col?: string) => void;
}

const mul = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** The pose the head is in, shared by the mesh and the schematic drawings. */
type HeadPose = HeadFrame & { muzzle: V3 };

function headPose(L: Layout, aim: Aim): HeadPose {
  const { yaw, tilt, pivot } = poseHead(L, aim.hit);
  const f = headFrame(yaw, tilt, L.scale, pivot);
  return { ...f, muzzle: muzzleOf(f) };
}

/**
 * The three printed parts, drawn where rig-assembly says they bolt together.
 *
 * The placements themselves are not decided here. They live in rig-assembly.ts
 * with a test that pins each one to a landmark measurable on the real part, which
 * is the only way this stays honest: a part a few millimetres out is invisible at
 * this size and this view is meant to be something you can check your own build
 * against.
 */
function drawHeadMeshes(pose: HeadPose) {
  /*
   * Back to front is no longer a correctness requirement, it is just habit: the
   * depth buffer resolves the order per pixel now, which is the whole reason this
   * moved off the 2D canvas. Drawing base, body, bracket still reads as the order
   * somebody assembles them in.
   */
  glPart(meshes.servoBase, placeServoBase(pose), MAT.printed);
  glPart(meshes.galvoBody, placeGalvoBody(pose), MAT.printed);
  glPart(meshes.galvoBrack, placeGalvoBrack(pose), MAT.steel);
}

/**
 * A pan/tilt head, drawn as blocks.
 *
 * This is the fallback for the moment before the meshes have inflated, and the
 * permanent drawing for anyone whose browser refuses to inflate them. The bracket
 * arm is at its true offset rather than exaggerated: the plate hangs a visible
 * 11.5 mm out and the bore brings the beam back to within 2.71 mm of the pan
 * axis, and that near cancellation is the actual shape of the part.
 */
function drawHeadBlocks(L: Layout, pose: HeadPose, pen: HeadPens) {
  const { pivot, fwd0, fwd, up, right } = pose;

  /* Base plate on the bench, and the post up to the yaw axis. */
  const b = L.benchY;
  pen.line([-11, b, -11], [13, b, -11], RULE, 1);
  pen.line([13, b, -11], [13, b, 13], RULE, 1);
  pen.line([13, b, 13], [-11, b, 13], RULE, 1);
  pen.line([-11, b, 13], [-11, b, -11], RULE, 1);
  pen.line([0, b, 0], [0, b + 6, 0], RULE, 3);

  const yokeH = (Math.abs(b) + 6) / 2;
  pen.prism(
    add(mul(right, L.plateModel), [0, b + 6 + yokeH - 6, 0]),
    mul(fwd0, 7),
    [0, yokeH, 0],
    mul(right, 2),
    INK_2,
    RULE,
  );
  pen.line(add(mul(right, L.plateModel), [0, 0, 0]), pivot, RULE, 2);
  pen.prism(pivot, mul(fwd, BARREL_HALF), mul(up, BARREL_R), mul(right, BARREL_R), INK_2, RULE);
}

/* --------------------------------------------------------------- lifecycle */

function frame(now: number) {
  if (!started) started = now;
  phase = ((now - started) / 1000) * CAM_RATE;
  paint();
  raf = requestAnimationFrame(frame);
}

/* ----------------------------------------------------------------- orbiting */

function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Take hold of the camera.
 *
 * Called by the first drag or wheel. Stopping the breath is not a side effect,
 * it is the point: a view that keeps drifting after it has been aimed is a view
 * that cannot be aimed. Repaints once by hand because the frame loop may not be
 * running at all under reduced motion.
 */
function grabCamera() {
  if (!touched.value) {
    touched.value = true;
    /* Hand over at the angle currently on screen, not at the centre of the swing,
     * or the rig jumps by up to CAM_SWING the instant it is touched. */
    orbit.yaw += Math.sin(phase) * CAM_SWING;
  }
}

let dragFrom: { x: number; y: number } | null = null;

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  grabCamera();
  dragFrom = { x: e.clientX, y: e.clientY };
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  if (!dragFrom) return;
  /*
   * Yaw follows the pointer rather than opposing it: dragging right turns the
   * rig's right side toward the viewer, which is what grabbing an object does.
   * laser-rig subtracted here because its theta ran the other way round.
   */
  orbit.yaw += (e.clientX - dragFrom.x) * ORBIT_RATE;
  orbit.pitch = clampRange(
    orbit.pitch + (e.clientY - dragFrom.y) * ORBIT_RATE,
    PITCH_MIN,
    PITCH_MAX,
  );
  dragFrom = { x: e.clientX, y: e.clientY };
  paint();
}

function onPointerUp(e: PointerEvent) {
  if (!dragFrom) return;
  dragFrom = null;
  dragging.value = false;
  const el = e.currentTarget as HTMLElement;
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
}

function onWheel(e: WheelEvent) {
  /* Not passive: the panel must not scroll the page out from under a zoom. */
  e.preventDefault();
  grabCamera();
  orbit.zoom = clampRange(orbit.zoom * (1 - e.deltaY * 0.0012), ZOOM_MIN, ZOOM_MAX);
  paint();
}

/** Put it back where it was found, and let it breathe again. */
function resetCamera() {
  orbit.yaw = CAM_YAW;
  orbit.pitch = CAM_PITCH;
  orbit.zoom = 1;
  touched.value = false;
  started = 0;
  paint();
}

/* --------------------------------------------------------------- lifecycle */

onMounted(() => {
  /* If WebGL2 is missing the whole mesh layer stands down and the schematic keeps
   * drawing, which is a working view of the rig rather than a blank panel. */
  if (glCv.value) view = initGl(glCv.value);
  if (!view) meshError.value = "no WebGL2, showing the schematic";

  ro = new ResizeObserver(paint);
  if (wrap.value) ro.observe(wrap.value);
  if (wantsStillness()) paint();
  else raf = requestAnimationFrame(frame);

  /*
   * Inflate the parts off the critical path.
   *
   * The schematic draws immediately and the meshes replace it when they land,
   * which is a few milliseconds later, so nothing waits on a decode. If one of
   * them fails the schematic simply stays: this view has to keep working on a
   * browser that will not give us DecompressionStream, because the alternative
   * is a blank panel on the machine somebody is trying to set up.
   */
  void Promise.all([decodeMesh("servoBase"), decodeMesh("galvoBody"), decodeMesh("galvoBrack")])
    .then(([base, body, brack]) => {
      meshes.servoBase = base;
      meshes.galvoBody = body;
      meshes.galvoBrack = brack;
      meshesReady.value = true;
      paint();
    })
    .catch((err: unknown) => {
      meshError.value = err instanceof Error ? err.message : String(err);
    });

  void Promise.all(
    (Object.keys(DETENT_MESH) as DetentMeshName[]).map((k) =>
      decodeQuantised(DETENT_MESH[k]).then((m) => [k, m] as const),
    ),
  )
    .then((pairs) => {
      for (const [k, m] of pairs) dm[k] = m;
      detentReady.value = true;
      paint();
    })
    .catch((err: unknown) => {
      meshError.value = err instanceof Error ? err.message : String(err);
    });
});

onBeforeUnmount(() => {
  ro?.disconnect();
  if (raf) cancelAnimationFrame(raf);
});

/*
 * Repaint on identity, never deeply.
 *
 * `simulated` holds one object per emitted sample, so a deep watch here makes
 * every position update walk the whole array before it can draw. That is what
 * made the target preview crawl once already, and there is no reason for this
 * canvas to relearn it: the arrays are replaced wholesale on replan, so comparing
 * references is both correct and free.
 *
 * The watch only matters while the camera is held still. When it breathes, the
 * frame loop is already repainting.
 */
watch(
  () => [
    props.profile,
    props.fieldW,
    props.fieldH,
    props.simulated,
    props.live,
    props.beamOn,
    props.cal,
  ],
  paint,
);
</script>

<template>
  <div ref="wrap" class="hb-view wrap">
    <canvas ref="glCv" class="solids"></canvas>
    <canvas
      ref="cv"
      :class="{ grabbing: dragging }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel="onWheel"
      @dblclick="resetCamera"
    ></canvas>
    <div class="hb-vlabel">scanner</div>
    <!-- Says what to do until it has been done once, then gets out of the way and
         offers the way back. -->
    <button v-if="touched" class="reset" type="button" @click="resetCamera">reset view</button>
    <div v-else class="hint">drag to orbit &middot; scroll to zoom</div>
    <div v-if="meshError" class="hint err">parts not shown: {{ meshError }}</div>
  </div>
</template>

<style scoped>
/* Surface, border and the pink offset shadow all come from .hb-view. Only the
 * sizing is this component's business. */
.wrap { width: 100%; height: 100%; min-height: 0; position: relative; }
/*
 * Both layers are positioned and both are explicitly ordered.
 *
 * Leaving the overlay static and the solids absolute is not "underneath": inside
 * one stacking context a positioned element paints above a static one whatever the
 * document order says, so the solids covered the beam, the plane and every label.
 * Order both, or neither is ordered.
 */
canvas {
  display: block;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
  z-index: 1;
}
/* The solids take no pointer events: the overlay above covers the same box and is
 * what the orbit handlers are bound to. */
.solids { z-index: 0; pointer-events: none; cursor: default; }
canvas.grabbing { cursor: grabbing; }

/* Both sit in the top right, out of the readout's way at the bottom left. */
.hint, .reset {
  position: absolute;
  top: 8px;
  right: 10px;
  font: 12px "VT323", ui-monospace, monospace;
  letter-spacing: .04em;
  color: #5e574f;
  pointer-events: none;
}
.hint.err { top: 24px; color: #a8564f; }
.reset {
  pointer-events: auto;
  cursor: pointer;
  background: transparent;
  border: 1px solid rgba(245, 240, 230, .18);
  border-radius: 0;
  padding: 1px 6px;
}
.reset:hover { color: #f5f0e6; border-color: rgba(245, 240, 230, .38); }
</style>
