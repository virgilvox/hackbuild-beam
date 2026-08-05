/**
 * Shapes that cross a component boundary.
 *
 * These live outside the SFCs because `<script setup>` cannot export, and because
 * an app that builds an option list or a status chip wants the type without
 * importing the component that renders it.
 */

export interface HbSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * Chip state.
 *
 * `idle` is a dead dot, `on` is lit, `hot` blinks, `danger` is a state the
 * operator has to act on. The blink is `steps(2, end)` rather than a fade, which
 * is carried straight from the stepper tool: a hard blink is visible in
 * peripheral vision on a bench, and a pulsing glow is not.
 */
export type HbChipState = "idle" | "on" | "hot" | "danger";

/** Readout emphasis for HbKv. `ok` is reserved for a captured corner. */
export type HbKvState = "default" | "hot" | "ok" | "danger";
