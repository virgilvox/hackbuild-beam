/*
 * SVG IMPORT, headless.
 *
 * Ported from the stepper tool, which parses the path grammar itself rather than
 * leaning on `getTotalLength` and `getPointAtLength`. The servo tool took the other
 * route and it works, but only inside a live document: it has to append a hidden
 * host element to the page so the browser will compute a CTM for it, which means the
 * importer cannot run in a worker, cannot run in node, and cannot be tested without
 * a DOM. This version needs exactly one primitive, an XML parser, and it takes it as
 * an argument. See `ParseXml` in index.ts for why the injected contract is shaped
 * the way it is.
 *
 * What is covered is the common core of the spec: the full path grammar with
 * relative and absolute forms and implicit command repeats, the basic shapes,
 * nested groups, and the four transform functions. Fills, strokes, styles, clip
 * paths, `use`, and text are ignored, because a beam draws centrelines and none of
 * those describe one.
 */

import type { Point } from "@virgilvox/beam-core";
import type { ParseXml, SourceResult, Stroke, XmlNode } from "./index.js";
import { isElement } from "./index.js";
import { bboxOf } from "./ops.js";

const DEG = Math.PI / 180;

/** Affine 2x3 in SVG's own order: [a, b, c, d, e, f]. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function matMul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function matApply(m: Matrix, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

const TRANSFORM_FN = /(\w+)\s*\(([^)]*)\)/g;

/**
 * Parse a `transform` attribute. Functions compose left to right, which is the
 * order SVG applies them in, and a rotate with a centre expands to the
 * translate/rotate/untranslate triple rather than being special cased downstream.
 */
export function parseTransform(attr: string | null): Matrix {
  let m: Matrix = IDENTITY;
  TRANSFORM_FN.lastIndex = 0;
  let t: RegExpExecArray | null;
  while ((t = TRANSFORM_FN.exec(attr ?? "")) !== null) {
    const n = t[2]!
      .split(/[\s,]+/)
      .filter((x) => x.length > 0)
      .map(Number);
    const fn = t[1];
    if (fn === "translate") {
      m = matMul(m, [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0]);
    } else if (fn === "scale") {
      const sx = n[0] ?? 1;
      const sy = n.length > 1 ? (n[1] ?? 1) : sx;
      m = matMul(m, [sx, 0, 0, sy, 0, 0]);
    } else if (fn === "rotate") {
      const a = (n[0] ?? 0) * DEG;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const hasCentre = n.length > 2;
      if (hasCentre) m = matMul(m, [1, 0, 0, 1, n[1] ?? 0, n[2] ?? 0]);
      m = matMul(m, [c, s, -s, c, 0, 0]);
      if (hasCentre) m = matMul(m, [1, 0, 0, 1, -(n[1] ?? 0), -(n[2] ?? 0)]);
    } else if (fn === "matrix" && n.length === 6) {
      m = matMul(m, [n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!]);
    }
    /* skewX and skewY are deliberately absent: nothing that has come through this
     * importer has used them, and a silently wrong skew is worse than an unsupported
     * one, which at least draws visibly unskewed. */
  }
  return m;
}

/**
 * Flatness tolerance floor, in the SVG's own user units.
 *
 * Below this the recursion depth cap does all the work and the extra points buy
 * nothing the machine can command. The stepper's quantum is 0.55 mm, so 0.05 is
 * already an order of magnitude finer than the finest thing either rig can draw.
 */
const MIN_TOLERANCE = 0.05;

/** Cubic subdivision depth cap. 9 levels is 512 pieces, which is past any real curve. */
const MAX_CUBIC_DEPTH = 9;

/**
 * Adaptive cubic flattening by the standard two-control-point distance test: the
 * flatness measure is the sum of the two control points' distances from the chord,
 * normalised by the chord length, which is the cheap form that avoids two square
 * roots per test. The epsilon on the chord length is there for the degenerate case
 * where start and end coincide, which a closed loop drawn as one C command produces.
 */
