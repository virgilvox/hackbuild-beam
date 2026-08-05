import type { Placement, V3 } from "./rig-assembly.js";

/*
 * Where the two mirror scanner's parts sit.
 *
 * Ported from the detent sim's own `placements()`, which is the page that has been
 * driving this machine. Its numbers are not re-derived here, they are carried
 * across and then pinned in detent-assembly.test.ts against values computed by
 * running that page's matrix code directly.
 *
 * The rig is genuinely FOLDED, which the old schematic in this view was not. The
 * beam leaves the module sideways along the rig's own X, strikes the lower mirror,
 * turns UP through the mirror separation to the upper mirror, and only then turns
 * out toward the target. Drawing both mirrors in a row along the optical axis, as
 * the first port did, is legible but it is not the machine: it hides that the
 * separation is vertical and that the source fires across the rig rather than at
 * the wall.
 *
 * Two coordinate systems, again.
 *
 *   detent sim   Z up, beam leaves along +Y, source fires along +X
 *   this view    Y up, beam leaves along +X, +Z lateral
 *
 * A vector crosses as (x, y, z)_sim -> (y, z, x)_rig. That is a cyclic permutation
 * and so a proper rotation: its determinant is +1. Negating an axis to make the
 * lateral sense agree with the target view would be a reflection, which quietly
 * inverts every triangle's winding and turns the backface cull inside out.
 */

/** The sim's own constants, all from its M and G2 tables. */
export const DETENT = {
  /** Height of the lower mirror's axis above the base plate. */
  h1: 14.4,
  /** Mirror separation. The same sepMm the planner's geometry uses. */
  sep: 22.8,
  /** Motor shaft offsets from the optical axis, G2.SA and G2.SB. */
  motorA: 22.5,
  motorB: 22.5,
  /** Hub seat, G2.SEAT: how far down the hub the mirror pocket sits. */
  seat: 21.0,
  /** Pocket notch, G2.NOTCH. */
  notch: 3.0,
  /** The 405 nm module: where its face is, and how long it is. */
  laserX: -13.0,
  laserLen: 35,
} as const;

/**
 * Height of the upper mirror's axis, for a given separation.
 *
 * The separation is a parameter and not the sim's constant, because on this app it
 * is machine config: the board reports it and the planner already uses it, so a rig
 * built with a different spacing has to draw with that spacing or the picture stops
 * describing the machine it is connected to. Everything else here is fixed by the
 * printed parts and comes across as it stands.
 */
export function h2Of(sep: number = DETENT.sep): number {
  return DETENT.h1 + sep;
}

/** The sim's own separation, which is what the numbers here were measured at. */
export const H2 = DETENT.h1 + DETENT.sep;

/* ------------------------------------------------ the sim's own 4x4, column major */

type M4 = number[];

const m4 = {
  mul: (a: M4, b: M4): M4 => {
    const o = new Array<number>(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
        o[c * 4 + r] = s;
      }
    }
    return o;
  },
  trans: (x: number, y: number, z: number): M4 =>
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
  rotX: (t: number): M4 => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  },
  rotY: (t: number): M4 => {
    const c = Math.cos(t);
    const s = Math.sin(t);
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  },
  basis: (ex: V3, ey: V3, ez: V3, t: V3): M4 =>
    [ex[0], ex[1], ex[2], 0, ey[0], ey[1], ey[2], 0, ez[0], ez[1], ez[2], 0, t[0], t[1], t[2], 1],
};

const AX: V3 = [1, 0, 0];
const AY: V3 = [0, 1, 0];
const AZ: V3 = [0, 0, 1];
const NY: V3 = [0, -1, 0];
const NZ: V3 = [0, 0, -1];

/**
 * Sim space to this view's model space.
 *
 * A cyclic permutation, so it is a rotation and not a reflection. The origin lands
 * on the UPPER mirror, because that is where the beam leaves for the target and
 * the rest of this canvas is built around the exit point, exactly as the pan/tilt
 * head is built around its bore.
 */
export function toModel(
  v: readonly number[],
  scale: number,
  isPoint: boolean,
  h2: number = H2,
): V3 {
  return [v[1]! * scale, (v[2]! - (isPoint ? h2 : 0)) * scale, v[0]! * scale];
}

function placementOf(m: M4, scale: number, h2: number): Placement {
  const col = (i: number): V3 => [m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!];
  return {
    ex: toModel(col(0), scale, false, h2),
    ey: toModel(col(1), scale, false, h2),
    ez: toModel(col(2), scale, false, h2),
    origin: toModel(col(3), scale, true, h2),
  };
}

/**
 * Everything, posed.
 *
 * `t1` and `t2` are MECHANICAL radians, the angle each mirror has actually turned,
 * which on this machine is half the beam angle because a mirror deflects by twice
 * its own rotation. Passing beam angles here would swing the parts through double
 * what the metal does.
 */
export interface DetentParts {
  /** The printed body. It does not move, so it is placed by the axis change alone. */
  chassis: Placement;
  motorA: Placement;
  motorB: Placement;
  laser: Placement;
  hub1: Placement;
  hub2: Placement;
  mirror1: Placement;
  mirror2: Placement;
}

