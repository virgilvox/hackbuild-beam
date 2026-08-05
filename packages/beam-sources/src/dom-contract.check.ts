/// <reference lib="dom" />

/*
 * A type-level regression test, and it earns its keep: the first version of the
 * injected XML contract could not be satisfied by a real DOMParser at all, because
 * getAttribute sat on every node while the DOM only puts it on elements. The package
 * still compiled, the tests still passed, and the bug would have surfaced at the
 * moment someone wired up the real importer.
 *
 * This file is never built into dist. It exists so `pnpm typecheck` fails if the
 * contract stops accepting the only caller that matters.
 */

import type { GrayImage, ParseXml, XmlElement, XmlNode } from "./index.js";
import { isElement } from "./index.js";

declare const realParser: DOMParser;

/** The app must be able to hand us a real DOMParser. */
export const parseXml: ParseXml = (text: string) => realParser.parseFromString(text, "image/svg+xml");

/** A real Element is an XmlElement, and a real ChildNode is an XmlNode. */
declare const el: Element;
declare const cn: ChildNode;
export const asElement: XmlElement = el;
export const asNode: XmlNode = cn;

/** The walk the importer actually performs has to typecheck against the contract. */
export function collectPaths(n: XmlNode, out: string[]): void {
  if (isElement(n) && n.nodeName.toLowerCase() === "path") {
    const d = n.getAttribute("d");
    if (d) out.push(d);
  }
  for (let i = 0; i < n.childNodes.length; i++) collectPaths(n.childNodes[i]!, out);
}

/**
 * And the raster contract must accept what a real canvas hands back. The app does
 * the sampling and passes a plain buffer; this package never sees a canvas.
 */
declare const ctx: CanvasRenderingContext2D;
export function grayFromCanvas(w: number, h: number): GrayImage {
  const src = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0, o = 0; i < data.length; i++, o += 4) {
    /* The shipped weights, integer: 0.3 R + 0.6 G + 0.1 B. */
    data[i] = (src[o]! * 3 + src[o + 1]! * 6 + src[o + 2]!) / 10;
  }
  return { width: w, height: h, data };
}
