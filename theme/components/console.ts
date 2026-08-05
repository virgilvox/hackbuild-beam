/**
 * Console line shape and the render cap.
 *
 * Both original tools capped the log by removing nodes off the front once it got
 * long: 300 in the stepper tool, 400 in the servo tool. That cap is not cosmetic.
 * A running plot logs on every credit report, so an uncapped console grows without
 * bound for as long as a job runs and the browser spends the tail end of a plot
 * doing layout on scrollback nobody is reading. 400 is carried over from the servo
 * tool, which is the one that logged harder of the two.
 *
 * The buffer itself belongs to the app: the component takes lines as a prop and
 * emits nothing back into them. This module is the one piece of that contract that
 * is pure enough to test.
 */

/**
 * `tx` and `rx` are wire traffic in each direction. `err` is a failure the
 * operator has to see. `sys` is the app talking about itself. `sim` is the
 * simulator, kept visually distinct from `rx` so a dry run is never mistaken for
 * a board that is actually answering.
 */
export type HbConsoleLevel = "tx" | "rx" | "err" | "sys" | "sim";

export interface HbConsoleLine {
  readonly text: string;
  readonly level: HbConsoleLevel;
  /** Optional monotonic ms for a leading stamp. Rendering is the caller's format. */
  readonly t?: number;
}

export const HB_CONSOLE_MAX = 400;

const EMPTY: readonly never[] = [];

/**
 * The last `max` lines, oldest dropped first.
 *
 * Returns the input array unchanged when it is already under the cap, so the
 * common case allocates nothing and Vue's diff sees the same reference.
 */
export function capLines<T>(lines: readonly T[], max: number): readonly T[] {
  if (max <= 0) return EMPTY;
  if (lines.length <= max) return lines;
  return lines.slice(lines.length - max);
}
