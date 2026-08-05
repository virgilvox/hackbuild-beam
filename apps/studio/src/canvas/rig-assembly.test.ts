import { describe, expect, it } from "vitest";
import {
  applyPlacement,
  headFrame,
  MOUNT,
  muzzleOf,
  STAND_HEIGHT_MM,
  PIVOT_OFF_MM,
  placeGalvoBody,
  placeGalvoBrack,
  placeServoBase,
  type HeadFrame,
  type V3,
} from "./rig-assembly.js";

/*
 * Does the rig go together the way the hardware does.
 *
 * A part placed a few millimetres out is invisible on a 200 pixel rig, and this
 * view is meant to be something you can look at to work out which way your own
 * bracket mounts. So every number that came out of the coordinate change is
 * pinned to a landmark that can be measured on the real parts with calipers.
 *
 * Model space here: +X down the beam, +Y up, +Z lateral, origin ON THE TILT AXIS.
 * That last part is why the base sits at negative y: the bench is MOUNT.tiltY
 * below the bore, not at zero.
 */

/** Bounding boxes measured off the STLs, in each mesh's own local millimetres. */
const BOX = {
  servoBase: { min: [-25.5, -22.55, 0], max: [25.5, 22.55, 16] },
  galvoBody: { min: [-14.5, 0, -11.5], max: [11.5, 51, 11.5] },
  galvoBrack: { min: [-10, 0, -8.8], max: [10, 17.58, 8.8] },
} as const;

/** Every corner of a box, so a placement is checked on the whole solid. */
function corners(b: { min: readonly number[]; max: readonly number[] }): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < 8; i++) {
    out.push([
      (i & 1 ? b.max : b.min)[0]!,
      (i & 2 ? b.max : b.min)[1]!,
      (i & 4 ? b.max : b.min)[2]!,
    ]);
  }
  return out;
}

function extent(pts: V3[]): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      if (p[k]! < min[k]!) min[k] = p[k]!;
      if (p[k]! > max[k]!) max[k] = p[k]!;
    }
  }
  return { min, max };
}

/** Square on, unscaled, bore at the origin. The frame every landmark is stated in. */
function square(): HeadFrame {
  return headFrame(0, 0, 1, [0, 0, PIVOT_OFF_MM]);
}

/*
 * Ground truth, read out of laser-rig.html itself.
 *
 * These are not derived, they were measured: that app was loaded, both joints
 * were zeroed, its scene graph was updated, and the world position of each
 * landmark was read straight off the three.js meshes. It puts the bore at world
 * y = 0, which is the same origin this view uses, so the only conversion applied
 * is the axis change (x, y, z)_scene -> (-z, y, x)_rig.
 *
 * This is the check that matters. Everything else in this file can only confirm
 * that the placements agree with my own reading of the assembly; this confirms
 * they agree with the app that has been driving the real hardware.
 */
const ORIGINAL: Array<{ what: string; part: "base" | "body" | "brack"; local: V3; model: V3 }> = [
  /* Underside of the base, on the table. -47.7 is -(tiltY + panHornY). */
  { what: "base underside", part: "base", local: [0, 0, 0], model: [-5.6, -47.7, 0] },
  { what: "base top face", part: "base", local: [0, 0, 16], model: [-5.6, -31.7, 0] },
  /* The galvobody stands on the pan horn, tiltY below the bore. */
  { what: "body underside", part: "body", local: [0, 0, 0], model: [0, -27.5, 1.5] },
  { what: "plate inboard face", part: "body", local: [-11.5, 27.5, 0], model: [0, 0, -10] },
  { what: "plate outboard face", part: "body", local: [-14.5, 27.5, 0], model: [0, 0, -13] },
  /* The bore, which is the pivot, and the shaft it runs on. */
  { what: "bore at the mount end", part: "brack", local: [0, 8.79, 0], model: [0, 0, -2.71] },
  { what: "bore ten down the axis", part: "brack", local: [10, 8.79, 0], model: [10, 0, -2.71] },
  { what: "bracket mount face", part: "brack", local: [0, 0, 0], model: [0, 0, -11.5] },
];

