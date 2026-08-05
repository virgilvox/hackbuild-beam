#!/usr/bin/env node
/*
 * The detent rig's printed parts, back out to STL.
 *
 * The geometry has been in the tree since the sim page came in: that page carries
 * every part as an indexed mesh, quantised to sixteen bits over its own bounding
 * box. This turns the four PRINTED ones back into files a slicer can open. The
 * bought parts are not exported, because a mesh of a 28BYJ-48 is a picture of a
 * motor and not a thing anybody prints.
 *
 * Quantisation is not a concern at this scale and it is worth showing the working:
 * the largest part spans 71 mm, so sixteen bits over its own box is 71 / 65535,
 * about a micrometre. Two orders of magnitude under a printer's own resolution and
 * three under a 0.4 mm nozzle.
 *
 * WINDING IS a concern. The sim page shades with abs(dot(n, light)), so it renders
 * identically whichever way a triangle faces and could not have detected an
 * inconsistency. A slicer very much can. So every exported part is checked for
 * being watertight, consistently wound and positively oriented, and the result is
 * printed rather than assumed.
 *
 *   node tools/export-stl.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "originals/detent-sim/detent.html");
const OUT_DIR = resolve(ROOT, "hardware/detent-28byj");

/** The parts somebody prints. Everything else in the page is a bought part. */
const PRINTED = {
  chassis: { file: "chassis.stl", note: "the one piece body" },
  shell: { file: "cage.stl", note: "the snap cage" },
  hood: { file: "hood.stl", note: "the lid" },
  hub: { file: "hub.stl", note: "mirror carrier, print two" },
};

const html = readFileSync(SRC, "utf8");
const meta = JSON.parse(html.match(/const MESHMETA=(\{.*?\});\n/s)[1]);
const raw = Buffer.from(html.match(/const MESHB64="([A-Za-z0-9+/=]+)"/)[1], "base64");
const stamp = (html.match(/const MESHSTAMP="([0-9a-f]+)"/) || [])[1] ?? "unknown";

function decode(name) {
  const d = meta[name];
  const u = new Uint16Array(raw.buffer, raw.byteOffset + d.off, d.nv * 3);
  const pos = new Float32Array(d.nv * 3);
  for (let i = 0; i < d.nv; i++) {
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = d.lo[k] + (u[i * 3 + k] / 65535) * d.span[k];
    }
  }
  const idx = new Uint16Array(
    raw.buffer.slice(raw.byteOffset + d.ioff, raw.byteOffset + d.ioff + d.nf * 6),
  );
  return { pos, idx, nf: d.nf, nv: d.nv };
}

/**
 * Is this mesh printable.
 *
 * Watertight: every edge is used by exactly two triangles. A hole means the slicer
 * has to guess where the inside is.
 *
 * Consistently wound: those two uses run in opposite directions. If they run the
 * same way the two triangles disagree about which side is out, and a slicer that
 * trusts normals will carve a hole there.
 *
 * Positively oriented: the signed volume is positive, so the winding points out of
 * the solid rather than into it. An inside out mesh is watertight and consistent
 * and prints as the negative of the part.
 */
function inspect(m) {
  const edges = new Map();
  let volume = 0;
  let reversed = 0;
  for (let f = 0; f < m.nf; f++) {
    const a = m.idx[f * 3];
    const b = m.idx[f * 3 + 1];
    const c = m.idx[f * 3 + 2];
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      const e = edges.get(key) ?? { n: 0, fwd: 0 };
      e.n += 1;
      if (u < v) e.fwd += 1;
      edges.set(key, e);
    }
    /* Signed volume of the tetrahedron on the origin, summed over the surface. */
    const ax = m.pos[a * 3], ay = m.pos[a * 3 + 1], az = m.pos[a * 3 + 2];
    const bx = m.pos[b * 3], by = m.pos[b * 3 + 1], bz = m.pos[b * 3 + 2];
    const cx = m.pos[c * 3], cy = m.pos[c * 3 + 1], cz = m.pos[c * 3 + 2];
    volume +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let open = 0;
  for (const e of edges.values()) {
    if (e.n !== 2) open += 1;
    /* Used twice the same way round means the two faces disagree. */
    else if (e.fwd !== 1) reversed += 1;
  }
  return { open, reversed, volumeMm3: volume };
}

function writeStl(path, m, flip) {
  const buf = Buffer.alloc(84 + m.nf * 50);
  buf.write("BEAM detent, exported from the sim page geometry", 0);
  buf.writeUInt32LE(m.nf, 80);
  for (let f = 0; f < m.nf; f++) {
    const i0 = m.idx[f * 3];
    const i1 = m.idx[f * 3 + (flip ? 2 : 1)];
    const i2 = m.idx[f * 3 + (flip ? 1 : 2)];
    const p = [i0, i1, i2].map((i) => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]]);
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const o = 84 + f * 50;
    buf.writeFloatLE(nx, o);
    buf.writeFloatLE(ny, o + 4);
    buf.writeFloatLE(nz, o + 8);
    for (let k = 0; k < 3; k++) {
      buf.writeFloatLE(p[k][0], o + 12 + k * 12);
      buf.writeFloatLE(p[k][1], o + 16 + k * 12);
      buf.writeFloatLE(p[k][2], o + 20 + k * 12);
    }
  }
  writeFileSync(path, buf);
  return buf.length;
}

process.stderr.write(`detent geometry, build ${stamp}\n\n`);
process.stderr.write("part        tris     KB   watertight  wound  volume cm3\n");
let bad = 0;
for (const [name, spec] of Object.entries(PRINTED)) {
  const m = decode(name);
  const chk = inspect(m);
  /* A negative volume means the winding points into the solid. Flipping on write
   * is the fix, and is preferable to shipping an inside out part. */
  const flip = chk.volumeMm3 < 0;
  const bytes = writeStl(resolve(OUT_DIR, spec.file), m, flip);
  const ok = chk.open === 0 && chk.reversed === 0;
  if (!ok) bad += 1;
  process.stderr.write(
    spec.file.padEnd(12) +
      String(m.nf).padStart(6) +
      String(Math.round(bytes / 1024)).padStart(7) +
      (chk.open === 0 ? "     yes" : `  ${chk.open} open`).padStart(12) +
      (chk.reversed === 0 ? (flip ? "  flipped" : "     ok") : `  ${chk.reversed} bad`).padStart(9) +
      (Math.abs(chk.volumeMm3) / 1000).toFixed(1).padStart(12) +
      "\n",
  );
}
if (bad) {
  process.stderr.write(
    "\nSome parts are not closed solids. They are still written, because a slicer\n" +
      "may well repair them, but they should not be trusted without checking.\n",
  );
}
process.stderr.write(`\nwrote ${Object.keys(PRINTED).length} files to hardware/detent-28byj/\n`);
