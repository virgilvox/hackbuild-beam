/*
 * The planner's tuning constants, with the reasons they are what they are.
 *
 * Every number here was paid for on a bench and most of them are not obvious, so
 * the paragraph travels with the constant. Ported from laser-rig.html, which is the
 * more evolved of the two planners, and reconciled with detent-plot.html where the
 * stepper rig disagrees.
 *
 * These are DEFAULTS. Anything a caller can sensibly change is a plan option; what
 * lives here is either a shape constant of the algorithm or a starting point.
 */

/**
 * Defaults for the numbers an operator can move.
 *
 * The comments are the originals'. They are the difference between a knob that gets
 * turned back to where it was and a knob nobody dares touch.
 */
export const PLAN_DEFAULTS = {
  /**
   * mm/s while the beam is on: fast enough that both servos clear their deadbands
   * every frame, which is the smooth regime for two coupled hysteresis axes.
   */
  feedMmS: 260,
  /** mm/s while it is off. */
  travelMmS: 400,
  /**
   * mm/s^2. A safety ceiling on top of the machine's own acceleration limit, not the
   * limit itself. Left low it masks the machine entirely: both a 9g servo and a
   * digital one would plan the same job, because the slider would be binding before
   * either servo did.
   */
  accelMmS2: 8000,
  /**
   * Fillet radius, mm. 0 keeps corners sharp.
   *
   * Small on purpose: rounding corners existed to stop the beam having to halt at
   * every vertex, and the junction and curvature limits do that job without altering
   * the drawing. At a 37 mm cap height a 0.8 mm fillet visibly softens the corners of
   * K, M and W, which is precision the plot was giving away and hand drawing was not.
   */
  cornerMm: 0.3,
  /** Junction deviation, mm: how far off a corner the planner may cut for speed. */
  junctionDeviationMm: 0.18,
  /**
   * Path tolerance, mm. How far the beam may stray from the ideal shape anywhere in
   * the chain. Everything geometric derives from this rather than from its own
   * hardcoded step: curves are flattened until they are within it. Both were
   * fixed-rate before, which spends detail evenly and is exactly wrong: a straight
   * run needs almost none and a tight curve needs a great deal.
   */
  tolMm: 0.05,
  /**
   * Seconds over which acceleration is allowed to build. Gear slop in a cheap servo
   * turns an instant acceleration step into a knock, so the profile is smoothed over
   * this long.
   */
  jerkSec: 0.045,
  /**
   * ms of rest before the beam lights after a reposition.
   *
   * Zero by default: each dwell forces a full stop, and with the firmware
   * interpolating a smooth position stream the servo is not ringing hard enough to
   * need one. Raise it if stroke starts look ragged on your particular servos.
   */
  settleMs: 0,
  /** Live speed override. Scales timeline spans, never the geometry. See INV-85. */
  speed: 1,
} as const;

/**
 * mm between planner samples.
 *
 * Finer than the servo can resolve on purpose: the profile is only as good as the
 * geometry it is integrated over, and text has detail well under a millimetre. The
 * actual step used is the finer of this and the machine's own sampleStepMm, so a
 * stepper still gets sampled below one half step and the integer dedupe in
 * planner/guards.ts is what makes that safe.
 */
export const DENSE_MM = 0.25;

/**
 * Of the machine's acceleration budget to each of tangential and centripetal, so
 * their vector sum stays inside it.
 *
 * Tangential and centripetal acceleration add as vectors, so spending the whole
 * budget on each separately lets their sum reach 1.4 times the machine's limit on a
 * curve taken at speed. Split the budget instead.
 */
export const ACC_SHARE = 0.7;

/**
 * Most of a short segment a fillet may eat. Lower than the original 0.45 so
 * letterforms keep their corners.
 */
export const CORNER_FRAC = 0.28;

/** mm: endpoints closer than this are the same point, and the strokes merge. */
export const JOINTOL_MM = 0.35;

/** mm: travels shorter than this need no rest before the beam lights again. */
export const SETTLE_AFTER_MM = 5;

/** A turn sharper than this is a corner, not a curve, and must not be smoothed. */
export const CORNER_DEG = 70;

/** mm a vertex may sit off the line before it counts as a real vertex. */
export const FLAT_TOL_MM = 0.02;

/**
 * mm below which two consecutive vertices are the same point.
 *
 * A stroke list from a font, an SVG sampler or a merge can leave hops of a few
 * microns between vertices, and a hop that short still has a direction, so the
 * junction rule sees a sharp corner and brings the beam to a stop for no reason
 * anyone could see.
 */
export const DEDUPE_EPS_MM = 0.02;

/** Seconds a lone dot is held with the beam lit. */
export const DOT_HOLD_SEC = 0.06;

/**
 * The junction floor for a machine that has a pull-in rate, in axis units per second.
 *
 * THIS IS THE ONE PLACE THE TWO RIGS GENUINELY DISAGREE about junctions, which is
 * why it is a profile-supplied default and not a shared constant.
 *
 * A servo decelerates to zero at a reversal, and it should: the gear slop is taken
 * up as an audible knock, and arriving at the reversal with speed on is what makes
 * the knock loud. Its floor is zero.
 *
 * A stepper is the opposite. It has a pull-in rate, the rate it can start from
 * standstill without losing sync, and below that there is nothing left to gain by
 * slowing down: the motor is already inside the regime where a step either lands or
 * does not, and the extra time is spent for no accuracy. detent-plot.html carries
 * this as `const vFloor = 120; // safe pull-in rate from standstill` and applies it
 * as the corner speed at a full reversal as well as the speed at both ends of the
 * job.
 *
 * The floor is clamped to the segment cap wherever it is applied, so a slow segment
 * is never sped up to meet it.
 */
export const JUNCTION_FLOOR_PULL_IN = 120;

/**
 * Sane bounds for the operator-settable numbers.
 *
 * The planner divides by feeds and integrates over accelerations, so an infinite or
 * zero feed is a timeline of zero duration or one that never advances. Clamping at
 * the edge of the API is cheaper than defending every arithmetic site downstream.
 */
export const OPTION_BOUNDS = {
  feedMmS: [0.01, 100_000],
  accelMmS2: [1, 10_000_000],
  axisRate: [0.01, 10_000_000],
  denseMm: [0.001, 50],
  tolMm: [0.0001, 10],
} as const;