describe("agrees with laser-rig.html, landmark for landmark", () => {
  const f = headFrame(0, 0, 1, [0, 0, PIVOT_OFF_MM]);
  const place = {
    base: placeServoBase(f),
    body: placeGalvoBody(f),
    brack: placeGalvoBrack(f),
  };

  it.each(ORIGINAL)("puts the $what where the original does", ({ part, local, model }) => {
    const got = applyPlacement(place[part], local);
    for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(model[k]!, 4);
  });

  it("puts the muzzle 29 mm down the bore, as the original's muzzle object is", () => {
    /* laser-rig reports its muzzle at scene (-2.71, 0, -29), which is this. */
    const m = muzzleOf(f);
    expect(m[0]).toBeCloseTo(29, 4);
    expect(m[1]).toBeCloseTo(0, 4);
    expect(m[2]).toBeCloseTo(-2.71, 4);
  });
});

describe("the pivot offset is the lever arm, not a fudge", () => {
  it("puts the tilt axis 2.71 mm past the pan axis", () => {
    /*
     * The plate face is 11.5 mm to one side of the pan axis and the bore is 8.79
     * back from that face, so the beam pivots 2.71 mm PAST the axis rather than
     * on it. If this ever comes out zero somebody has quietly decided the head is
     * ideal, and the yaw solve upstream stops being necessary.
     */
    expect(PIVOT_OFF_MM).toBeCloseTo(-2.71, 6);
  });

  it("is half the bracket's own height out from its mount face", () => {
    /* The bore runs down the middle of the collar. This is the check that says
     * these STLs are the pan/tilt parts and not something else. */
    const h = BOX.galvoBrack.max[1] - BOX.galvoBrack.min[1];
    expect(MOUNT.brackBore).toBeCloseTo(h / 2, 3);
  });
});

describe("servo base", () => {
  const p = placeServoBase(square());
  const e = extent(corners(BOX.servoBase).map((v) => applyPlacement(p, v)));

  it("stands on the bench, which is the whole stand height below the bore", () => {
    /* Not tiltY. tiltY is measured from the galvobody's base, and that base is
     * another panHornY up on top of the pan servo. */
    expect(e.min[1]).toBeCloseTo(-STAND_HEIGHT_MM, 6);
    expect(STAND_HEIGHT_MM).toBeCloseTo(47.7, 6);
  });

  it("is 16 mm thick, and the horn clears it by 4.2", () => {
    expect(e.max[1] - e.min[1]).toBeCloseTo(16, 6);
    expect(e.max[1]).toBeCloseTo(-STAND_HEIGHT_MM + 16, 6);
    /* panHornY is measured from the table, so the servo horn stands 4.2 mm proud
     * of the base casting. That gap is where the galvobody bolts on. */
    expect(MOUNT.panHornY - 16).toBeCloseTo(4.2, 6);
  });

  it("is shifted so the pocket's shaft lands on the pan axis, not the outline centre", () => {
    /*
     * The base is symmetric about its own centre, so an unshifted placement would
     * straddle x = 0. The shaft sits panShaftOff from that centre, which is the
     * whole reason this part is offset rather than dropped.
     */
    const mid = (e.min[0]! + e.max[0]!) / 2;
    expect(mid).toBeCloseTo(-MOUNT.panShaftOff, 6);
  });

  it("lies flat: 51 across the beam axis and 45.1 laterally", () => {
    expect(e.max[0]! - e.min[0]!).toBeCloseTo(45.1, 6);
    expect(e.max[2]! - e.min[2]!).toBeCloseTo(51, 6);
  });
});

