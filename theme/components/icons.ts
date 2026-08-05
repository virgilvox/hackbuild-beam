/**
 * The icon set, as path data.
 *
 * Both original tools pulled Font Awesome from a CDN and rendered icons as an
 * icon webfont. That is two things this build cannot have: a runtime network
 * fetch, and a glyph whose meaning depends on a font loading. The single file
 * build must open from file:// on a bench with no wifi, and an icon that fails
 * to load in a laser control UI is a button whose meaning is gone.
 *
 * So the shapes live here as plain path data on a 24 unit grid and ship inline.
 * Never an emoji, never a webfont. Attribution is in theme/README.md.
 *
 * Shapes are stroked by default, which is what keeps them consistent with the
 * rest of the system: hard edges, no radius, one weight. A shape that reads
 * better solid sets `fill`.
 */

export interface HbIconShape {
  readonly d: string;
  /** Solid rather than stroked. Used for arrowheads, dots and play/pause/stop. */
  readonly fill?: boolean;
}

/*
 * Circle helper shapes are written out longhand rather than composed, because
 * the map is data and a data file that computes is a data file that can be
 * wrong in one place and right in another.
 */
export const HB_ICONS = {
  /*
   * The trident, with the connector at the bottom. The two branch tips are a
   * square and a circle because that is what distinguishes this mark from any
   * other fork at 14px, which is the size it is actually drawn at.
   */
  usb: [
    { d: "M12 6.5v14" },
    { d: "M12 1.5 14.6 6.5H9.4z", fill: true },
    { d: "M12 15.5 7.5 11V8.5" },
    { d: "M6 5.2h3v3H6z", fill: true },
    { d: "M12 11.5 16.5 7V5.6" },
    { d: "M16.5 2.2a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z", fill: true },
    { d: "M9.8 19.6h4.4v3.2H9.8z", fill: true },
  ],
  bluetooth: [{ d: "M8 7.5 16 16.5 12 20.5V3.5l4 4L8 16.5" }],
  play: [{ d: "M6 3.5 20 12 6 20.5z", fill: true }],
  pause: [
    { d: "M6.5 4h4v16h-4z", fill: true },
    { d: "M13.5 4h4v16h-4z", fill: true },
  ],
  stop: [{ d: "M5 5h14v14H5z", fill: true }],
  power: [
    { d: "M12 3v8" },
    { d: "M7.05 6.05a7 7 0 1 0 9.9 0" },
  ],
  target: [
    { d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" },
    { d: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" },
    { d: "M12 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z", fill: true },
  ],
  crosshair: [
    { d: "M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z" },
    { d: "M12 1v5" },
    { d: "M12 18v5" },
    { d: "M1 12h5" },
    { d: "M18 12h5" },
  ],
  grid: [
    { d: "M3 3h18v18H3z" },
    { d: "M9 3v18" },
    { d: "M15 3v18" },
    { d: "M3 9h18" },
    { d: "M3 15h18" },
  ],
  image: [
    { d: "M3 4h18v16H3z" },
    { d: "M3 17l5-5 4 4 3-3 6 6" },
    { d: "M8.4 7.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z", fill: true },
  ],
  text: [
    { d: "M4 6V4h16v2" },
    { d: "M12 4v16" },
    { d: "M8 20h8" },
  ],
  pen: [
    { d: "M4 20l1-4L16.4 4.6a2.1 2.1 0 0 1 3 3L8 19z" },
    { d: "M14.4 6.6l3 3" },
  ],
  wave: [{ d: "M2 12c1.67-6 3.33-6 5 0s3.33 6 5 0 3.33-6 5 0" }],
  gear: [
    { d: "M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z" },
    { d: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" },
    { d: "M12 2v3" },
    { d: "M12 19v3" },
    { d: "M2 12h3" },
    { d: "M19 12h3" },
    { d: "M5.2 5.2l2.1 2.1" },
    { d: "M16.7 16.7l2.1 2.1" },
    { d: "M18.8 5.2l-2.1 2.1" },
    { d: "M7.3 16.7l-2.1 2.1" },
  ],
  warning: [
    { d: "M12 3.5 22 20.5H2z" },
    { d: "M12 10v5" },
    { d: "M11.1 17.1h1.8v1.8h-1.8z", fill: true },
  ],
  check: [{ d: "M4 12.5 9.5 18 20 6.5" }],
  x: [
    { d: "M5 5l14 14" },
    { d: "M19 5 5 19" },
  ],
  chevron: [{ d: "M5 9l7 7 7-7" }],
  plug: [
    { d: "M9 2v6" },
    { d: "M15 2v6" },
    { d: "M6 8h12v3a6 6 0 0 1-12 0z" },
    { d: "M12 17v5" },
  ],
  eye: [
    { d: "M1.5 12S5.5 5.5 12 5.5 22.5 12 22.5 12 18.5 18.5 12 18.5 1.5 12 1.5 12z" },
    { d: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", fill: true },
  ],
  info: [
    { d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" },
    { d: "M12 11v6" },
    { d: "M11.1 6.6h1.8v1.8h-1.8z", fill: true },
  ],
  question: [
    { d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" },
    { d: "M9.3 9.4a2.7 2.7 0 1 1 3.6 2.6c-.6.2-.9.7-.9 1.4v.8" },
    { d: "M11.1 16.2h1.8v1.8h-1.8z", fill: true },
  ],
  plus: [
    { d: "M12 5v14" },
    { d: "M5 12h14" },
  ],
  minus: [{ d: "M5 12h14" }],
} as const satisfies Record<string, readonly HbIconShape[]>;

export type HbIconName = keyof typeof HB_ICONS;

/** Every name the set knows, sorted, for gallery pages and for tests. */
export const HB_ICON_NAMES = Object.keys(HB_ICONS).sort() as readonly HbIconName[];

export function isHbIconName(name: string): name is HbIconName {
  return Object.prototype.hasOwnProperty.call(HB_ICONS, name);
}
