import { describe, expect, it } from "vitest";
import type { Stroke } from "./index.js";
import {
  bboxOf,
  centerFit,
  orderStrokes,
  scaleToField,
  toPoints,
  translateStrokes,
  travelMm,
} from "./ops.js";

const SQUARE: Stroke[] = [
  toPoints([
    [0, 0],
    [10, 0],
    [10, 4],
    [0, 4],
    [0, 0],
  ]),
];

describe("bboxOf", () => {
  it("measures the extent", () => {
    expect(bboxOf(SQUARE)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 4 });
  });

  it("reports zeroes for nothing rather than infinities", () => {
    expect(bboxOf([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
    expect(bboxOf([[]])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe("centerFit", () => {
  it("centres on the origin", () => {
    const b = bboxOf(centerFit(SQUARE));
    expect(b.minX + b.maxX).toBeCloseTo(0, 12);
    expect(b.minY + b.maxY).toBeCloseTo(0, 12);
  });

  it("normalises the larger span to one and keeps the aspect ratio", () => {
    const b = bboxOf(centerFit(SQUARE));
    expect(b.maxX - b.minX).toBeCloseTo(1, 12);
    expect(b.maxY - b.minY).toBeCloseTo(0.4, 12);
  });

  it("does not divide by a zero span", () => {
    const dot = centerFit([toPoints([[5, 5]])]);
    expect(dot[0]![0]!.x).toBe(0);
    expect(dot[0]![0]!.y).toBe(0);
  });

  it("passes an empty set through", () => {
    expect(centerFit([])).toEqual([]);
  });
});

describe("scaleToField", () => {
  it("takes a percentage of the short side", () => {
    const out = scaleToField(centerFit(SQUARE), 200, 50);
    const b = bboxOf(out);
    expect(b.maxX - b.minX).toBeCloseTo(100, 9);
    expect(b.maxY - b.minY).toBeCloseTo(40, 9);
  });
});

describe("translateStrokes", () => {
  it("moves without resizing", () => {
    const b = bboxOf(translateStrokes(SQUARE, 5, -5));
    expect(b).toEqual({ minX: 5, minY: -5, maxX: 15, maxY: -1 });
  });
});

describe("orderStrokes", () => {
  const far: Stroke[] = [
    toPoints([
      [100, 0],
      [110, 0],
    ]),
    toPoints([
      [1, 0],
      [2, 0],
    ]),
    toPoints([
      [50, 0],
      [60, 0],
    ]),
  ];

  it("visits the nearest stroke first", () => {
    const out = orderStrokes(far);
    expect(out[0]![0]!.x).toBe(1);
    expect(out[1]![0]!.x).toBe(50);
    expect(out[2]![0]!.x).toBe(100);
  });

  it("cuts beam-off travel against document order", () => {
    expect(travelMm(orderStrokes(far))).toBeLessThan(travelMm(far));
  });

  it("reverses a stroke when its tail is nearer", () => {
    const away: Stroke[] = [
      toPoints([
        [50, 0],
        [5, 0],
      ]),
    ];
    const out = orderStrokes(away);
    expect(out[0]![0]!.x).toBe(5);
  });

  it("refuses to reverse when the approach must be unidirectional", () => {
    /* Reversing is free on a servo and costs the gear slack on a stepper: the two
     * directions differ by the backlash, so a design whose strokes were drawn
     * whichever way was nearest has some of its lines offset from the others. */
    const away: Stroke[] = [
      toPoints([
        [50, 0],
        [5, 0],
      ]),
    ];
    const out = orderStrokes(away, { unidirectional: true });
    expect(out[0]![0]!.x).toBe(50);
  });

  it("starts from where the beam is parked", () => {
    /* Parked out to the right, the far stroke is nearest and its tail is the nearer
     * of its two ends, so it is taken first and reversed. */
    const out = orderStrokes(far, { start: { x: 200, y: 0 } });
    expect(out[0]![0]!.x).toBe(110);
    expect(out[2]![0]!.x).toBe(2);
  });

  it("keeps every stroke exactly once", () => {
    expect(orderStrokes(far).length).toBe(far.length);
    expect(orderStrokes([]).length).toBe(0);
  });

  it("does not mutate its input", () => {
    const src: Stroke[] = [
      toPoints([
        [50, 0],
        [5, 0],
      ]),
    ];
    orderStrokes(src);
    expect(src[0]![0]!.x).toBe(50);
  });
});

describe("travelMm", () => {
  it("counts the hops between strokes and not the strokes themselves", () => {
    const s: Stroke[] = [
      toPoints([
        [0, 0],
        [10, 0],
      ]),
      toPoints([
        [10, 5],
        [0, 5],
      ]),
    ];
    /* Origin to (0,0) is nothing; (10,0) to (10,5) is five. The ten millimetres
     * drawn in between are beam-on and do not count. */
    expect(travelMm(s)).toBeCloseTo(5, 12);
  });
});
