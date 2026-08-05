import { describe, expect, it } from "vitest";
import type { ParseXml, XmlDocument, XmlElement } from "./index.js";
import { pathToStrokes, parseTransform, svgToStrokes } from "./svg.js";

/*
 * The whole point of the injected ParseXml contract is that this shim is enough.
 *
 * No jsdom, no DOMParser, no document. If the importer ever reaches for a global the
 * eslint rule fails the build, and if the contract ever grows past what a shim can
 * satisfy, this file stops compiling. Both are the alarm going off.
 */

interface ShimNode extends XmlElement {
  readonly childNodes: ShimNode[];
  readonly attrs: Record<string, string>;
}

const TAG = /<([/!?]?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function mk(name: string): ShimNode {
  const attrs: Record<string, string> = {};
  return {
    nodeType: 1,
    nodeName: name,
    childNodes: [],
    attrs,
    getAttribute: (n: string) => attrs[n] ?? null,
  };
}

const parseXml: ParseXml = (text: string): XmlDocument => {
  const root = mk("#document");
  const stack: ShimNode[] = [root];
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(text)) !== null) {
    if (m[1] === "!" || m[1] === "?") continue;
    if (m[1] === "/") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = mk(m[2]!);
    ATTR.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR.exec(m[3] ?? "")) !== null) el.attrs[a[1]!] = a[2] ?? a[3] ?? "";
    stack[stack.length - 1]!.childNodes.push(el);
    if (!m[4]) stack.push(el);
  }
  const first = root.childNodes[0];
  if (!first) throw new Error("shim: no root element");
  return { documentElement: first };
};

const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <g transform="translate(10,20) scale(2)">
    <path d="M 0 0 L 10 0 H 20 V 10 C 25 10 30 5 30 0 S 40 -5 45 0 Q 50 5 55 0 T 65 0 A 5 5 0 1 1 75 0 Z"/>
    <rect x="0" y="10" width="30" height="20"/>
  </g>
  <g transform="rotate(30 100 100)">
    <circle cx="100" cy="100" r="25"/>
    <ellipse cx="40" cy="150" rx="20" ry="10"/>
    <line x1="0" y1="0" x2="50" y2="50"/>
    <polyline points="1,2 3,4 5,6"/>
    <polygon points="10,10 20,10 20,20"/>
  </g>
  <path d="m 5 5 l 5 5 l 5 -5 z"/>