function flattenCubic(
  pts: Point[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tol: number,
  depth: number,
): void {
  const d1 = Math.abs((x1 - x0) * (y3 - y0) - (y1 - y0) * (x3 - x0));
  const d2 = Math.abs((x2 - x0) * (y3 - y0) - (y2 - y0) * (x3 - x0));
  const len = Math.hypot(x3 - x0, y3 - y0) + 1e-9;
  if (depth > MAX_CUBIC_DEPTH || (d1 + d2) / len < tol) {
    pts.push({ x: x3, y: y3 });
    return;
  }
  const ax = (x0 + x1) / 2;
  const ay = (y0 + y1) / 2;
  const bx = (x1 + x2) / 2;
  const by = (y1 + y2) / 2;
  const cx = (x2 + x3) / 2;
  const cy = (y2 + y3) / 2;
  const dx = (ax + bx) / 2;
  const dy = (ay + by) / 2;
  const ex = (bx + cx) / 2;
  const ey = (by + cy) / 2;
  const fx = (dx + ex) / 2;
  const fy = (dy + ey) / 2;
  flattenCubic(pts, x0, y0, ax, ay, dx, dy, fx, fy, tol, depth + 1);
  flattenCubic(pts, fx, fy, ex, ey, cx, cy, x3, y3, tol, depth + 1);
}

/** Arc sampling step, radians. About 7 degrees, which is under a tenth of a millimetre
 * of sagitta on a 50 mm radius and is what the shipped importer used. */
const ARC_STEP_RAD = 0.12;

/**
 * SVG's endpoint parameterisation to centre parameterisation, per the implementation
 * notes in the spec appendix, then sampled.
 *
 * The three corrections in here are all spec requirements and all of them bite:
 * radii are taken as absolute values, out-of-range radii are scaled up uniformly by
 * sqrt(lambda) so the endpoints are reachable at all, and the square root argument is
 * clamped at zero because floating point can take it a few ulps negative exactly when
 * lambda is 1, which is the common case of an arc drawn at its minimum radius.
 */
export function flattenArc(
  pts: Point[],
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  rotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x1: number,
  y1: number,
): void {
  if (rxIn === 0 || ryIn === 0) {
    pts.push({ x: x1, y: y1 });
    return;
  }
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  const phi = rotDeg * DEG;
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const dx2 = (x0 - x1) / 2;
  const dy2 = (y0 - y1) / 2;
  const xp = cp * dx2 + sp * dy2;
  const yp = -sp * dx2 + cp * dy2;
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) {
    const q = Math.sqrt(lam);
    rx *= q;
    ry *= q;
  }
  let num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  if (num < 0) num = 0;
  let coef = Math.sqrt(num / (rx * rx * yp * yp + ry * ry * xp * xp + 1e-12));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * yp) / ry;
  const cyp = (-coef * ry * xp) / rx;
  const cx = cp * cxp - sp * cyp + (x0 + x1) / 2;
  const cy = sp * cxp + cp * cyp + (y0 + y1) / 2;

  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const d = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (d + 1e-12))));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const th1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dth = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;

  const n = Math.max(2, Math.ceil(Math.abs(dth) / ARC_STEP_RAD));
  for (let i = 1; i <= n; i++) {
    const t = th1 + (dth * i) / n;
    const px = rx * Math.cos(t);
    const py = ry * Math.sin(t);
    pts.push({ x: cp * px - sp * py + cx, y: sp * px + cp * py + cy });
  }
}

const PATH_TOKENS = /[a-zA-Z]|[-+]?[\d.]+(?:e[-+]?\d+)?/gi;

/**
 * A truncated or malformed path should lose its tail, not poison the plot.
 *
 * `parseFloat` on a missing token gives NaN, NaN propagates through every subsequent
 * relative coordinate, and a single NaN reaching the planner turns the whole job's
 * timing into NaN. Dropping non-finite points and then dropping subpaths too short
 * to draw keeps the damage local to the malformed command.
 */
function finiteOnly(sub: readonly Point[]): Stroke | null {
  const out = sub.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  return out.length > 1 ? out : null;
}

/**
 * The full path grammar: M L H V C S Q T A Z, relative and absolute, with implicit
 * repeats. Quadratics are converted to cubics rather than given their own flattener,
 * because the elevation is exact and one adaptive subdivider is one thing to get
 * right instead of two.
 *
 * Returns subpaths in the path's own coordinate system. The caller applies the
 * accumulated transform.
 */
