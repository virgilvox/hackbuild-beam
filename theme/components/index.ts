/**
 * The hack.build component set.
 *
 * Presentational only. Nothing here imports beam code, a store, or anything that
 * knows what a laser is: props in, events out. That is enforced in eslint.config.js,
 * not left to review, because the value of this folder is that it can be copied
 * whole into the next hack.build tool.
 *
 * Every component works in both schemes by referencing only the semantic tokens in
 * tokens.css. Import that file once, at the app entry, and set `data-scheme` on the
 * root element to "paper" or "ink".
 */

export { default as HbBadge } from "./HbBadge.vue";
export { default as HbButton } from "./HbButton.vue";
export { default as HbChip } from "./HbChip.vue";
export { default as HbConsole } from "./HbConsole.vue";
export { default as HbField } from "./HbField.vue";
export { default as HbFold } from "./HbFold.vue";
export { default as HbHeaderBar } from "./HbHeaderBar.vue";
export { default as HbHint } from "./HbHint.vue";
export { default as HbIcon } from "./HbIcon.vue";
export { default as HbKv } from "./HbKv.vue";
export { default as HbNote } from "./HbNote.vue";
export { default as HbNumber } from "./HbNumber.vue";
export { default as HbOverlay } from "./HbOverlay.vue";
export { default as HbPanel } from "./HbPanel.vue";
export { default as HbRange } from "./HbRange.vue";
export { default as HbRunDock } from "./HbRunDock.vue";
export { default as HbSelect } from "./HbSelect.vue";
export { default as HbToggle } from "./HbToggle.vue";
export { default as HbWordmark } from "./HbWordmark.vue";

export {
  HB_ICONS,
  HB_ICON_NAMES,
  isHbIconName,
  type HbIconName,
  type HbIconShape,
} from "./icons";

export {
  HB_CONSOLE_MAX,
  capLines,
  type HbConsoleLevel,
  type HbConsoleLine,
} from "./console";

export { hbUid } from "./uid";

export type { HbChipState, HbKvState, HbSelectOption } from "./types";