describe("galvo body", () => {
  const p = placeGalvoBody(square());
  const e = extent(corners(BOX.galvoBody).map((v) => applyPlacement(p, v)));

  it("sits on the pan horn, not on the bench", () => {
    /* The body's own base is exactly tiltY below the bore, which is what tiltY
     * means. It is panHornY clear of the table. */
    expect(e.min[1]).toBeCloseTo(-MOUNT.tiltY, 6);
    expect(e.min[1]! + STAND_HEIGHT_MM).toBeCloseTo(MOUNT.panHornY, 6);
  });

  it("stands its full 51 mm, which puts the tilt slot around the bore", () => {
    expect(e.max[1] - e.min[1]).toBeCloseTo(51, 6);
    /* The bore is at model y = 0 and has to fall inside the body's height, or the
     * tilt servo is mounted somewhere the plate does not exist. */
    expect(e.min[1]).toBeLessThan(0);
    expect(e.max[1]).toBeGreaterThan(0);
  });

  it("carries its plate on the same side the bracket mounts to", () => {
    /*
     * The plate is the mesh's -x wall, so it lands on the negative lateral side,
     * which is the side PIVOT_OFF_MM is negative on. If these ever disagree the
     * bracket is drawn hanging off thin air on the far side of the body.
     */
    expect(Math.sign(e.min[2]!)).toBe(Math.sign(PIVOT_OFF_MM));
    /* Outer face of the 3 mm plate, and its inboard face 3 mm in. */
    expect(e.min[2]).toBeCloseTo(-14.5 + MOUNT.bodyOffX, 6);
    const inboard = applyPlacement(p, [-11.5, 0, 0])[2];
    expect(inboard).toBeCloseTo(MOUNT.plateFaceX + MOUNT.bodyOffX, 6);
  });

  it("has the bracket's mount face landing within the plate it bolts to", () => {
    /*
     * The one seam in the assembly, and it is inherited rather than introduced.
     *
     * laser-rig.html nudges the body by bodyOffX to bring its horn boss onto the
     * pan axis, but positions the barrel from the raw plateFaceX, so the bracket
     * mount face ends up 1.5 mm inside the plate rather than flush against its
     * inboard surface. At 1.5 mm on a 51 mm part that is well under a pixel here,
     * and closing it would move PIVOT_OFF_MM, which is the number the aiming
     * solve depends on. So it is left as the original has it and pinned instead:
     * the face must at least land somewhere in the plate's own thickness.
     */
    const outer = applyPlacement(p, [-14.5, 0, 0])[2]!;
    const inboard = applyPlacement(p, [-11.5, 0, 0])[2]!;
    expect(MOUNT.plateFaceX).toBeGreaterThanOrEqual(Math.min(outer, inboard));
    expect(MOUNT.plateFaceX).toBeLessThanOrEqual(Math.max(outer, inboard));
    expect(Math.abs(MOUNT.plateFaceX - inboard)).toBeCloseTo(MOUNT.bodyOffX, 6);
  });
});

describe("galvo bracket", () => {
  const f = square();
  const p = placeGalvoBrack(f);

  it("puts its bore exactly on the tilt axis", () => {
    /* Mesh (x, brackBore, 0) is the bore centreline. Every point of it must land
     * on the pivot, because the bore IS the pivot. */
    for (const x of [-10, 0, 10]) {
      const v = applyPlacement(p, [x, MOUNT.brackBore, 0]);
      expect(v[1]).toBeCloseTo(0, 6);
      expect(v[2]).toBeCloseTo(PIVOT_OFF_MM, 6);
    }
  });

  it("aims that bore down the beam axis", () => {
    /*
     * The bore has to point at the target, not across it. Walking mesh +x must
     * move the point along +X in model space and nowhere else, which is the
     * single assertion that catches the quarter turn being applied about the
     * wrong axis.
     */
    const a = applyPlacement(p, [0, MOUNT.brackBore, 0]);
    const b = applyPlacement(p, [10, MOUNT.brackBore, 0]);
    expect(b[0]! - a[0]!).toBeCloseTo(10, 6);
    expect(b[1]! - a[1]!).toBeCloseTo(0, 6);
    expect(b[2]! - a[2]!).toBeCloseTo(0, 6);
  });

  it("lands its mount face on the plate face", () => {
    /* Mesh y = 0 is the face that bolts to the tilt horn. It has to arrive at
     * plateFaceX, which is what makes brackBore the offset it is. */
    const v = applyPlacement(p, [0, 0, 0]);
    expect(v[2]).toBeCloseTo(MOUNT.plateFaceX, 6);
  });

  it("stands upright, its height across the beam rather than along it", () => {
    const e = extent(corners(BOX.galvoBrack).map((v) => applyPlacement(p, v)));
    expect(e.max[1]! - e.min[1]!).toBeCloseTo(17.6, 6);
    expect(e.max[0]! - e.min[0]!).toBeCloseTo(20, 6);
  });
});

