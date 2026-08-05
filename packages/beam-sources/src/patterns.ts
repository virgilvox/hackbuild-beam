/*
 * CALIBRATION PATTERNS.
 *
 * These are not drawings. Each one is a measurement you take with a ruler against
 * the target, and the geometry exists to make one specific number readable. Where a
 * pattern looks redundant it is because the redundancy is the measurement: the lash
 * gauge draws the same line twice because the whole point is the gap between the two
 * copies.
 *
 * Everything here is in target millimetres, y up, centred on the origin, at final
 * size. Calibration patterns deliberately do NOT go through `centerFit` and
 * `scaleToField`: a ruler whose tick spacing has been normalised away measures
 * nothing.
 */

import type { SourceResult, Stroke } from "./index.js";
import { bboxOf, toPoints } from "./ops.js";

/**
 * Patterns cover 60 percent of the field, not all of it.
 *
 * The edges are where the mapping is least trustworthy and where a rig that is
 * slightly off-square runs out of travel. A gauge you cannot draw is not a
 * measurement, so the gauge stays where the geometry is well behaved.
 */
export const PATTERN_FIELD_FRACTION = 0.6;

export interface FieldSize {
  /** Drawable field width on the target, millimetres. */
  widthMm: number;
  /** Drawable field height on the target, millimetres. */
  heightMm: number;
}

function result(strokes: Stroke[]): SourceResult {
  return { strokes, bbox: bboxOf(strokes) };
}

/**
 * BACKLASH GAUGE.
 *
 * Four horizontal lines in two groups. The upper pair at y = +6 and y = -6 is the
 * same line traced left to right and then right to left, drawn far enough apart to
 * be read separately: what you measure is that each one lands where it should. The
 * lower pair at y = +14 is the same line traced both ways ON TOP OF ITSELF, and the
 * gap you can see between those two is the mechanical slack, directly, in
 * millimetres, with no arithmetic.
 *
 * Every servo has gear backlash and every geared stepper has more of it. It shows up
 * as a retraced line missing its own path, which is invisible in a design and
 * obvious here.
 */
export function lashGauge(field: FieldSize): SourceResult {
  const w = field.widthMm * PATTERN_FIELD_FRACTION;
  const x = w / 2;
  return result([
    toPoints([
      [-x, 6],
      [x, 6],
    ]),
    toPoints([
      [x, -6],
      [-x, -6],
    ]),
    toPoints([
      [-x, 14],
      [x, 14],
    ]),
    toPoints([
      [x, 14],
      [-x, 14],
    ]),
  ]);
}

/**
 * Tick offsets, in commandable steps, measured from the left end of the baseline.
 *
 * Cumulative, not absolute: the ticks land at 1, 3, 8, 18, 38 and 88 steps out. That
 * spread is deliberate. The first two ticks show whether single-step resolution is
 * visible at all on this throw, and the last two are far enough apart to measure with
 * a ruler, so one drawing answers both "can I see one step" and "is my scale right".
 */
export const RULER_MARKS: readonly number[] = [1, 2, 5, 10, 20, 50];

/** Tick height, millimetres. Tall enough to read, short enough not to look like the design. */
const RULER_TICK_MM = 8;

/**
 * RULER.
 *
 * A baseline plus ticks at cumulative step offsets, so single-step resolution is
 * directly visible on the target rather than inferred from a number in the UI.
 *
 * `stepMm` is what one commandable increment is worth on the target: a servo
 * microsecond or a stepper half step, whichever this machine counts in.
 */
export function ruler(field: FieldSize, stepMm: number): SourceResult {
  const w = field.widthMm * PATTERN_FIELD_FRACTION;
  const strokes: Stroke[] = [
    toPoints([
      [-w / 2, 0],
      [w / 2, 0],
    ]),
  ];
  let x = -w / 2;
  for (const m of RULER_MARKS) {
    x += m * stepMm;
    strokes.push(
      toPoints([
        [x, 0],
        [x, RULER_TICK_MM],
      ]),
    );
  }
  return result(strokes);
}

/**
 * SQUARE WITH BOTH DIAGONALS.
 *
 * The square finds scale and squareness; the two diagonals find everything else. A
 * mapping error that leaves all four sides looking straight still bows the
 * diagonals, because they are the only lines in the figure that cross the middle of
 * the field, and pincushion from an uncalibrated throw shows up there first.
 *
 * Both diagonals rather than one: a single diagonal cannot distinguish a bow from a
 * skew, and the pair crossing at the centre can.
 */
export function squareWithDiagonals(field: FieldSize): SourceResult {
  const w = field.widthMm * PATTERN_FIELD_FRACTION;
  const h = field.heightMm * PATTERN_FIELD_FRACTION;
  const x = w / 2;
  const y = h / 2;
  return result([
    toPoints([
      [-x, -y],
      [x, -y],
      [x, y],
      [-x, y],
      [-x, -y],
    ]),
    toPoints([
      [-x, -y],
      [x, y],
    ]),
    toPoints([
      [-x, y],
      [x, -y],
    ]),
  ]);
}

/** Rungs in the rate ramp. Eight is what fits legibly on a 300 mm target. */
export const RATE_RAMP_LINES = 8;

/**
 * RATE RAMP.
 *
 * A fan of equal length horizontal lines, drawn by the caller at rising rates, one
 * rate per line. Equal length matters: the lines are compared against each other, so
 * the only thing that may differ between them is the speed they were drawn at.
 *
 * On a stepper, the first line that comes back short or crooked is the first rate
 * past pull-out. On a servo nothing breaks, the lines just get rounder at the ends
 * as the lag grows, and that is the rate where the drawing stops being the drawing.
 */
