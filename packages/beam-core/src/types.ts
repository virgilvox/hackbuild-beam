/*
 * The types that let one planner drive two machines.
 *
 * The whole design rests on one claim, proved in geometry/gimbal.ts: a servo
 * pan/tilt head and a two mirror stepper scanner are the same geometric model
 * with different parameters. What genuinely differs is four things, and all four
 * live behind MachineProfile:
 *
 *   axis unit      pulse microseconds vs half steps
 *   geometry       throw plus mount height vs throw plus mirror separation
 *   error model    deadband/frame/lag/dither vs backlash/ramp/pull-out/settle
 *   mapping        four corner bilinear vs four corner projective homography
 *
 * The planner works in generic axis units and time and never learns which is
 * which. Sources never knew in the first place. Link only cares which packet
 * formats the board negotiated.
 */

/** A point on the target plane, millimetres, y up, origin at the field centre. */
export interface Point {
  x: number;
  y: number;
}

/** A commanded pair in whatever units this machine's axes count in. */
export interface AxisPair {
  a: number;
  b: number;
}

/**
 * What one axis can be told to do.
 *
 * `quantum` is the physical floor, not a preference. On the servo rig it is one
 * microsecond of pulse, about 0.24 mm on a 305 mm target, against a deadband of
 * roughly 1.91 mm: the command chain is eight times finer than the actuator,
 * which is why dither is worth having. On the stepper rig it is one half step,
 * about 0.55 mm, and there is nothing finer to reach for because ULN2003 has no
 * current control. That asymmetry is why subQuantum is a per-profile answer and
 * not a planner feature.
 */
export interface AxisUnit {
  /** Wire and log label. "us" or "halfstep". */
  readonly name: string;
  /** Smallest commandable increment, in axis units. Always 1 today; kept explicit. */
  readonly quantum: number;
  readonly min: number;
  readonly max: number;
  /** How this machine gets below its own quantum, if it can. */
  readonly subQuantum: "dither" | "none";
}

/**
 * Overrun semantics. A servo that is asked for more than it can do lags and
 * catches up; the drawing is soft but it is still the drawing. A stepper that is
 * asked for more than its pull-out rate loses sync, and every step after that
 * point is in the wrong place with no way to know. The planner treats the second
 * case with a margin.
 */
export type OverrunMode = "degrades" | "destroys";

export interface AxisLimits {
  /** Axis units per second. */
  readonly maxRate: number;
  /** Axis units per second squared. */
  readonly maxAccel: number;
  readonly overrun: OverrunMode;
  /**
   * Fraction of maxRate the planner is allowed to ask for. 1.0 where overrun
   * degrades. On the stepper rig the bench rule is 70 percent of the measured
   * stall rate, because the first rate whose blink comes back somewhere else is
   * already past pull-out and the geometry from that point on is gone.
   */
  readonly derate: number;
}

/**
 * What this KIND OF MACHINE can do, and therefore what the app is allowed to show.
 * Panels gate on these, so connecting decides the UI rather than the user picking a
 * mode. Whole panels gate, never individual controls inside one: a half-populated
 * panel reads as a bug.
 *
 * These are intrinsic to the hardware. What a particular BOARD negotiated on the
 * wire (segments, binary level, hermite, the planned bit, the tick rate) is a
 * different question with a different answer per board and per firmware revision,
 * and it lives in `WireCaps` in the protocol layer.
 *
 * Keeping the two apart is not pedantry. They were one type for a while, and the
 * SDK's `Peer` silently picked up the wrong one: it had `dither` where it needed
 * `tick`, and it compiled, because both were called `Capabilities`.
 */
export interface MachineCapabilities {
  /** Four corner capture is offered. Both rigs. */
  corners: boolean;
  /** Board stores a solved mapping itself, so a reconnect keeps it. */
  mappingOnBoard: boolean;
  /** Servo pulse window is settable. */
  pulseWindow: boolean;
  /** Symmetric sub-deadband dither is available. */
  dither: boolean;
  /** Backlash take-up is applied by the board. */
  backlash: boolean;
  /** Coils can be released when idle so the motors do not cook. */
  coilRelease: boolean;
  /** Has a pull-out rate worth hunting for. */
  pullOut: boolean;
  /**
   * Setting the planned bit bypasses the board's own reversal ramp.
   *
   * This is a safety flag, not an optimisation note. That ramp is what stops a full
   * rate reversal, and a full rate reversal is exactly where a stepper skips. The
   * bench measured the inter-step gap going from 23 ticks cruising to 41 post-turn
   * with no host plan; with the planned bit set that protection is gone and the host
   * owns corner deceleration completely.
   *
   * Where this is true, a planner bug is not a slow corner, it is skipped steps, and
   * a skipped step is geometry that is silently gone with no way to detect it.
   */
  firmwareRampBypassed: boolean;
  /** Per axis phase advance in milliseconds. */
  lead: boolean;
}

/**
 * The physical model. One gimbal, two parameter sets. See geometry/gimbal.ts for
 * why this is one model and not two.
 *
 *   throwMm  first pivot to the target plane along the beam axis
 *   sepMm    first pivot to second pivot. 0 on a pan/tilt head, where both
 *            rotations happen about one point
 *   vOffMm   vertical offset of the target centre above the head. 0 on a rig
 *            whose beam axis already passes through the field centre
 */