</svg>`;

describe("svgToStrokes", () => {
  const res = svgToStrokes(SVG, parseXml, { toleranceMm: 0.1 });

  it("finds every geometry element and no group", () => {
    /* One path plus a rect in the first group, five shapes in the second, one more
     * path at the root. The relative path closes, so it is still one subpath. */
    expect(res.strokes.length).toBe(8);
  });

  it("produces only finite points", () => {
    for (const s of res.strokes) {
      expect(s.length).toBeGreaterThan(1);
      for (const p of s) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });

  it("has a sane bbox on the same order as the viewBox", () => {
    const b = res.bbox;
    expect(Number.isFinite(b.minX)).toBe(true);
    expect(Number.isFinite(b.maxY)).toBe(true);
    expect(b.maxX - b.minX).toBeGreaterThan(50);
    expect(b.maxX - b.minX).toBeLessThan(400);
    expect(b.maxY - b.minY).toBeGreaterThan(50);
    expect(b.maxY - b.minY).toBeLessThan(400);
  });

  it("flips y, because SVG grows downward and every target here grows up", () => {
    /* An import that skips the flip draws the design upside down and nothing later
     * in the chain can tell, which is why this gets its own minimal document rather
     * than being inferred from the fixture's bbox. */
    const flip = svgToStrokes(
      `<svg><rect x="0" y="10" width="10" height="20"/></svg>`,
      parseXml,
    );
    expect(flip.bbox.minY).toBeCloseTo(-30, 9);
    expect(flip.bbox.maxY).toBeCloseTo(-10, 9);
  });

  it("applies a group transform to what is inside it", () => {
    /* translate(10,20) scale(2) puts the rect at x 10..70 and SVG y 40..80, so after
     * the flip it lands at y -80..-40. */
    const g = svgToStrokes(
      `<svg><g transform="translate(10,20) scale(2)"><rect x="0" y="10" width="30" height="20"/></g></svg>`,
      parseXml,
    );
    expect(g.bbox.minX).toBeCloseTo(10, 9);
    expect(g.bbox.maxX).toBeCloseTo(70, 9);
    expect(g.bbox.minY).toBeCloseTo(-80, 9);
    expect(g.bbox.maxY).toBeCloseTo(-40, 9);
  });

  it("composes nested group transforms", () => {
    const n = svgToStrokes(
      `<svg><g transform="translate(10,0)"><g transform="translate(5,0)"><line x1="0" y1="0" x2="1" y2="0"/></g></g></svg>`,
      parseXml,
    );
    expect(n.strokes[0]![0]!.x).toBeCloseTo(15, 9);
  });
});

describe("path grammar", () => {
  it("treats an implicit repeat as another command of the same kind", () => {
    const one = pathToStrokes("M0 0 L10 0 L10 10 L0 10", 0.05);
    const rep = pathToStrokes("M0 0 L10 0 10 10 0 10", 0.05);
    expect(rep[0]!.length).toBe(one[0]!.length);
    expect(rep[0]![3]).toEqual(one[0]![3]);
  });

  it("treats extra pairs after M as lineto, keeping relativity", () => {
    const s = pathToStrokes("m10 10 5 0 0 5", 0.05)[0]!;
    expect(s[0]).toEqual({ x: 10, y: 10 });
    expect(s[1]).toEqual({ x: 15, y: 10 });
    expect(s[2]).toEqual({ x: 15, y: 15 });
  });

  it("closes back to the subpath start on Z", () => {
    const s = pathToStrokes("M5 5 L15 5 L15 15 Z", 0.05)[0]!;
    expect(s[s.length - 1]).toEqual({ x: 5, y: 5 });
  });

  it("reflects the control point on S and on T", () => {
    /* A C followed by a smooth S with the mirrored control is the same curve as
     * writing that control out in full. */
    const explicit = pathToStrokes("M0 0 C10 10 20 10 30 0 C40 -10 50 -10 60 0", 0.05)[0]!;
    const smooth = pathToStrokes("M0 0 C10 10 20 10 30 0 S50 -10 60 0", 0.05)[0]!;
    expect(smooth.length).toBe(explicit.length);
    const a = explicit[explicit.length - 1]!;
    const b = smooth[smooth.length - 1]!;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-9);
  });

  it("puts an arc on its own circle", () => {
    /* Half of a unit-radius-10 circle from (0,0) to (20,0): every sampled point is
     * 10 away from (10,0). */
    const s = pathToStrokes("M0 0 A10 10 0 0 1 20 0", 0.05)[0]!;
    expect(s.length).toBeGreaterThan(10);
    for (const p of s) expect(Math.abs(Math.hypot(p.x - 10, p.y) - 10)).toBeLessThan(1e-6);
  });

  it("does not hang on a stray number after Z", () => {
    /* The shipped importer spins forever here, because Z consumes no token and the
     * loop cursor never advances. Reaching the assertion at all is the test. */
    const s = pathToStrokes("M0 0 L10 0 Z 5 5", 0.05);
    expect(s.length).toBe(1);
  });

  it("drops the tail of a truncated command rather than emitting NaN", () => {
    const s = pathToStrokes("M0 0 L10 10 L20", 0.05)[0]!;
    for (const p of s) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(s.length).toBe(2);
  });

  it("finer tolerance means more points on a curve", () => {
    const coarse = pathToStrokes("M0 0 C0 40 60 40 60 0", 5)[0]!.length;
    const fine = pathToStrokes("M0 0 C0 40 60 40 60 0", 0.01)[0]!.length;
    expect(fine).toBeGreaterThan(coarse);
  });
});

describe("parseTransform", () => {
  it("composes left to right", () => {
    const m = parseTransform("translate(10,20) scale(2)");
    expect(m[4]).toBe(10);
    expect(m[5]).toBe(20);
    expect(m[0]).toBe(2);
    expect(m[3]).toBe(2);
  });

  it("expands a rotate about a centre", () => {
    const m = parseTransform("rotate(90 10 10)");
    /* The centre is a fixed point of the rotation, which is the property the
     * translate/rotate/untranslate triple exists to give. */
    const x = m[0] * 10 + m[2] * 10 + m[4];
    const y = m[1] * 10 + m[3] * 10 + m[5];
    expect(Math.abs(x - 10)).toBeLessThan(1e-9);
    expect(Math.abs(y - 10)).toBeLessThan(1e-9);
  });

  it("takes a single scale argument as uniform", () => {
    const m = parseTransform("scale(3)");
    expect(m[0]).toBe(3);
    expect(m[3]).toBe(3);
  });
});

describe("malformed input", () => {
  it("throws on a parsererror document rather than importing nothing", () => {
    expect(() => svgToStrokes("<parsererror>broken</parsererror>", parseXml)).toThrow();
  });

  it("reads a namespace-prefixed document", () => {
    const res = svgToStrokes(
      `<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:rect x="0" y="0" width="10" height="10"/></svg:svg>`,
      parseXml,
    );
    expect(res.strokes.length).toBe(1);
  });
});
