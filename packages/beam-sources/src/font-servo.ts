import type { FontMetrics, GlyphDef } from "./font.js";

/*
 * A face cut for a machine with a fixed absolute error.
 *
 * The servo rig misses by about the same number of millimetres wherever it is
 * pointing, because a servo deadband is an angle and the throw turns it into
 * roughly 1.9 mm on the target no matter what is being drawn. Measured on the
 * bench model with dither on and the feed down, the ninetieth percentile error
 * sits near 1.5 mm and barely moves whatever else is changed.
 *
 * So legibility is not a question of how accurate the machine is. It is a question
 * of how big the letters are, because the error is a fixed numerator and the cap
 * height is the denominator:
 *
 *   HACK.BUILD   10 characters   biggest cap that fits a 305 mm field   42 mm   3.9 %
 *   BEAM          4 characters                                          94 mm   1.9 %
 *   HB            2 characters                                         205 mm   0.7 %
 *
 * The field is fixed and the character count is the operator's. The one thing a
 * FONT controls is how much width each character costs, and width is what caps the
 * cap height on a line of text. That is the entire design brief here: every
 * millimetre of width saved is cap height bought back, and cap height is quality.
 *
 * Three rules, in order of how much they are worth:
 *
 *   1. NARROW. Advances are about 8 units against a 14 unit cap where the default
 *      face spends 10 to 13. A line of text is roughly a third shorter, so it fits
 *      at a cap height roughly a half larger, and the error as a fraction of the
 *      letter falls by about the same.
 *
 *   2. FEWER STROKES. Every pen down starts from rest and has to break out of the
 *      deadband before anything moves, so a stroke start is the worst part of a
 *      stroke. Where a letterform allows one continuous path it gets one: B, D, G,
 *      P and S are drawn as a single unbroken run here rather than a spine plus
 *      bowls. Where the topology forbids it, it does not: a letter with more than
 *      two odd valence junctions cannot be one stroke and pretending otherwise
 *      just means retracing, which on this machine is worse than lifting.
 *
 *   3. NO RETRACING. A retraced line misses itself by a deadband, because the
 *      deadband is hysteresis and the servo stops short on whichever side it
 *      approached from. Two lines a millimetre apart is what that looks like.
 *
 * What is deliberately NOT done: corners are left sharp. Measured, the error near a
 * sharp corner is 1.26 mm at the ninetieth percentile against 1.31 mm mid stroke,
 * so corners are already the best behaved part of the drawing and rounding them
 * would cost width and legibility for nothing.
 *
 * The metrics keep the default face's 14 unit cap so the two can be measured
 * against each other without a scale factor confusing the comparison.
 */

/** Same cap as the default face. Everything else is tighter. */
export const SERVO_METRICS: FontMetrics = {
  cap: 14,
  xHeight: 9,
  descender: -4.5,
  /* A word space is a whole character's width of nothing. On a face this narrow the
   * default face's 6 units reads as a gap between lines of text rather than words. */
  spaceAdvance: 4.5,
  lineGap: 7,
};

/*
 * Glyphs, on a 1 to 7 box against a 0 to 14 cap.
 *
 * A single stroke glyph below is written as one unbroken path on purpose. B is the
 * clearest example: spine up, top bowl out and back to the spine, lower bowl out
 * and back to the start. Every part is traversed exactly once and the pen never
 * lifts, where the conventional construction needs a lift and retraces the middle.
 */
