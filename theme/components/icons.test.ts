import { describe, expect, it } from "vitest";
import {
  HB_ICONS,
  HB_ICON_NAMES,
  isHbIconName,
  type HbIconName,
  type HbIconShape,
} from "./icons";

/* The map is `as const`, so its values are a union of tuples. Widening once here
 * keeps every loop below readable. */
function entries(): [string, readonly HbIconShape[]][] {
  return Object.entries(HB_ICONS) as [string, readonly HbIconShape[]][];
}

/*
 * The icon set is data, and data that only ever gets looked at in a browser is
 * data that ships broken. A path with a stray letter renders as nothing at all,
 * silently, and the button it was labelling becomes a blank square.
 */

/**
 * The names the app is entitled to, listed here rather than derived from the map,
 * so deleting an icon fails this test instead of quietly shrinking the contract.
 */
const REQUIRED: readonly HbIconName[] = [
  "usb",
  "bluetooth",
  "play",
  "pause",
  "stop",
  "power",
  "target",
  "crosshair",
  "grid",
  "image",
  "text",
  "pen",
  "wave",
  "gear",
  "warning",
  "check",
  "x",
  "chevron",
  "plug",
  "eye",
];

describe("icon set", () => {
  it("carries every required name", () => {
    for (const name of REQUIRED) {
      expect(isHbIconName(name), name).toBe(true);
      expect(HB_ICONS[name].length, name).toBeGreaterThan(0);
    }
  });

  it("rejects a name it does not have", () => {
    expect(isHbIconName("rocket")).toBe(false);
    expect(isHbIconName("")).toBe(false);
  });

  it("lists every key, sorted", () => {
    expect(HB_ICON_NAMES.length).toBe(Object.keys(HB_ICONS).length);
    expect([...HB_ICON_NAMES]).toStrictEqual([...HB_ICON_NAMES].sort());
    for (const name of REQUIRED) expect(HB_ICON_NAMES).toContain(name);
  });

  /*
   * Every path is a moveto followed by drawing commands, using only the subset of
   * SVG path syntax this file is written in. A `d` that starts anywhere but a
   * moveto is invalid and renders as nothing.
   */
  it("holds only well formed path data", () => {
    const allowed = /^[MmLlHhVvCcSsAaZz0-9.\-+,\s]+$/;
    for (const [name, shapes] of entries()) {
      for (const s of shapes) {
        expect(s.d.length, name).toBeGreaterThan(3);
        expect(s.d.startsWith("M"), `${name}: ${s.d}`).toBe(true);
        expect(allowed.test(s.d), `${name}: ${s.d}`).toBe(true);
        /* Two decimal points inside one number is the typo that survives a
         * glance and kills the whole path. */
        expect(/\d+\.\d*\.\d/.test(s.d), `${name}: ${s.d}`).toBe(false);
      }
    }
  });

  /*
   * The grid is 24 units. A coordinate outside roughly that range means a shape
   * was authored against a different box and will clip or float.
   */
  it("stays on the 24 unit grid", () => {
    for (const [name, shapes] of entries()) {
      for (const s of shapes) {
        for (const m of s.d.matchAll(/-?\d+(?:\.\d+)?/g)) {
          const v = Number.parseFloat(m[0]);
          expect(v, `${name}: ${s.d}`).toBeGreaterThanOrEqual(-24);
          expect(v, `${name}: ${s.d}`).toBeLessThanOrEqual(24);
        }
      }
    }
  });

  it("never smuggles an emoji or a webfont reference into path data", () => {
    for (const [name, shapes] of entries()) {
      for (const s of shapes) {
        expect(/\p{Extended_Pictographic}/u.test(s.d), name).toBe(false);
        expect(s.d.toLowerCase().includes("font"), name).toBe(false);
      }
    }
  });
});
