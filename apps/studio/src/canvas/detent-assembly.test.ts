import { describe, expect, it } from "vitest";
import { applyPlacement, type V3 } from "./rig-assembly.js";
import { beamPath, DETENT, H2, placeDetent, toModel } from "./detent-assembly.js";

/*
 * Does the two mirror rig go together the way the detent sim builds it.
 *
 * Same standard as the pan/tilt head: the expected values below were produced by
 * running the sim's own matrix code, not by re-deriving the chain here. If this
 * file and that page ever disagree, this file is wrong.
 *
 * Model space: +X down the beam toward the target, +Y up, +Z lateral, origin ON
 * THE UPPER MIRROR, which is where the beam leaves.
 */

/** Unit vector, for comparing directions without caring about length. */
function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function near(got: readonly number[], want: readonly number[], digits = 4) {
  for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(want[k]!, digits);
}

describe("the axis change is a rotation, not a reflection", () => {
  it("keeps a right handed basis right handed", () => {
    /*
     * This is the one that matters for the renderer rather than for the eye. The
     * cull decides a front face from the sign of a screen space area, so a
     * reflection anywhere in the chain turns every part inside out: near faces
     * vanish and the far wall of each solid is what gets drawn. Negating one axis
     * to make the lateral sense agree with the target view would do exactly that.
     */
    const ex = toModel([1, 0, 0], 1, false);
    const ey = toModel([0, 1, 0], 1, false);
    const ez = toModel([0, 0, 1], 1, false);
    const det =
      ex[0] * (ey[1] * ez[2] - ey[2] * ez[1]) -
      ex[1] * (ey[0] * ez[2] - ey[2] * ez[0]) +
      ex[2] * (ey[0] * ez[1] - ey[1] * ez[0]);
    expect(det).toBeCloseTo(1, 9);
  });

  it("sends the sim's exit direction down this view's beam axis", () => {
    /* The sim throws along +Y. Here the target is at +X. */
    near(toModel([0, 1, 0], 1, false), [1, 0, 0]);
    /* The sim is Z up. So is this, after the permutation. */
    near(toModel([0, 0, 1], 1, false), [0, 1, 0]);
  });
});

describe("agrees with the detent sim, landmark for landmark", () => {
  /*
   * Computed by running the sim's own m4 chain at t1 = t2 = 0, then permuted into
   * model space. Sim values, before the permutation, were:
   *
   *   hub1 origin (0, -21, 14.4)      hub2 origin (-21, 0, 37.2)
   *   mirror1 origin (2.12132, 0, 12.27868)   normal (-0.707107, 0, 0.707107)
   *   mirror2 origin (0, -2.12132, 39.32132)  normal (0, 0.707107, -0.707107)
   */
  const p = placeDetent(0, 0, 1);

  it("parks the hubs on their motor shafts", () => {
    near(applyPlacement(p.hub1, [0, 0, 0]), toModel([0, -21, 14.4], 1, true));
    near(applyPlacement(p.hub2, [0, 0, 0]), toModel([-21, 0, 37.2], 1, true));
  });

  it("seats the mirrors in the hub pockets", () => {
    near(applyPlacement(p.mirror1, [0, 0, 0]), toModel([2.12132, 0, 12.27868], 1, true));
    near(applyPlacement(p.mirror2, [0, 0, 0]), toModel([0, -2.12132, 39.32132], 1, true));
  });

  it("gives each mirror the normal the optical model reflects about", () => {
    /*
     * The strongest check in this file. The sim's ray tracer reflects about
     * M.n1 = norm(-1, 0, 1) and M.n2 = norm(0, 1, -1); those constants live in a
     * completely different part of that page from the placement matrices. If the
     * mirror the eye sees has the normal the maths uses, the whole chain is right.
     * The mirror mesh is 20 x 20 x 3 with its face on local z, so its own +z is
     * the normal.
     */
    const s = Math.SQRT1_2;
    near(unit(p.mirror1.ez), toModel([-s, 0, s], 1, false));
    near(unit(p.mirror2.ez), toModel([0, s, -s], 1, false));
  });

  it("puts the motors a shaft offset off the optical axis", () => {
    near(applyPlacement(p.motorA, [0, 0, 0]), toModel([0, -DETENT.motorA, DETENT.h1], 1, true));
    near(applyPlacement(p.motorB, [0, 0, 0]), toModel([-DETENT.motorB, 0, H2], 1, true));
  });

  it("aims the module across the rig, at the lower mirror", () => {
    /*
     * The module is modelled down its own local z, so the placement's ez is where
     * it points. It fires along the sim's +X, which is lateral here: this rig's
     * source does not face the wall, it faces the first mirror.
     */
    near(unit(p.laser.ez), toModel([1, 0, 0], 1, false));
    /* Its far face is laserLen back from the lens position. */
    const tail = applyPlacement(p.laser, [0, 0, 0]);
    near(tail, toModel([DETENT.laserX - DETENT.laserLen, 0, DETENT.h1], 1, true));
  });
});