describe("the joints actually move the parts", () => {
  it("yaws the body about the pan axis and leaves the base alone", () => {
    const a = square();
    const b = headFrame(0.7, 0, 1, [0, 0, PIVOT_OFF_MM]);
    const probe: V3 = [0, 25, 0];
    const base0 = applyPlacement(placeServoBase(a), probe);
    const base1 = applyPlacement(placeServoBase(b), probe);
    /* The base holds the pan servo, so it must not turn with it. */
    expect(base1).toEqual(base0);

    const body0 = applyPlacement(placeGalvoBody(a), probe);
    const body1 = applyPlacement(placeGalvoBody(b), probe);
    expect(Math.hypot(body1[0]! - body0[0]!, body1[2]! - body0[2]!)).toBeGreaterThan(1);
    /* A yaw is a rotation about the vertical, so it cannot change a height. */
    expect(body1[1]).toBeCloseTo(body0[1]!, 6);
  });

  it("tilts the bracket about its own bore, so the bore never moves", () => {
    for (const tilt of [-0.5, 0, 0.4]) {
      const f = headFrame(0.3, tilt, 1, [0, 0, PIVOT_OFF_MM]);
      const v = applyPlacement(placeGalvoBrack(f), [0, MOUNT.brackBore, 0]);
      /* Whatever the tilt, the point on the bore at the shaft stays on the pivot.
       * A bracket that swings its own bore around is a bracket drawn about the
       * wrong centre, and the beam then leaves from somewhere off the lens. */
      expect(v[0]).toBeCloseTo(f.pivot[0]!, 6);
      expect(v[1]).toBeCloseTo(f.pivot[1]!, 6);
      expect(v[2]).toBeCloseTo(f.pivot[2]!, 6);
    }
  });

  it("keeps the muzzle on the bore axis, ahead of the pivot", () => {
    const f = headFrame(0.3, 0.2, 1, [0, 0, PIVOT_OFF_MM]);
    const m = muzzleOf(f);
    const d: V3 = [m[0] - f.pivot[0]!, m[1] - f.pivot[1]!, m[2] - f.pivot[2]!];
    const len = Math.hypot(d[0], d[1], d[2]);
    expect(len).toBeCloseTo(MOUNT.moduleLen - 6, 6);
    /* Parallel to the barrel, not merely near it. */
    expect(d[0] / len).toBeCloseTo(f.fwd[0]!, 6);
    expect(d[1] / len).toBeCloseTo(f.fwd[1]!, 6);
    expect(d[2] / len).toBeCloseTo(f.fwd[2]!, 6);
  });
});

describe("scale is uniform", () => {
  it("does not stretch a part when the view shrinks the rig", () => {
    /*
     * The reach over throw scale changes with the field, so every placement is
     * multiplied by it. A basis that picked up the scale on two axes and not the
     * third would only show up as a subtly wrong looking part at one throw.
     */
    const s = 0.63;
    const f = headFrame(0.4, 0.2, s, [0, 0, PIVOT_OFF_MM * s]);
    for (const p of [placeServoBase(f), placeGalvoBody(f), placeGalvoBrack(f)]) {
      for (const ax of [p.ex, p.ey, p.ez]) {
        expect(Math.hypot(ax[0], ax[1], ax[2])).toBeCloseTo(s, 9);
      }
    }
  });
});
