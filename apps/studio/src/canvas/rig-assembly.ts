/*
 * Where each printed part sits.
 *
 * Pulled out of ScannerCanvas so it can be checked rather than eyeballed. A part
 * placed a few millimetres out looks like nothing at all on a 200 pixel wide rig,
 * right up until somebody uses this view to work out which way their bracket goes
 * on. Every landmark these functions imply is asserted in rig-assembly.test.ts.
 *
 * Two coordinate systems meet here and getting them confused is the whole risk.
 *
 *   laser-rig.html   Y up, beam down -Z, parts assembled in a three.js graph
 *   this view        Y up, beam down +X, +Z lateral, no scene graph at all
 *
 * A direction crosses between them as (x, y, z)_scene -> (-z, y, x)_rig. That map
 * is applied to each part's BASIS rather than to its vertices, which is why a
 * placement below is three axes and an origin instead of a chain of matrices: the
 * per vertex cost then stays one matrix, however deep the original nesting was.
 */

/** MOUNT, straight from laser-rig.html, every number read off the STLs. */
export const MOUNT = {
  /** Top of the pan servo body, where the galvobody bolts on. */
  panHornY: 20.2,
  /** The shaft is off centre in the base pocket, so the base mesh shifts. */
  panShaftOff: 5.6,
  /** Puts the galvobody's horn boss on the pan axis. */
  bodyOffX: 1.5,
  /** Inboard face of the plate. The tilt horn mounts here. */
  plateFaceX: -11.5,
  /** Tilt shaft height above the galvobody base. */
  tiltY: 27.5,
  /** Mount face to bore axis, which is where the beam pivots. */
  brackBore: 8.79,
  /** The laser module itself, living in the bore. */
  moduleLen: 35,
  moduleR: 6.0,
} as const;

/**
 * How far the tilt axis sits from the pan axis, in millimetres.
 *
 * Negative, because the bracket hangs off the far side of the plate and the bore
 * brings the beam back past the pan axis rather than onto it. This is the lever
 * arm that makes the yaw a solve instead of an arctangent.
 */
export const PIVOT_OFF_MM = MOUNT.plateFaceX + MOUNT.brackBore;

export type V3 = [number, number, number];

/** A part's own frame, expressed in model space and already scaled. */
export interface Placement {
  /** Where the mesh's local +x, +y and +z go. */
  ex: V3;
  ey: V3;
  ez: V3;
  /** Where the mesh's local origin goes. */
  origin: V3;
}

/**
 * The head's pose, as the canvas has already solved it.
 *
 * `pivot` is the bore, in model units, and the model puts it at y = 0: the whole
 * assembly hangs off the tilt axis rather than off the table, because that is the
 * point the beam actually leaves from and the point the rest of the view is built
 * around.
 */
export interface HeadFrame {
  /** Model units per millimetre. */
  scale: number;
  /** Yawed but untilted forward and lateral, which is what the body turns with. */
  fwd0: V3;
  right: V3;
  /** Fully posed barrel basis, which is what the bracket turns with. */
  fwd: V3;
  up: V3;
  pivot: V3;
}

const mul = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/**
 * The table, relative to the bore. Everything below the tilt joint hangs off this.
 *
 * tiltY is measured from the GALVOBODY'S BASE, not from the table, and that base
 * is itself panHornY up in the air on top of the pan servo. Reading it as a height
 * above the table puts the whole lower assembly one panHornY too high, which does
 * not look broken so much as slightly wrong, and leaves the bracket appearing to
 * float rather than to bolt to a plate.
 *
 * The sum is checked against laser-rig.html's own scene graph in the test: with
 * both joints zeroed that app puts the bore at world y = 0 and the underside of
 * the base at y = -47.7, which is exactly -(tiltY + panHornY).
 */
function tableY(f: HeadFrame): V3 {
  return [0, -(MOUNT.tiltY + MOUNT.panHornY) * f.scale, 0];
}

