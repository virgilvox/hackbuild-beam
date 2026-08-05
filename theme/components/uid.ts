/**
 * Stable per-instance ids for label/control pairing.
 *
 * Every labelled control in this set ties its `<label for>` to the control's
 * `id`, because a laser UI full of numbers is unusable without them: clicking
 * the word "throw" has to land in the throw box, and a screen reader has to be
 * able to say which number it is reading. Vue 3.5 has `useId()`, but the theme
 * is meant to travel by being copied into other hack.build tools, some of which
 * pin older Vue, so the counter lives here instead of depending on the version.
 *
 * The caller can always pass its own id and skip this entirely.
 */

let counter = 0;

export function hbUid(prefix = "hb"): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Test seam. Never call this from a component. */
export function resetHbUid(): void {
  counter = 0;
}