export function pathToStrokes(d: string, tol: number): Stroke[] {
  const toks = d.match(PATH_TOKENS) ?? [];
  const subs: Point[][] = [];
  let i = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  /* Reflected control points for the smooth forms. Cubic and quadratic keep separate
   * memories and each clears the other, because S after a Q reflects nothing: the
   * spec says an S whose predecessor was not a C or S uses the current point. */
  let pcx: number | null = null;
  let pcy = 0;
  let pqx: number | null = null;
  let pqy = 0;

  const num = (): number => {
    const t = toks[i++];
    return t === undefined ? NaN : parseFloat(t);
  };
  const start = (x: number, y: number): Point[] => {
    const sub: Point[] = [{ x, y }];
    subs.push(sub);
    return sub;
  };
  /* A path that opens with a drawing command rather than an M is malformed. Starting
   * an implicit subpath at the current point keeps the parser total; throwing would
   * lose an otherwise usable document to one bad element. */
  const pen = (): Point[] => subs[subs.length - 1] ?? start(cx, cy);

  while (i < toks.length) {
    const t = toks[i]!;
    const isLetter = /[a-zA-Z]/.test(t);
    if (isLetter) {
      cmd = t;
      i++;
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === "Z") {
      const open = subs[subs.length - 1];
      if (open && open.length > 0) {
        open.push({ x: sx, y: sy });
        cx = sx;
        cy = sy;
      }
      pcx = null;
      pqx = null;
      /* Z takes no arguments, so an implicit repeat of it is not a thing. If the next
       * token is a number the path is malformed, and consuming it is what stops this
       * loop spinning forever on input the original would hang the tab on. */
      if (!isLetter) i++;
      continue;
    }

    let x: number;
    let y: number;
    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;
    switch (C) {
      case "M":
        x = num();
        y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        cx = x;
        cy = y;
        sx = x;
        sy = y;
        start(x, y);
        /* An M with extra coordinate pairs is an implicit lineto, and it keeps the
         * relative-ness of the M that opened it. */
        cmd = rel ? "l" : "L";
        pcx = null;
        pqx = null;
        break;
      case "L":
        x = num();
        y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        pen().push({ x, y });
        cx = x;
        cy = y;
        pcx = null;
        pqx = null;
        break;
      case "H":
        x = num();
        if (rel) x += cx;
        pen().push({ x, y: cy });
        cx = x;
        pcx = null;
        pqx = null;
        break;
      case "V":
        y = num();
        if (rel) y += cy;
        pen().push({ x: cx, y });
        cy = y;
        pcx = null;
        pqx = null;
        break;
      case "C":
        x1 = num();
        y1 = num();
        x2 = num();
        y2 = num();
        x = num();
        y = num();
        if (rel) {
          x1 += cx;
          y1 += cy;
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        flattenCubic(pen(), cx, cy, x1, y1, x2, y2, x, y, tol, 0);
        pcx = x2;
        pcy = y2;
        pqx = null;
        cx = x;
        cy = y;
        break;
      case "S":
        x2 = num();
        y2 = num();
        x = num();
        y = num();
        if (rel) {
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        x1 = pcx !== null ? 2 * cx - pcx : cx;
        y1 = pcx !== null ? 2 * cy - pcy : cy;
        flattenCubic(pen(), cx, cy, x1, y1, x2, y2, x, y, tol, 0);
        pcx = x2;
        pcy = y2;
        pqx = null;
        cx = x;
        cy = y;
        break;
      case "Q":
        x1 = num();
        y1 = num();
        x = num();
        y = num();
        if (rel) {
          x1 += cx;
          y1 += cy;
          x += cx;
          y += cy;
        }
        /* Degree elevation, exact: a quadratic's cubic controls sit one third and two
         * thirds of the way from each endpoint to the quadratic control point. */
        flattenCubic(
          pen(),
          cx,
          cy,
          (cx + 2 * x1) / 3,
          (cy + 2 * y1) / 3,
          (x + 2 * x1) / 3,
          (y + 2 * y1) / 3,
          x,
          y,
          tol,
          0,
        );
        pqx = x1;
        pqy = y1;
        pcx = null;
        cx = x;
        cy = y;
        break;
      case "T":
        x = num();
        y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        x1 = pqx !== null ? 2 * cx - pqx : cx;
        y1 = pqx !== null ? 2 * cy - pqy : cy;
        flattenCubic(
          pen(),
          cx,
          cy,
          (cx + 2 * x1) / 3,
          (cy + 2 * y1) / 3,
          (x + 2 * x1) / 3,
          (y + 2 * y1) / 3,
          x,
          y,
          tol,
          0,
        );
        pqx = x1;
        pqy = y1;
        pcx = null;
        cx = x;
        cy = y;
        break;
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const laf = num();
        const sf = num();
        x = num();
        y = num();
        if (rel) {
          x += cx;
          y += cy;
        }
        flattenArc(pen(), cx, cy, rx, ry, rot, laf !== 0, sf !== 0, x, y);
        pcx = null;
        pqx = null;
        cx = x;
        cy = y;
        break;
      }
      default:
        /* An unknown or absent command. Skip the token so the loop advances. */
        i++;
        continue;
    }
  }

  const out: Stroke[] = [];
  for (const s of subs) {
    const clean = finiteOnly(s);
    if (clean) out.push(clean);
  }
  return out;
}

/** Circle and ellipse sampling. 48 segments is 7.5 degrees, matching the arc step. */
const ELLIPSE_SEGMENTS = 48;

function attrNum(el: { getAttribute(n: string): string | null }, name: string): number {
  const v = parseFloat(el.getAttribute(name) ?? "");
  return Number.isFinite(v) ? v : 0;
}

/**
 * XML node names can carry a namespace prefix, and a document that declares SVG as
 * `svg:` rather than as the default namespace has every tag named `svg:path`. The
 * shipped importer matched on the bare name and silently produced nothing for those
 * documents. Strip the prefix and they import.
 */
function localName(n: XmlNode): string {
  const name = n.nodeName.toLowerCase();
  const colon = name.lastIndexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

export interface SvgOptions {
  /**
   * Flattening tolerance in the SVG's own user units. Curves arriving at the planner
   * already faceted cannot be recovered by anything downstream, so this wants to be
   * finer than the machine's own step, not coarser.
   */
  toleranceMm?: number;
}

/**
 * Parse an SVG document into strokes in the document's own user units, y up.
 *
 * The y flip is the last thing that happens, and it is not optional: SVG's y grows
 * downward and every target in this project has y growing up, so an import that
 * skips it draws the design upside down and nothing later in the chain can tell.
 *
 * The result is at NATURAL size, not normalised. Compose `centerFit` and
 * `scaleToField` from ops.ts to place it. Both shipped tools normalised inside the
 * importer, which meant an SVG authored at real millimetre size could not be drawn
 * at real millimetre size without undoing the normalisation first.
 */
export function svgToStrokes(text: string, parseXml: ParseXml, opts: SvgOptions = {}): SourceResult {
  const doc = parseXml(text);
  const root = doc.documentElement;
  if (!root) throw new Error("svg import: no document element");
  assertParsed(root);

  const tol = Math.max(MIN_TOLERANCE, opts.toleranceMm ?? MIN_TOLERANCE);
  const out: Stroke[] = [];

  const push = (poly: readonly Point[], m: Matrix): void => {
    if (poly.length > 1) out.push(poly.map((p) => matApply(m, p.x, p.y)));
  };

  const walk = (node: XmlNode, m: Matrix): void => {
    if (!isElement(node)) return;
    const mm = matMul(m, parseTransform(node.getAttribute("transform")));
    const tag = localName(node);

    if (tag === "path") {
      for (const poly of pathToStrokes(node.getAttribute("d") ?? "", tol)) push(poly, mm);
    } else if (tag === "line") {
      push(
        [
          { x: attrNum(node, "x1"), y: attrNum(node, "y1") },
          { x: attrNum(node, "x2"), y: attrNum(node, "y2") },
        ],
        mm,
      );
    } else if (tag === "rect") {
      const x = attrNum(node, "x");
      const y = attrNum(node, "y");
      const w = attrNum(node, "width");
      const h = attrNum(node, "height");
      /* Corner radii are ignored on purpose. A rounded rect drawn square is visibly
       * a rect; a rounded rect drawn wrong is a puzzle. */
      push(
        [
          { x, y },
          { x: x + w, y },
          { x: x + w, y: y + h },
          { x, y: y + h },
          { x, y },
        ],
        mm,
      );
    } else if (tag === "circle" || tag === "ellipse") {
      const ecx = attrNum(node, "cx");
      const ecy = attrNum(node, "cy");
      const rx = tag === "circle" ? attrNum(node, "r") : attrNum(node, "rx");
      const ry = tag === "circle" ? rx : attrNum(node, "ry");
      const poly: Point[] = [];
      for (let k = 0; k <= ELLIPSE_SEGMENTS; k++) {
        const t = (k / ELLIPSE_SEGMENTS) * Math.PI * 2;
        poly.push({ x: ecx + rx * Math.cos(t), y: ecy + ry * Math.sin(t) });
      }
      push(poly, mm);
    } else if (tag === "polyline" || tag === "polygon") {
      const n = (node.getAttribute("points") ?? "")
        .split(/[\s,]+/)
        .filter((v) => v.length > 0)
        .map(Number);
      const poly: Point[] = [];
      for (let k = 0; k + 1 < n.length; k += 2) poly.push({ x: n[k]!, y: n[k + 1]! });
      if (tag === "polygon" && poly.length > 0) poly.push({ ...poly[0]! });
      push(poly, mm);
    }

    /* Groups carry no geometry of their own, and every element recurses anyway,
     * because SVG allows a shape to have element children (title, desc, metadata)
     * and a group nested inside a group is the common case. */
    const kids = node.childNodes;
    for (let k = 0; k < kids.length; k++) walk(kids[k]!, mm);
  };

  walk(root, IDENTITY);

  const flipped = out.map((s) => s.map((p) => ({ x: p.x, y: -p.y })));
  return { strokes: flipped, bbox: bboxOf(flipped) };
}

/**
 * A browser DOMParser does not throw on malformed XML, it hands back a document
 * whose content is a `parsererror` element. Importing that produces zero strokes and
 * no explanation, which reads to a user as "my file is empty" rather than "my file
 * is broken". Check the root and its immediate children, which is where both Blink
 * and Gecko put it.
 */
function assertParsed(root: XmlNode): void {
  if (localName(root) === "parsererror") throw new Error("svg import: not valid xml");
  const kids = root.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]!;
    if (isElement(k) && localName(k) === "parsererror") {
      throw new Error("svg import: not valid xml");
    }
  }
}