/** Height of the bench below the bore, in millimetres. Positive downward. */
export const STAND_HEIGHT_MM = MOUNT.tiltY + MOUNT.panHornY;

/**
 * The base. It holds the pan servo, so it is the one part that does NOT turn.
 *
 * Modelled z up where this view is y up, so it is tipped a quarter turn, and its
 * pocket's shaft sits off the outline centre, so it is also shifted to bring that
 * shaft onto the pan axis. Mesh +y becomes forward, mesh +z becomes up, mesh +x
 * becomes lateral.
 */
export function placeServoBase(f: HeadFrame): Placement {
  const s = f.scale;
  return {
    ex: [0, 0, s],
    ey: [s, 0, 0],
    ez: [0, s, 0],
    origin: add([-MOUNT.panShaftOff * s, 0, 0], tableY(f)),
  };
}

/**
 * The body, bolted to the pan horn. Turns with the yaw and nothing else.
 *
 * Stands on its own base at mesh y = 0, so it only needs lifting to the horn and
 * nudging by bodyOffX to bring its boss onto the pan axis.
 */
export function placeGalvoBody(f: HeadFrame): Placement {
  const s = f.scale;
  const yaw = (v: V3): V3 => [
    v[0] * f.fwd0[0] + v[2] * f.right[0],
    v[1],
    v[0] * f.fwd0[2] + v[2] * f.right[2],
  ];
  return {
    ex: yaw([0, 0, s]),
    ey: [0, s, 0],
    ez: yaw([-s, 0, 0]),
    origin: add(
      add(yaw([0, 0, MOUNT.bodyOffX * s]), [0, MOUNT.panHornY * s, 0]),
      tableY(f),
    ),
  };
}

/**
 * The bracket, bolted to the tilt horn. The only part that sees both joints.
 *
 * Placed from the pivot rather than from the ground, because its bore IS the
 * pivot: the mesh origin sits one bore offset back along the tilt shaft and
 * everything else follows the barrel basis. Mesh +x runs down the bore toward the
 * target, mesh +y runs from the mount face out to the bore, mesh +z is the
 * bracket's own height and points DOWN the barrel's up, which is the quarter turn
 * laser-rig applied to the geometry before mounting it.
 */
export function placeGalvoBrack(f: HeadFrame): Placement {
  const s = f.scale;
  return {
    ex: mul(f.fwd, s),
    ey: mul(f.right, s),
    ez: mul(f.up, -s),
    origin: add(f.pivot, mul(f.right, -MOUNT.brackBore * s)),
  };
}

/** Apply a placement to a point in the mesh's own millimetres. */
export function applyPlacement(p: Placement, v: V3): V3 {
  return [
    p.origin[0] + p.ex[0] * v[0] + p.ey[0] * v[1] + p.ez[0] * v[2],
    p.origin[1] + p.ex[1] * v[0] + p.ey[1] * v[1] + p.ez[1] * v[2],
    p.origin[2] + p.ex[2] * v[0] + p.ey[2] * v[1] + p.ez[2] * v[2],
  ];
}

/**
 * The barrel basis for a given yaw and tilt.
 *
 * Split out so the placements above and the tests below agree on what "posed"
 * means without either of them owning the definition.
 */
export function headFrame(yaw: number, tilt: number, scale: number, pivot: V3): HeadFrame {
  const fwd0: V3 = [Math.cos(yaw), 0, Math.sin(yaw)];
  const right: V3 = [-Math.sin(yaw), 0, Math.cos(yaw)];
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  return {
    scale,
    fwd0,
    right,
    fwd: [ct * fwd0[0], st, ct * fwd0[2]],
    /* right cross fwd, so the barrel rolls with its own tilt. */
    up: [-st * fwd0[0], ct, -st * fwd0[2]],
    pivot,
  };
}

/** Where the beam leaves the lens, given a posed head. */
export function muzzleOf(f: HeadFrame): V3 {
  return add(f.pivot, mul(f.fwd, (MOUNT.moduleLen - 6) * f.scale));
}