export function placeDetent(
  t1: number,
  t2: number,
  scale: number,
  sep: number = DETENT.sep,
): DetentParts {
  const { h1, seat, notch, motorA, motorB, laserX, laserLen } = DETENT;
  const H2 = h2Of(sep);

  /*
   * The hubs. Each one rides its motor's shaft, so it is built as: go up to the
   * shaft height, turn by the mechanical angle, then step out to the seat and
   * stand the part up on its own axis. The three quarter and quarter turn offsets
   * are the parked positions, which is where the pockets face at zero.
   */
  const hub1 = m4.mul(
    m4.mul(m4.trans(0, 0, h1), m4.rotY(t1 - (3 * Math.PI) / 4)),
    m4.mul(m4.trans(0, -seat, -h1), m4.mul(m4.trans(0, 0, h1), m4.rotX(-Math.PI / 2))),
  );
  const hub2 = m4.mul(
    m4.mul(m4.trans(0, 0, H2), m4.rotX(t2 + Math.PI / 4)),
    m4.mul(m4.trans(-seat, 0, -H2), m4.mul(m4.trans(0, 0, H2), m4.rotY(Math.PI / 2))),
  );
  /* The mirror sits in the hub's pocket, so it inherits the hub outright. */
  const mirLocal = m4.basis(AY, AZ, AX, [-notch, 0, seat]);

  return {
    /* The body is modelled in assembly coordinates, so it needs no matrix of its
     * own: the axis change and the shift onto the exit mirror are the whole of it.
     * That is exactly what the sim does, where it is put with the identity. */
    chassis: placementOf(
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      scale,
      H2,
    ),
    /* Both cans lie on their sides, shafts pointing at the optical axis. */
    motorA: placementOf(m4.basis(AX, NZ, AY, [0, -motorA, h1]), scale, H2),
    motorB: placementOf(m4.basis(NY, NZ, AX, [-motorB, 0, H2]), scale, H2),
    /* The module fires ACROSS the rig, not at the wall. Its far face is the lens. */
    laser: placementOf(m4.basis(AY, AZ, AX, [laserX - laserLen, 0, h1]), scale, H2),
    hub1: placementOf(hub1, scale, H2),
    hub2: placementOf(hub2, scale, H2),
    mirror1: placementOf(m4.mul(hub1, mirLocal), scale, H2),
    mirror2: placementOf(m4.mul(hub2, mirLocal), scale, H2),
  };
}

/* ------------------------------------------------------------- the beam path */

/**
 * The folded path, in model units, up to the point it leaves for the target.
 *
 * Three points: the lens, the lower mirror, the upper mirror. The fourth leg is
 * the throw and the canvas already knows where that lands, because the hit comes
 * from the machine profile rather than from this geometry.
 */
export function beamPath(
  scale: number,
  sep: number = DETENT.sep,
): { tail: V3; lens: V3; lower: V3; upper: V3 } {
  const h2 = h2Of(sep);
  return {
    /* The diode end of the module, which is what a SOURCE label wants to point at. */
    tail: toModel([DETENT.laserX - DETENT.laserLen, 0, DETENT.h1], scale, true, h2),
    lens: toModel([DETENT.laserX, 0, DETENT.h1], scale, true, h2),
    lower: toModel([0, 0, DETENT.h1], scale, true, h2),
    upper: toModel([0, 0, h2], scale, true, h2),
  };
}

/**
 * The body's bounding box, in the sim's own coordinates.
 *
 * Copied from that page's MESHMETA rather than measured off the decoded mesh,
 * because the view needs it to FRAME the rig and framing has to happen before the
 * geometry has finished inflating. detent-assembly.test.ts checks it still matches
 * what the packer emitted, so a re-export of the part cannot silently leave the
 * camera framing the old one.
 */
export const CHASSIS_BOX = {
  lo: [-49.0, -43.0, 0.0],
  span: [71.0, 65.0, 62.799999],
} as const;

/**
 * How far the rig reaches, in model millimetres, from the exit mirror.
 *
 * The body is the biggest thing here by a long way, so this is its box put through
 * the axis change. Framing to the mechanism alone draws the rig several times too
 * large and hangs the body off every edge of the panel.
 */
export function bodyExtent(sep: number = DETENT.sep): {
  back: number;
  halfZ: number;
  top: number;
} {
  const h2 = h2Of(sep);
  const lo = CHASSIS_BOX.lo;
  const span = CHASSIS_BOX.span;
  return {
    /* Sim +Y is this view's +X, so the body's -Y face is how far back it reaches. */
    back: Math.abs(lo[1]!),
    /* Sim +X is lateral here, and the body is not centred on it. */
    halfZ: Math.max(Math.abs(lo[0]!), Math.abs(lo[0]! + span[0]!)),
    /* Sim +Z is up, measured from the exit mirror rather than from the bench. */
    top: lo[2]! + span[2]! - h2,
  };
}

/** The base plate's top face, which is what the parts stand on. */
export function benchY(scale: number, sep: number = DETENT.sep): number {
  return -h2Of(sep) * scale;
}