export const SERVO_GLYPHS: Readonly<Record<string, GlyphDef>> = {
  " ": { advance: 4.5, d: "" },

  A: { advance: 8, d: "M1 0L4 14L7 0 M1.9 4.2L6.1 4.2" },
  /* One stroke, closed, nothing drawn twice. */
  B: { advance: 8, d: "M1 0L1 14Q6.9 14 6.9 10.6Q6.9 7.4 4 7.4L1 7.4Q6.9 7.4 6.9 3.7Q6.9 0 4 0L1 0" },
  C: { advance: 8, d: "M6.9 11Q6.9 14 4 14Q1 14 1 7Q1 0 4 0Q6.9 0 6.9 3" },
  D: { advance: 8, d: "M1 0L1 14L3.6 14Q7.2 14 7.2 7Q7.2 0 3.6 0L1 0" },
  E: { advance: 7.4, d: "M6.6 14L1 14L1 0L6.6 0 M1 7L5 7" },
  F: { advance: 7, d: "M6.6 14L1 14L1 0 M1 7L5 7" },
  G: { advance: 8.2, d: "M6.9 11Q6.9 14 4 14Q1 14 1 7Q1 0 4 0Q6.9 0 6.9 3.2L6.9 6L4.6 6" },
  H: { advance: 8, d: "M1 0L1 14 M7 0L7 14 M1 7L7 7" },
  I: { advance: 3.4, d: "M1.7 0L1.7 14" },
  J: { advance: 6.4, d: "M5 14L5 3.4Q5 0 2.9 0Q1 0 1 2.4" },
  /* Two strokes, not three: both arms meet the spine at one point, so the arm is
   * one unbroken run through the junction. */
  K: { advance: 8, d: "M1 0L1 14 M7 14L1 7L7 0" },
  L: { advance: 7, d: "M1 14L1 0L6.6 0" },
  M: { advance: 9.4, d: "M1 0L1 14L4.2 5L7.4 14L7.4 0" },
  N: { advance: 8.4, d: "M1 0L1 14L7 0L7 14" },
  O: { advance: 8.4, d: "M4 14Q1 14 1 7Q1 0 4 0Q7 0 7 7Q7 14 4 14" },
  P: { advance: 8, d: "M1 0L1 14L4 14Q6.9 14 6.9 10.5Q6.9 7 4 7L1 7" },
  Q: { advance: 8.4, d: "M4 14Q1 14 1 7Q1 0 4 0Q7 0 7 7Q7 14 4 14 M4.8 3.4L7.6 -0.6" },
  R: { advance: 8, d: "M1 0L1 14L4 14Q6.9 14 6.9 10.5Q6.9 7 4 7L1 7 M3.7 7L7 0" },
  S: { advance: 8, d: "M6.9 11.4Q6.9 14 3.9 14Q1 14 1 11.2Q1 8.4 3.9 7.5Q6.9 6.6 6.9 3.6Q6.9 0 3.9 0Q1 0 1 2.4" },
  T: { advance: 7.4, d: "M1 14L6.8 14 M3.9 14L3.9 0" },
  U: { advance: 8, d: "M1 14L1 3.8Q1 0 4 0Q7 0 7 3.8L7 14" },
  V: { advance: 7.6, d: "M1 14L3.8 0L6.6 14" },
  W: { advance: 10, d: "M1 14L2.9 0L4.9 9L6.9 0L8.8 14" },
  X: { advance: 8, d: "M1 14L7 0 M7 14L1 0" },
  Y: { advance: 7.8, d: "M1 14L3.9 7L6.8 14 M3.9 7L3.9 0" },
  Z: { advance: 7.8, d: "M1 14L6.8 14L1 0L6.8 0" },

  "0": { advance: 8, d: "M3.9 14Q1 14 1 7Q1 0 3.9 0Q6.8 0 6.8 7Q6.8 14 3.9 14" },
  "1": { advance: 5, d: "M1.4 11.6L3.4 14L3.4 0" },
  "2": { advance: 8, d: "M1 11.4Q1 14 3.9 14Q6.8 14 6.8 10.8Q6.8 8 1 0L6.8 0" },
  "3": { advance: 8, d: "M1 12.6Q1.6 14 3.9 14Q6.8 14 6.8 10.9Q6.8 7.8 3.6 7.8Q6.9 7.8 6.9 3.9Q6.9 0 3.9 0Q1.4 0 1 1.6" },
  "4": { advance: 8, d: "M5.4 0L5.4 14L1 4.4L7 4.4" },
  "5": { advance: 8, d: "M6.6 14L1.6 14L1.2 8.2Q2.4 9.4 4.2 9.4Q6.9 9.4 6.9 4.8Q6.9 0 3.9 0Q1.4 0 1 1.8" },
  "6": { advance: 8, d: "M6.4 12.4Q5.6 14 3.8 14Q1 14 1 6.6Q1 0 4 0Q6.9 0 6.9 4.2Q6.9 8 4 8Q1.4 8 1 5.4" },
  "7": { advance: 7.6, d: "M1 14L6.8 14L3 0" },
  "8": { advance: 8, d: "M3.9 7.6Q1 7.6 1 10.8Q1 14 3.9 14Q6.8 14 6.8 10.8Q6.8 7.6 3.9 7.6Q1 7.6 1 3.8Q1 0 3.9 0Q6.8 0 6.8 3.8Q6.8 7.6 3.9 7.6" },
  "9": { advance: 8, d: "M1.4 1.6Q2.2 0 4 0Q6.8 0 6.8 7.4Q6.8 14 3.8 14Q1 14 1 9.8Q1 6 3.8 6Q6.4 6 6.8 8.6" },

  /*
   * Punctuation gets a deliberate minimum size.
   *
   * A dot drawn as a zero length move is a dot the machine cannot make: below about
   * a deadband the servo may never leave its dead zone and the mark simply is not
   * there, which reads as a missing full stop rather than as a small one. These are
   * short strokes, not points, so there is always real travel to commit to.
   */
  ".": { advance: 3.6, d: "M1.4 0L2.2 0" },
  ",": { advance: 3.6, d: "M2.2 0.6L1.2 -2" },
  ":": { advance: 3.6, d: "M1.4 0L2.2 0 M1.4 8L2.2 8" },
  "-": { advance: 6.4, d: "M1 7L5.4 7" },
  "_": { advance: 7, d: "M1 -1L6 -1" },
  "/": { advance: 6.4, d: "M1 0L5.4 14" },
  "!": { advance: 3.6, d: "M1.8 14L1.8 4 M1.4 0L2.2 0" },
  "?": { advance: 7.4, d: "M1 11.4Q1 14 3.7 14Q6.4 14 6.4 11.2Q6.4 8.4 3.7 7.4L3.7 4.6 M3.3 0L4.1 0" },
  "'": { advance: 3, d: "M1.5 14L1.5 10.4" },
  "(": { advance: 4.6, d: "M4 14Q1 10.6 1 7Q1 3.4 4 0" },
  ")": { advance: 4.6, d: "M1 14Q4 10.6 4 7Q4 3.4 1 0" },
  "+": { advance: 7.4, d: "M1 7L6.4 7 M3.7 4.3L3.7 9.7" },
  "=": { advance: 7.4, d: "M1 8.8L6.4 8.8 M1 5.2L6.4 5.2" },
  "#": { advance: 8.4, d: "M2.6 0L3.8 14 M5.2 0L6.4 14 M1 4.6L7.2 4.6 M1 9.4L7.2 9.4" },
  "*": { advance: 6.4, d: "M3.2 4.4L3.2 11.6 M1 6.2L5.4 9.8 M1 9.8L5.4 6.2" },
  "%": { advance: 9, d: "M1 0L8 14 M1.2 11.4Q1.2 13.4 2.6 13.4Q4 13.4 4 11.4Q4 9.4 2.6 9.4Q1.2 9.4 1.2 11.4 M5 2.6Q5 4.6 6.4 4.6Q7.8 4.6 7.8 2.6Q7.8 0.6 6.4 0.6Q5 0.6 5 2.6" },
};