describe("the folded path", () => {
  const b = beamPath(1);

  it("leaves the upper mirror at the model origin", () => {
    /* The exit point is the origin, the way the head's bore is. Everything else on
     * the canvas measures the throw from here. */
    near(b.upper, [0, 0, 0]);
  });

  it("stacks the lower mirror one separation below it", () => {
    near(b.lower, [0, -DETENT.sep, 0]);
    expect(b.upper[1] - b.lower[1]).toBeCloseTo(DETENT.sep, 6);
  });

  it("runs the first leg laterally, not along the throw", () => {
    /*
     * This is what the old schematic got wrong. Lens to lower mirror must be a
     * purely lateral move at constant height: if it has any component along +X the
     * rig is being drawn unfolded again.
     */
    const d: V3 = [b.lower[0] - b.lens[0], b.lower[1] - b.lens[1], b.lower[2] - b.lens[2]];
    expect(d[0]).toBeCloseTo(0, 6);
    expect(d[1]).toBeCloseTo(0, 6);
    expect(Math.abs(d[2])).toBeCloseTo(Math.abs(DETENT.laserX), 6);
  });

  it("runs the second leg straight up", () => {
    const d: V3 = [b.upper[0] - b.lower[0], b.upper[1] - b.lower[1], b.upper[2] - b.lower[2]];
    expect(d[0]).toBeCloseTo(0, 6);
    expect(d[2]).toBeCloseTo(0, 6);
    expect(d[1]).toBeCloseTo(DETENT.sep, 6);
  });
});

describe("the joints turn the right parts", () => {
  it("turns each hub with its own axis and leaves the other alone", () => {
    const a = placeDetent(0, 0, 1);
    const b = placeDetent(0.3, 0, 1);
    /*
     * Off the shaft, deliberately. The hub's local +z IS its axis of rotation, so
     * a probe at (0, 0, anything) is a fixed point of the very turn this is trying
     * to observe and the test would pass on a hub that never moved at all.
     */
    const probe: V3 = [5, 0, 10];
    /* Axis one moved. */
    const h1a = applyPlacement(a.hub1, probe);
    const h1b = applyPlacement(b.hub1, probe);
    expect(Math.hypot(h1b[0] - h1a[0], h1b[1] - h1a[1], h1b[2] - h1a[2])).toBeGreaterThan(0.5);
    /* Axis two did not. */
    const h2a = applyPlacement(a.hub2, probe);
    const h2b = applyPlacement(b.hub2, probe);
    near(h2b, h2a, 9);
  });

  it("keeps each hub on its own shaft however far it turns", () => {
    /*
     * A hub that wanders off its shaft is a hub drawn about the wrong centre, and
     * the mirror then sweeps a cone instead of spinning in place.
     */
    const want1 = toModel([0, -DETENT.seat, DETENT.h1], 1, true);
    const want2 = toModel([-DETENT.seat, 0, H2], 1, true);
    for (const t of [-0.9, -0.2, 0, 0.4, 1.1]) {
      near(applyPlacement(placeDetent(t, 0, 1).hub1, [0, 0, 0]), want1);
      near(applyPlacement(placeDetent(0, t, 1).hub2, [0, 0, 0]), want2);
    }
  });

  it("never moves the motors, whatever the mirrors do", () => {
    const a = placeDetent(0, 0, 1);
    const b = placeDetent(1.2, -0.8, 1);
    near(applyPlacement(b.motorA, [1, 2, 3]), applyPlacement(a.motorA, [1, 2, 3]), 9);
    near(applyPlacement(b.motorB, [1, 2, 3]), applyPlacement(a.motorB, [1, 2, 3]), 9);
    near(applyPlacement(b.laser, [1, 2, 3]), applyPlacement(a.laser, [1, 2, 3]), 9);
  });
});

describe("scale is uniform", () => {
  it("does not stretch a part when the view shrinks the rig", () => {
    const s = 0.42;
    const p = placeDetent(0.5, -0.3, s);
    for (const part of [p.motorA, p.motorB, p.laser, p.hub1, p.hub2, p.mirror1, p.mirror2]) {
      for (const ax of [part.ex, part.ey, part.ez]) {
        expect(Math.hypot(ax[0], ax[1], ax[2])).toBeCloseTo(s, 9);
      }
    }
  });
});

describe("the framing box tracks the part it frames", () => {
  it("still matches the body the packer emitted", async () => {
    /*
     * CHASSIS_BOX is copied rather than derived, because the camera needs it before
     * the mesh has inflated. That copy is the risk: a re-export of the body with a
     * different envelope would leave the view framing a shape that is no longer
     * there, and nothing on screen would say so.
     */
    const { DETENT_MESH } = await import("./detent-meshes.js");
    const { CHASSIS_BOX } = await import("./detent-assembly.js");
    near(CHASSIS_BOX.lo, DETENT_MESH.chassis.lo, 6);
    near(CHASSIS_BOX.span, DETENT_MESH.chassis.span, 6);
  });
});
