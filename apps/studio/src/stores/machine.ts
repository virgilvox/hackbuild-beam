import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import {
  createDetent28byj,
  createWasherServo,
  createHomographyCalibration,
  solveHomography,
  quadAspect,
  type Calibration,
  type MachineProfile,
  type Point,
} from "@virgilvox/beam-core";

/**
 * The machine: which one is on the other end, how it is installed, and where it is
 * pointing.
 *
 * The profile is never chosen from a dropdown while connected. It comes from the
 * board's own hello line and config dump, because a wrong profile aims a live beam
 * through the wrong map. The only time the user picks is in simulator mode, where
 * there is no board to ask.
 */
export const useMachine = defineStore("machine", () => {
  /* shallowRef: the profile is a frozen object graph with methods, and making it
   * deeply reactive would both cost and break identity comparisons. */
  const profile = shallowRef<MachineProfile | null>(null);

  /** Raw key/value config as adopted from the board. The board is the authority. */
  const config = ref<Record<string, string>>({});
  const adopted = ref(false);

  /** Live position in axis units, as last reported. */
  const axis = ref({ a: 0, b: 0 });
  const beamOn = ref(false);
  const queueFree = ref(-1);

  /* Installation. Mirrors what the board stores, and is pushed back explicitly. */
  const throwMm = ref(150);
  const sepMm = ref(22);
  const mountHMm = ref(70);
  const fieldW = ref(120);
  const fieldH = ref(120);

  const invA = ref(false);
  const invB = ref(false);
  const invertChecked = ref(false);
  /* Off by default, as the firmware ships: it holds both servos hunting, which is
   * constant buzzing and a lot more current than a servo that has settled. */
  const dither = ref(false);

  /*
   * Per axis lead, in milliseconds, and the drawing feed in millimetres a second.
   *
   * Both exist on the servo rig only, and both are the difference between legible
   * text and not. Measured on the bench model at a 40 mm cap height, worst of the
   * ninetieth percentile geometric error:
   *
   *   as shipped, feed unset, dither off      5.13 mm
   *   feed 40 mm/s, dither still off          5.58 mm     slowing down alone does nothing
   *   feed 40 mm/s, dither on, lead 3/1.5     1.47 mm
   *
   * The middle row is the whole point. A servo deadband is hysteresis, not
   * quantisation: the motor is simply off below some error, so it stops wherever it
   * got to. Going slower just sits inside the dead zone for longer. Dither breaks
   * the hysteresis with a symmetric carrier, but the mechanics need several servo
   * frames to average it out, so it only pays once the beam is crossing well under
   * one deadband per frame. Neither half works without the other.
   *
   * Zero feed means "no limit, use the profile's own default", which is what a rig
   * that does not need this gets.
   */
  const leadPanMs = ref(3);
  const leadTiltMs = ref(1.5);
  const feedMmS = ref(0);

  const limitsOn = ref(false);
  const limitsDerived = ref(false);
  const limits = ref({ minA: -2000, maxA: 2000, minB: -2000, maxB: 2000 });
  const persisted = ref(false);
  const originSet = ref(false);

  /* Four corner calibration. Corners are captured in axis units, TL TR BR BL. */
  const corners = ref<Array<[number, number] | null>>([null, null, null, null]);
  const calibration = shallowRef<Calibration | null>(null);
  const residualMm = ref<number | null>(null);
  const aspect = ref<number | null>(null);
  const calibrationOn = ref(true);

  const cornersCaptured = computed(() => corners.value.filter(Boolean).length);
  const mappingSolved = computed(() => calibration.value !== null);

  /** The calibration actually applied, honouring the enable toggle. */
  const activeCal = computed(() => (calibrationOn.value ? calibration.value : null));

  const caps = computed(() => profile.value?.caps ?? null);
  const axisUnit = computed(() => profile.value?.axis.a.name ?? "unit");

  /** Rebuild the profile from the current installation values. */
  function rebuildProfile(id: string) {
    profile.value =
      id === "washer-servo"
        ? createWasherServo({
            distMm: throwMm.value,
            wallW: fieldW.value,
            wallH: fieldH.value,
            mountH: mountHMm.value,
            invA: invA.value,
            invB: invB.value,
            dither: dither.value,
          })
        : createDetent28byj({
            throwMm: throwMm.value,
            sepMm: sepMm.value,
            fieldW: fieldW.value,
            fieldH: fieldH.value,
            limitsOn: limitsOn.value,
            minA: limits.value.minA,
            maxA: limits.value.maxA,
            minB: limits.value.minB,
            maxB: limits.value.maxB,
          });
  }

  function setProfile(p: MachineProfile) {
    profile.value = p;
    throwMm.value = p.geometry.throwMm;
    sepMm.value = p.geometry.sepMm;
  }

  function cornerMm(i: number): Point {
    const w = fieldW.value / 2;
    const h = fieldH.value / 2;
    return [
      { x: -w, y: h },
      { x: w, y: h },
      { x: w, y: -h },
      { x: -w, y: -h },
    ][i]!;
  }

  function captureCorner(i: number) {
    /* Replace rather than mutate: the canvas watches by identity, because deep
     * watching an array of thousands of plotted points is what made the preview
     * crawl. A capture that does not change the reference would never repaint. */
    const next = corners.value.slice();
    next[i] = [axis.value.a, axis.value.b];
    corners.value = next;
    /* Re-solving on every capture would produce a map from a partial quad, which is
     * worse than no map because it looks like progress. Wait for all four. */
    if (cornersCaptured.value === 4) solve();
  }

  function clearCalibration() {
    corners.value = [null, null, null, null];
    calibration.value = null;
    residualMm.value = null;
    aspect.value = null;
  }

  /**
   * Solve the four corner map.
   *
   * The fit is millimetres to tangent space, not to axis units, which is what makes
   * four points enough: in tangent space the ideal model is near linear in target
   * millimetres, so a real installation's rotation, keystone and wrong throw all
   * show up as a projective distortion a homography absorbs exactly.
   */
  function solve(): { ok: boolean; message: string } {
    const p = profile.value;
    if (!p) return { ok: false, message: "no machine" };
    if (cornersCaptured.value < 4) return { ok: false, message: "capture all four corners first" };

    const corr = corners.value.map((c, i) => {
      const mm = cornerMm(i);
      /* Where the machine actually had to point, expressed in tangent space. Going
       * through the profile's own forward map keeps this correct for both rigs
       * without the app knowing which units the corner was captured in. */
      const at = p.forward({ a: c![0], b: c![1] });
      const ang = pointToTangent(p, at);
      return { mm, uv: ang };
    });

    const h = solveHomography(corr);
    if (!h) {
      clearCalibration();
      return { ok: false, message: "corners are collinear or degenerate, recapture them" };
    }

    calibration.value = createHomographyCalibration(h);
    aspect.value = quadAspect(corr.map((c) => c.uv));

    /* The honest check: push each corner back through the solved map and see how far
     * it lands from where it was actually measured, in millimetres on the target. */
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const want = corners.value[i]!;
      const got = p.quantise(p.inverse(cornerMm(i), calibration.value));
      const a = p.forward(got, calibration.value);
      const b = p.forward({ a: want[0], b: want[1] }, calibration.value);
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
    }
    residualMm.value = worst;

    return {
      ok: true,
      message: `mapping solved, corner residual ${worst.toFixed(3)} mm`,
    };
  }

  /** Derive soft limits from the captured corners, with a small outward margin. */
  function limitsFromCorners(margin = 4): boolean {
    if (cornersCaptured.value < 4) return false;
    const xs = corners.value.map((c) => c![0]);
    const ys = corners.value.map((c) => c![1]);
    limits.value = {
      minA: Math.min(...xs) - margin,
      maxA: Math.max(...xs) + margin,
      minB: Math.min(...ys) - margin,
      maxB: Math.max(...ys) + margin,
    };
    limitsDerived.value = true;
    limitsOn.value = true;
    return true;
  }

  return {
    profile, config, adopted, axis, beamOn, queueFree,
    throwMm, sepMm, mountHMm, fieldW, fieldH,
    invA, invB, invertChecked, dither, leadPanMs, leadTiltMs, feedMmS,
    limitsOn, limitsDerived, limits, persisted, originSet,
    corners, calibration, residualMm, aspect, calibrationOn,
    cornersCaptured, mappingSolved, activeCal, caps, axisUnit,
    rebuildProfile, setProfile, cornerMm, captureCorner, clearCalibration, solve, limitsFromCorners,
  };
});

/**
 * A target point expressed in the tangent space the calibration is fitted in.
 *
 * Deliberately routed through the profile's own ideal map rather than reimplemented
 * here, so the app never has to know whether it is holding microseconds or steps.
 */
function pointToTangent(p: MachineProfile, at: Point): { u: number; v: number } {
  const g = p.geometry;
  const throwMm = Math.max(g.throwMm, 40);
  const u = at.x / (throwMm + g.sepMm);
  const cosT1 = 1 / Math.sqrt(1 + u * u);
  const v = ((at.y + g.vOffMm) * cosT1) / throwMm;
  return { u, v };
}
