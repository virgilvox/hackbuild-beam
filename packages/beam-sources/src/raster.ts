/*
 * IMAGE TO DASHES, serpentine.
 *
 * A beam has no grey. What it has is on and off, so a photograph becomes a set of
 * horizontal runs where the image was dark enough to cross a threshold, one row of
 * them per pitch step down the image. That is the whole technique, and every choice
 * below is about not wasting the beam-off time between the runs.
 *
 * This takes a `GrayImage`, not a canvas. The app does the sampling and the
 * downscaling; this file never learns that a canvas exists, which is what lets it
 * run under vitest against a buffer built by hand.
 */

import type { GrayImage, SourceResult, Stroke } from "./index.js";
import { bboxOf } from "./ops.js";

export interface RasterOptions {
  /** Width of the drawn image on the target, millimetres. Height follows the aspect ratio. */
  widthMm: number;
  /** Height cap on the target, millimetres. The image fits inside width by height. */
  heightMm: number;
  /** Vertical distance between scan rows, millimetres. */
  pitchMm: number;
  /** Luminance cutoff, 0 to 255. Below it is dark, and dark is where the beam is on. */
  threshold?: number;
  /** Swap which side of the threshold draws. A white line drawing on black needs this. */
  invert?: boolean;
  /**
   * What one commandable step is worth on the target, millimetres. Sets the
   * horizontal sampling: sampling finer than the machine can command produces runs
   * whose ends round onto the same position, which is a zero length segment.
   */
  resolutionMm: number;
  /**
   * Shortest run worth drawing, millimetres. Defaults to 0.4 of a step.
   *
   * The point is not tidiness. A one-pixel run costs a beam-off travel in and a
   * beam-off travel out for a dot nobody can see, and a noisy photograph has
   * thousands of them. The bench figure came from watching a plot spend more time
   * hopping between speckles than drawing the subject.
   */
  minRunMm?: number;
}

/** The default minimum run, as a fraction of one commandable step. */
export const MIN_RUN_STEP_FRACTION = 0.4;

/** Midpoint of the 0 to 255 luminance range, which is the useful default cutoff. */
export const DEFAULT_THRESHOLD = 128;

/**
 * Image to serpentine dashes, centred on the origin, in target millimetres, y up.
 *
 * The result carries `noReorder`, and that flag is load bearing. Rows are emitted
 * left to right, then right to left, then left to right again, so the beam-off hop
 * from the end of one row to the start of the next is one pitch step downward rather
 * than the whole width of the image. A travel optimiser looking at these strokes
 * sees a set of short parallel lines, decides several of them should be reversed and
 * reordered, and undoes exactly the thing the serpentine was doing. It has to be
 * told, because it cannot tell.
 */
export function rasterToStrokes(img: GrayImage, opts: RasterOptions): SourceResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const invert = opts.invert ?? false;
  const step = Math.max(1e-6, opts.resolutionMm);
  const minRun = opts.minRunMm ?? step * MIN_RUN_STEP_FRACTION;
  const pitch = Math.max(1e-6, opts.pitchMm);

  const strokes: Stroke[] = [];
  if (img.width < 1 || img.height < 1) return { strokes, bbox: bboxOf(strokes), noReorder: true };

  /* Fit inside the box without distorting. Width first, then fall back to height if
   * the result is too tall, which is the same rule the shipped tool used. */
  const aspect = img.width / img.height;
  let wmm = opts.widthMm;
  let hmm = wmm / aspect;
  if (hmm > opts.heightMm) {
    hmm = opts.heightMm;
    wmm = hmm * aspect;
  }

  const rows = Math.max(1, Math.floor(hmm / pitch));
  const cols = Math.max(2, Math.floor(wmm / step));
  let flip = false;

  for (let r = 0; r <= rows; r++) {
    const ymm = hmm / 2 - r * pitch;
    /* Nearest source row rather than an average of the band. Averaging looks better
     * on a screen and is wrong here: the threshold is what makes the picture, and
     * pre-blurring the input pushes every edge toward the middle grey. */
    const py = Math.min(img.height - 1, Math.round((r / rows) * (img.height - 1)));

    let runs: Array<[number, number]> = [];
    let runStart: number | null = null;
    for (let c = 0; c <= cols; c++) {
      const xmm = -wmm / 2 + (c / cols) * wmm;
      const px = Math.min(img.width - 1, Math.round((c / cols) * (img.width - 1)));
      const g = img.data[py * img.width + px] ?? 255;
      const dark = invert ? g > threshold : g < threshold;
      if (dark && runStart === null) runStart = xmm;
      /* The `c === cols` half closes a run that reaches the right edge, which
       * otherwise never sees a light pixel to end on and is silently dropped. */
      if ((!dark || c === cols) && runStart !== null) {
        if (xmm - runStart > minRun) runs.push([runStart, xmm]);
        runStart = null;
      }
    }

    if (flip) runs = runs.reverse().map(([a, b]) => [b, a] as [number, number]);
    for (const [a, b] of runs) {
      strokes.push([
        { x: a, y: ymm },
        { x: b, y: ymm },
      ]);
    }
    flip = !flip;
  }

  return { strokes, bbox: bboxOf(strokes), noReorder: true };
}
