/**
 * @virgilvox/beam-sources
 *
 * Content in, strokes out. Every source returns the same shape: an array of
 * polylines in target millimetres, y up, at natural size, plus flags such as
 * `noReorder` for raster rows that must stay serpentine.
 *
 * Nothing here reaches for a DOM primitive. `svg` takes a `parseXml` function and
 * `raster` takes a grayscale buffer, so the app passes the real thing and tests
 * pass a shim, and every source stays runnable headless. That rule is enforced by
 * lint, not by convention.
 *
 * The implementations are ported from the two shipped tools, not rewritten. Where
 * both tools had a version of the same thing the merge picks the more complete one
 * and says why in that file's header: the servo tool's stroke font, because it stores
 * curves as curves; the stepper tool's SVG importer, because it parses the path
 * grammar itself and therefore does not need a live document to run.
 */

import type { Point } from "@virgilvox/beam-core";

/** One continuous run of the beam. Consecutive points are drawn between. */
export type Stroke = Point[];

export interface SourceResult {
  strokes: Stroke[];
  /**
   * Bounding box in the source's own natural units, before placement.
   */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /**
   * Set by the raster source. Serpentine rows are already ordered so the head never
   * travels back across a row, and letting the travel optimiser reorder them undoes
   * exactly that.
   */
  noReorder?: boolean;
}

/**
 * The one primitive an SVG importer needs, injected rather than reached for.
 *
 * Deliberately structural rather than the DOM's `Document`. Naming the real type
 * would pull the DOM lib into a package that must stay headless, and it would force
 * a test shim to implement all of `Document` to satisfy the compiler. This is the
 * subset the importer actually touches, which is the honest contract: the app
 * passes a real `DOMParser` result and it satisfies this structurally, and a test
 * passes twenty lines of shim.
 */
/**
 * A node in the tree. Note that `getAttribute` is NOT here.
 *
 * That is not tidiness, it is the difference between an interface a real
 * `DOMParser` satisfies and one it does not. In the DOM, `childNodes` yields
 * `ChildNode`, and `ChildNode` has no `getAttribute` because a text node does not
 * have attributes. Putting `getAttribute` on this type makes the recursion
 * unsatisfiable and the whole injected-primitive contract unusable by the only
 * caller that matters.
 *
 * It also happens to be the shape the importer actually wants: walk `childNodes`,
 * skip anything whose `nodeType` is not 1, and only then ask for attributes.
 */
export interface XmlNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly childNodes: ArrayLike<XmlNode>;
}

/** `nodeType === 1`. The only kind of node that carries attributes. */
export interface XmlElement extends XmlNode {
  getAttribute(name: string): string | null;
}

export const ELEMENT_NODE = 1;

/** The narrowing the walker performs on every child. */
export function isElement(n: XmlNode): n is XmlElement {
  return n.nodeType === ELEMENT_NODE;
}

export interface XmlDocument {
  readonly documentElement: XmlElement;
}

export type ParseXml = (text: string) => XmlDocument;

/**
 * The one primitive a rasteriser needs. Width, height and one byte of luminance per
 * pixel. The app does the canvas sampling; this package never sees a canvas.
 */
export interface GrayImage {
  width: number;
  height: number;
  /** Row major, one byte per pixel, 0 black to 255 white. */
  data: Uint8Array;
}

export const SOURCES = ["text", "svg", "image", "sketch", "model3d", "pattern"] as const;
export type SourceKind = (typeof SOURCES)[number];

/*
 * The sources themselves. These import the types above, so the re-exports come after
 * the declarations rather than at the top of the file.
 */

export {
  EMPTY_BBOX,
  bboxCentre,
  bboxHeight,
  bboxOf,
  bboxWidth,
  centerFit,
  orderStrokes,
  scaleToField,
  toPoints,
  translateStrokes,
  travelMm,
  type Bbox,
  type OrderOptions,
} from "./ops.js";

export {
  FLATTEN_TOLERANCE_FRACTION,
  FONT_METRICS,
  GLYPHS,
  clearGlyphCache,
  flattenQuadratic,
  glyphStrokes,
  offsetPolyline,
  quadraticMaxDeviation,
  textToStrokes,
  type FontMetrics,
  type GlyphDef,
  type TextOptions,
} from "./font.js";

export {
  IDENTITY,
  flattenArc,
  matApply,
  matMul,
  parseTransform,
  pathToStrokes,
  svgToStrokes,
  type Matrix,
  type SvgOptions,
} from "./svg.js";

export {
  DEFAULT_THRESHOLD,
  MIN_RUN_STEP_FRACTION,
  rasterToStrokes,
  type RasterOptions,
} from "./raster.js";

export {
  HUNT_RAMP_START_RATE,
  HUNT_RAMP_STEPS,
  HUNT_RATES,
  HUNT_SAFE_FRACTION,
  HUNT_SPAN_STEPS,
  PATTERN_FIELD_FRACTION,
  RATE_RAMP_LINES,
  RULER_MARKS,
  huntLeg,
  huntPass,
  lashGauge,
  rateRamp,
  ruler,
  squareWithDiagonals,
  stallHunt,
  type FieldSize,
  type HuntAxis,
  type HuntPoint,
  type HuntStep,
} from "./patterns.js";

export {
  MODEL_SCALE,
  TESSERACT_ROT_RATIO,
  TESSERACT_W_PLANE,
  build3d,
  curveKnot,
  curveLissajous,
  curveSphere,
  modelCube,
  modelIcosahedron,
  modelTesseract,
  project,
  rot3,
  rot4,
  type Model3dOptions,
  type ModelKind,
  type Vec3,
  type Vec4,
  type Wireframe,
} from "./models3d.js";

export {
  STAR_INNER_RADIUS,
  buildShape,
  circle,
  grid,
  spiral,
  star,
  type ShapeKind,
  type ShapeOptions,
} from "./shapes.js";