export interface GimbalGeometry {
  throwMm: number;
  sepMm: number;
  vOffMm: number;
}

/**
 * The simulator's view of the machine. One signature, two implementations: a
 * servo answers with deadband, frame latching, proportional-then-flat-out lag and
 * gear slop; a stepper answers with backlash hysteresis, a reversal ramp, coil
 * settle after an idle release, and silence past pull-out.
 *
 * The preview is only worth looking at if it replays this rather than the ideal
 * path. Both projects learned that separately.
 */
export interface ActuatorModel {
  reset(a: number, b: number): void;
  /** Advance dt seconds toward the commanded pair; return where the machine is. */
  step(dt: number, cmdA: number, cmdB: number): AxisPair;
}

/** An active four corner correction, in whichever form this profile solves. */
export interface Calibration {
  readonly kind: "bilinear" | "homography";
  /** Target mm to axis angle pair, radians. */
  forward(p: Point): { t1: number; t2: number };
  /** Axis angle pair back to target mm. Null where the inverse does not converge. */
  inverse(t1: number, t2: number): Point | null;
}

export interface MachineProfile {
  readonly id: string;
  readonly label: string;

  readonly geometry: GimbalGeometry;

  /**
   * A mirror deflects the beam by twice its own rotation; a servo horn carries
   * the whole head so the axis angle is the beam angle. 2 or 1, and it is the
   * entire difference between the two rigs below the geometry.
   */
  readonly beamAnglePerAxisAngle: number;

  readonly axis: { a: AxisUnit; b: AxisUnit };
  readonly limits: AxisLimits;
  readonly caps: MachineCapabilities;

  /** Axis units to target mm. Unrounded. */
  forward(pair: AxisPair, cal?: Calibration | null): Point;
  /** Target mm to axis units. Unrounded: velocities need the map's slope, not its nearest step. */
  inverse(p: Point, cal?: Calibration | null): AxisPair;

  /**
   * Local sensitivity in axis units per millimetre between two nearby points,
   * taken on the busier axis rather than as a norm, and evaluated through
   * whatever calibration is active so the measured quad participates in the speed
   * limits and not only in the aiming.
   *
   * This is a secant gain, evaluated at both endpoints, not an analytic Jacobian
   * and not a global constant. Both maps are non-linear on both legs, so a single
   * global figure is wrong everywhere except where it was sampled.
   */
  sensitivity(from: Point, to: Point, cal?: Calibration | null): number;

  /**
   * Arc length of an axis-space move, in axis units.
   *
   * Linf on both machines, and that is not a simplification: for a stepper it is
   * exactly the Bresenham dominant axis count, which IS the segment's cost in
   * ticks, and for a servo it is the busier axis, which is the one whose limit
   * binds. The planner's distance term and the hardware's are the same number.
   */
  arcLength(from: AxisPair, to: AxisPair): number;

  /**
   * How finely to sample the path in millimetres near this point.
   *
   * A stepper answers with one quantum, and the non-linearity problem then
   * disappears by brute force: consecutive commands are one step apart and the
   * board draws a straight line in step space between them, so the map is
   * effectively re-projected at every step. A servo answers with a fraction of its
   * deadband, because its command chain is far finer than its actuator and the
   * point is not to throw detail away before the planner sees it.
   */
  sampleStepMm(near: Point, cal?: Calibration | null): number;

  /**
   * Snap an axis pair onto what can actually be commanded.
   *
   * Integer axis endpoints are the physical floor. Where a machine has a
   * sub-quantum strategy it lives here and nowhere else.
   */
  quantise(pair: AxisPair): AxisPair;

  actuator(): ActuatorModel;

  /**
   * Axis units to add in the direction of travel, to cancel the actuator's own
   * directional bias. Zero when the machine has none worth cancelling.
   *
   * A servo deadband is hysteresis, not a grid: the inner loop switches the motor
   * off once the error falls inside the band, so approaching a target from below
   * leaves the shaft a whole deadband short and approaching from above leaves it a
   * whole deadband past. The miss is therefore not noise. It is a known, signed
   * quantity that depends only on which way the axis is moving, which means it can
   * simply be subtracted rather than averaged away.
   *
   * That is what a machine tool calls backlash compensation, and it is worth far
   * more here than dither is: on a 58 mm cap line it takes the ninetieth percentile
   * from 6.56 mm to 0.91 mm, where dither alone reaches 1.70. Dither is a
   * statistical fix that adds motion and hopes the mechanics average it out, and it
   * costs a permanently hunting servo to get it. This is deterministic and free.
   *
   * The two do not stack. Compensation leaves the command already correct, so
   * dither on top of it is just noise: measured together they are worse than
   * compensation alone.
   */
  readonly backlashAxis: number;

  /**
   * Does this profile describe the board that just said hello? Selection happens
   * from the hello line plus the config dump, never from a dropdown, because a
   * wrong profile aims a live beam through the wrong map.
   */
  matches(hello: string, config: Readonly<Record<string, string>>): boolean;
}