export function rateRamp(field: FieldSize): SourceResult {
  const w = field.widthMm * PATTERN_FIELD_FRACTION;
  const h = field.heightMm * PATTERN_FIELD_FRACTION;
  const strokes: Stroke[] = [];
  for (let i = 0; i < RATE_RAMP_LINES; i++) {
    const y = -h / 2 + (h * i) / (RATE_RAMP_LINES - 1);
    strokes.push(
      toPoints([
        [-w / 2, y],
        [w / 2, y],
      ]),
    );
  }
  return result(strokes);
}

/* ------------------------------------------------------------------ stall hunt */

/**
 * One point of the stall hunt, in AXIS UNITS rather than millimetres.
 *
 * The hunt is the one diagnostic that deliberately bypasses the millimetre path.
 * INV-19: duration in whole milliseconds is the universal timing currency, and that
 * conversion is too coarse for a single step at a high rate, which is exactly the
 * regime the hunt operates in. So the hunt names its interval in ticks directly and
 * stays on the text command path.
 */
export interface HuntPoint {
  /** Axis A position, axis units. */
  a: number;
  /** Axis B position, axis units. */
  b: number;
  /** Beam gate. Off for the whole hunt: this is a motion test, not a drawing. */
  laser: boolean;
  /** Ticks between steps. The rate, expressed the way the board counts it. */
  intervalTicks: number;
}

/** Where the ramp starts. Slow enough that no unit stalls getting up to speed. */
export const HUNT_RAMP_START_RATE = 120;

/** Ramp length in steps, capped so a short leg still gets a third of itself to ramp in. */
export const HUNT_RAMP_STEPS = 60;

/**
 * The rate ladder, steps per second. Seven rungs from comfortably below anything
 * that stalls to comfortably above it, spaced so the answer lands between two rungs
 * you can tell apart by ear.
 */
export const HUNT_RATES: readonly number[] = [500, 650, 800, 950, 1100, 1300, 1500];

/** Leg length in steps. Long enough that a few lost steps are visible at the far end. */
export const HUNT_SPAN_STEPS = 240;

/**
 * Fraction of the last clean rate to actually run at.
 *
 * The first rate whose blink comes back somewhere else is already past pull-out, and
 * the geometry from that point on is gone with no way to detect it. Seventy percent
 * of the last clean rate is the bench rule, and it is the same number as the
 * profile's derate for the same reason.
 */
export const HUNT_SAFE_FRACTION = 0.7;

export type HuntAxis = "a" | "b";

/**
 * One leg of the hunt: a linear rate ramp from the slow start up to `rate`, a cruise,
 * and a symmetric ramp back down, one step at a time.
 *
 * The ramps are the control. Without them every leg would start with a step from
 * standstill straight to the test rate, which stalls a stepper at rates far below its
 * real pull-out and would make the hunt measure the acceleration limit instead. What
 * is under test is the CRUISE.
 *
 * Appends to `out` so a caller can build a there-and-back pass in one array.
 */
export function huntLeg(
  out: HuntPoint[],
  axis: HuntAxis,
  from: number,
  to: number,
  rate: number,
  tickHz: number,
): void {
  const dir = Math.sign(to - from);
  const total = Math.abs(to - from);
  const rampN = Math.min(HUNT_RAMP_STEPS, Math.floor(total / 3));
  for (let i = 1; i <= total; i++) {
    let v: number;
    if (rampN > 0 && i <= rampN) {
      v = HUNT_RAMP_START_RATE + (rate - HUNT_RAMP_START_RATE) * (i / rampN);
    } else if (rampN > 0 && i > total - rampN) {
      v = HUNT_RAMP_START_RATE + (rate - HUNT_RAMP_START_RATE) * ((total - i) / rampN);
    } else {
      v = rate;
    }
    const pos = from + dir * i;
    out.push({
      a: axis === "a" ? pos : 0,
      b: axis === "b" ? pos : 0,
      laser: false,
      /* Round, then floor at 1: a zero interval is a step every tick, which is
       * faster than any of these units can move and would wedge the ISR. */
      intervalTicks: Math.max(1, Math.round(tickHz / Math.max(1, v))),
    });
  }
}

/**
 * A full there-and-back pass on one axis at one rate, starting and ending at zero.
 *
 * Out and back is what makes the test readable without instruments: if the axis
 * returns to where it started, nothing was lost. The caller blinks the beam at home
 * before each pass so there is a mark on the wall to compare against.
 */
export function huntPass(axis: HuntAxis, rate: number, tickHz: number, span = HUNT_SPAN_STEPS): HuntPoint[] {
  const out: HuntPoint[] = [
    {
      a: 0,
      b: 0,
      laser: false,
      intervalTicks: Math.max(1, Math.round(tickHz / HUNT_RAMP_START_RATE)),
    },
  ];
  huntLeg(out, axis, 0, span, rate, tickHz);
  huntLeg(out, axis, span, 0, rate, tickHz);
  return out;
}

export interface HuntStep {
  axis: HuntAxis;
  rate: number;
  points: HuntPoint[];
}

/**
 * The whole hunt: both axes, every rung of the ladder, in order.
 *
 * Both axes separately rather than a diagonal, because the two axes have different
 * lever arms and therefore different loads, and a diagonal test reports whichever of
 * them is worse without saying which.
 */
export function stallHunt(tickHz: number, rates: readonly number[] = HUNT_RATES): HuntStep[] {
  const steps: HuntStep[] = [];
  for (const axis of ["a", "b"] as const) {
    for (const rate of rates) steps.push({ axis, rate, points: huntPass(axis, rate, tickHz) });
  }
  return steps;
}
