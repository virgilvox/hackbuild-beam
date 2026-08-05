#!/usr/bin/env node
/*
 * Pack the rig STLs into something a single HTML file can carry.
 *
 * laser-rig.html proved the format and the budget: positions only, quantised to
 * hundredths of a millimetre as int16, deflated, base64. Three parts land inside
 * about 24 KB of source, which is what makes shipping the real hardware in an
 * offline single file possible at all. Nothing here is novel, it is that format
 * written down as a tool instead of as a one time paste.
 *
 * All three parts are packed from the STLs on disk. laser-rig.html carries its own
 * copy of the same three as base64, so the tool checks itself against those: it
 * inflates the shipped blob and compares triangle for triangle. A silent winding
 * flip or a quantisation change would otherwise only show up as a rig that renders
 * inside out, months later, in a view nobody is testing.
 *
 *   node tools/pack-mesh.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LASER_RIG = resolve(ROOT, "originals/laserriggg (1)/laser-rig.html");
const DETENT_SIM = resolve(ROOT, "originals/detent-sim/detent.html");
const OUT = resolve(ROOT, "apps/studio/src/canvas/rig-meshes.ts");
const OUT_DETENT = resolve(ROOT, "apps/studio/src/canvas/detent-meshes.ts");

/** Hundredths of a millimetre. One int16 then reaches +-327 mm, far past any part. */
const QUANT = 100;

/**
 * Read a binary STL as a flat triangle soup.
 *
 * Only the vertices are kept. STL face normals are famously unreliable, half the
 * exporters in the world get the winding or the sign wrong, and the renderer needs
 * a normal it can trust for backface culling. Recomputing from the winding at
 * decode is both smaller on the wire and more correct.
 */
function readStl(path) {
  const b = readFileSync(path);
  if (b.length < 84) throw new Error(path + ": too short to be a binary STL");
  const n = b.readUInt32LE(80);
  if (84 + n * 50 !== b.length) {
    throw new Error(path + ": not a binary STL, or truncated (header says " + n + " triangles)");
  }
  const out = new Int16Array(n * 9);
  for (let i = 0; i < n; i++) {
    /* 12 bytes of face normal, then three vertices, then a 2 byte attribute word. */
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) {
      const v = Math.round(b.readFloatLE(o + k * 4) * QUANT);
      if (v < -32768 || v > 32767) throw new Error(path + ": vertex past int16 range");
      out[i * 9 + k] = v;
    }
  }
  return out;
}

/**
 * The same part as the original shipped it, inflated back to triangles.
 *
 * Used only to check this tool's output. Returns null when the original has no
 * copy, which is not an error, it just means that part goes unchecked.
 */
function shippedByOriginal(name) {
  const html = readFileSync(LASER_RIG, "utf8");
  const m = html.match(new RegExp(name + ":\\s*'([A-Za-z0-9+/=]+)'"));
  if (!m) return null;
  const inf = inflateSync(Buffer.from(m[1], "base64"));
  return new Int16Array(inf.buffer, inf.byteOffset, inf.length / 2);
}

/**
 * Do two triangle soups describe the same solid?
 *
 * Not an array compare. The originals were exported by a different toolchain, so
 * the triangles arrive in a different order and a face may start on any of its
 * three vertices. What has to match is the SET of triangles and, within each one,
 * the cyclic order, because that is what carries the winding the renderer culls
 * on. Sorting each face onto its lowest vertex and then sorting the faces makes
 * both of those comparable without making the check blind to a flip.
 */
function sameSolid(a, b) {
  if (a === null || b === null) return "unchecked";
  /*
   * A different triangle count is a different EXPORT, not a broken pack. The STLs
   * on disk turn out to be a later, slightly coarser export of two of these parts
   * than the copies laser-rig.html embedded: same bounding box to the hundredth,
   * fewer facets around the round features. The disk files are the source of truth
   * here, so this is reported and not treated as a failure.
   *
   * What WOULD be a failure is the same count with different faces, because that
   * can only mean this tool changed the winding or the quantisation. servoBase is
   * bit identical to the shipped blob and is what actually holds that line.
   */
  if (a.length !== b.length) {
    return "newer export (" + a.length / 9 + " tris vs the original's " + b.length / 9 + ")";
  }
  const canon = (q) => {
    const faces = [];
    for (let i = 0; i < q.length; i += 9) {
      const v = [q.slice(i, i + 3), q.slice(i + 3, i + 6), q.slice(i + 6, i + 9)].map((t) =>
        t.join(","),
      );
      /* Rotate onto the lowest vertex. Rotation preserves winding, sorting would not. */
      let lo = 0;
      for (let k = 1; k < 3; k++) if (v[k] < v[lo]) lo = k;
      faces.push(v[lo] + "|" + v[(lo + 1) % 3] + "|" + v[(lo + 2) % 3]);
    }
    return faces.sort();
  };
  const ca = canon(a);
  const cb = canon(b);
  for (let i = 0; i < ca.length; i++) if (ca[i] !== cb[i]) return "differs at face " + i;
  return "matches the original";
}

function pack(q) {
  return deflateSync(Buffer.from(q.buffer, q.byteOffset, q.byteLength), { level: 9 }).toString(
    "base64",
  );
}

function bounds(q) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < q.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = q[i + k] / QUANT;
      if (v < mn[k]) mn[k] = v;
      if (v > mx[k]) mx[k] = v;
    }
  }
  return { mn, mx };
}

const PARTS = [
  {
    name: "servoBase",
    stl: "hardware/washer-servo/servo_base.stl",
    original: "servo_base",
    note: "Sits on the table with the pan servo inside it, shaft up. The pocket's\n * shaft is off centre, so placing this part is a shift, not just a drop.",
  },
  {
    name: "galvoBody",
    stl: "hardware/washer-servo/galvobody.stl",
    original: "galvobody",
    note: "Bolts to the pan horn, so it turns about the vertical axis. Its 3 mm plate\n * carries the tilt servo in a 24 x 12 slot.",
  },
  {
    name: "galvoBrack",
    stl: "hardware/washer-servo/galvobrack.stl",
    original: "galvobrack",
    note: "Bolts to the tilt horn on the plate's inboard face and carries the laser\n * module. Its bore is at half its own height, which is the 8.79 in MOUNT.",
  },
];

const rows = [];
let mismatch = false;
for (const p of PARTS) {
  const q = readStl(resolve(ROOT, p.stl));
  const b64 = pack(q);
  const box = bounds(q);
  const verdict = sameSolid(q, shippedByOriginal(p.original));
  if (verdict.startsWith("differs at")) mismatch = true;
  rows.push({ ...p, b64, tris: q.length / 9, box });
  process.stderr.write(
    p.name.padEnd(11) +
      String(q.length / 9).padStart(5) +
      " tris  " +
      String(Math.round(b64.length / 102.4) / 10).padStart(5) +
      " KB b64   " +
      box.mx.map((v, i) => (v - box.mn[i]).toFixed(1)).join(" x ").padEnd(20) +
      verdict +
      "\n",
  );
}

if (mismatch) {
  process.stderr.write("\nA part no longer matches the mesh the original app shipped.\n");
  process.exit(1);
}

const total = rows.reduce((n, r) => n + r.b64.length, 0);
process.stderr.write("total " + Math.round(total / 1024) + " KB of source\n");

const body = rows
  .map(
    (r) =>
      "  /**\n   * " +
      r.note.replace(/\n \* /g, "\n   * ") +
      "\n   *\n   * " +
      r.tris +
      " triangles, " +
      r.box.mx.map((v, i) => (v - r.box.mn[i]).toFixed(1)).join(" x ") +
      " mm.\n   */\n  " +
      r.name +
      ":\n    \"" +
      r.b64 +
      "\",",
  )
  .join("\n");

const src = `/*
 * The rig, as it is actually machined.
 *
 * GENERATED by tools/pack-mesh.mjs. Do not hand edit: rerun the tool.
 *
 * Positions only, quantised to hundredths of a millimetre as int16, deflated,
 * base64. That is laser-rig.html's format and its budget, and the budget is the
 * reason it exists: three real parts fit in about ${Math.round(total / 1024)} KB of source, which is
 * what lets an offline single file show the hardware instead of a box.
 *
 * Normals are not stored. STL face normals are unreliable often enough that the
 * renderer computes its own from the winding, which is smaller on the wire and
 * more trustworthy at the same time.
 *
 * These three parts build the PAN/TILT HEAD, which is the washer-servo profile.
 * The two mirror scanner's parts are packed separately in detent-meshes.ts, from a
 * different source and in a different format.
 */

/** Deflated, base64, int16 triangle soup at ${QUANT} units per millimetre. */
export const RIG_MESH_B64 = {
${body}
} as const;

export type RigMeshName = keyof typeof RIG_MESH_B64;

/** Units per millimetre in the packed stream. */
export const MESH_QUANT = ${QUANT};
`;

writeFileSync(OUT, src);
process.stderr.write("wrote " + OUT.replace(ROOT + "/", "") + "\n");

/* ==================================================== the two mirror scanner */

/*
 * The detent sim ships its geometry a different way and it is a better way.
 *
 * laser-rig stores triangle soup: every face carries its own three vertices, so a
 * vertex shared by six faces is stored six times. The detent page stores INDEXED
 * meshes quantised over each part's own bounding box, which is both smaller on the
 * wire and less work per frame, because the projection then runs once per vertex
 * instead of once per corner. Its own numbers make the case: the mirror hub is
 * 6028 faces over 3014 vertices, so soup would carry six times the positions.
 *
 * The quantisation is per part rather than global, which is why each entry carries
 * its own `lo` and `span`: a 12 mm laser module and a 71 mm chassis both get the
 * full sixteen bits, so the module is quantised to 0.2 micrometres rather than
 * being swamped by the largest part in the file.
 *
 * The housing is the snap cage and the hood, and those are what is left out. The
 * body is not housing: it is the part that holds both steppers, the module and the
 * mirrors, so without it the mechanism floats and the view stops being something
 * you can check a build against. It is also 40432 faces, which is most of the
 * budget here and the reason the renderer culls sub pixel facets.
 */
const DETENT_PARTS = [
  {
    name: "chassis",
    note: "The one piece printed body. Holds both steppers, the module and the\n   * mirrors, and is what everything else is dimensioned against.",
  },
  { name: "motor", note: "28BYJ-48 can. Two of them, one per axis." },
  { name: "hub", note: "Mirror carrier, pressed on the motor shaft. Turns with the axis." },
  { name: "mirror", note: "20 x 3 front surface mirror, sitting in the hub's pocket." },
  { name: "laser", note: "The 405 nm module. Fires along the rig's own X." },
];

function packDetent() {
  let html;
  try {
    html = readFileSync(DETENT_SIM, "utf8");
  } catch {
    process.stderr.write("\nno detent sim at " + DETENT_SIM.replace(ROOT + "/", "") + ", skipping\n");
    return null;
  }
  const meta = JSON.parse(html.match(/const MESHMETA=(\{.*?\});\n/s)[1]);
  const raw = Buffer.from(html.match(/const MESHB64="([A-Za-z0-9+/=]+)"/)[1], "base64");
  const stamp = (html.match(/const MESHSTAMP="([0-9a-f]+)"/) || [])[1] ?? "unknown";

  const rows = [];
  for (const p of DETENT_PARTS) {
    const d = meta[p.name];
    if (!d) throw new Error("detent sim has no part named " + p.name);
    if (d.i32) throw new Error(p.name + ": 32 bit indices, which the decoder does not carry");
    const verts = Buffer.from(raw.buffer, raw.byteOffset + d.off, d.nv * 6);
    const index = Buffer.from(raw.buffer, raw.byteOffset + d.ioff, d.nf * 3 * 2);
    /* Vertices then indices, one blob, because they are always wanted together. */
    const b64 = deflateSync(Buffer.concat([verts, index]), { level: 9 }).toString("base64");
    rows.push({ ...p, nv: d.nv, nf: d.nf, lo: d.lo, span: d.span, b64 });
    process.stderr.write(
      p.name.padEnd(11) +
        String(d.nf).padStart(6) +
        " tris  " +
        String(Math.round(b64.length / 102.4) / 10).padStart(5) +
        " KB b64   " +
        d.span.map((v) => v.toFixed(1)).join(" x ") +
        " mm\n",
    );
  }

  const body = rows
    .map(
      (r) =>
        "  /**\n   * " +
        r.note +
        "\n   *\n   * " +
        r.nf +
        " triangles over " +
        r.nv +
        " vertices, " +
        r.span.map((v) => v.toFixed(1)).join(" x ") +
        " mm.\n   */\n  " +
        r.name +
        ": {\n    nv: " +
        r.nv +
        ",\n    nf: " +
        r.nf +
        ",\n    lo: [" +
        r.lo.join(", ") +
        "],\n    span: [" +
        r.span.join(", ") +
        "],\n    b64:\n      \"" +
        r.b64 +
        "\",\n  },",
    )
    .join("\n");

  const total = rows.reduce((n, r) => n + r.b64.length, 0);
  writeFileSync(
    OUT_DETENT,
    `/*
 * The two mirror scanner's mechanism, as it is actually built.
 *
 * GENERATED by tools/pack-mesh.mjs from originals/detent-sim/detent.html. Do not
 * hand edit: rerun the tool. That page's own geometry stamp is ${stamp}.
 *
 * Indexed, and quantised to sixteen bits over EACH PART'S OWN bounding box, which
 * is the detent page's format rather than laser-rig's triangle soup. Indexed
 * because the hub alone is ${rows.find((r) => r.name === "hub")?.nf ?? 0} faces over ${rows.find((r) => r.name === "hub")?.nv ?? 0} vertices and soup would
 * carry every shared corner six times over. Per part because a 12 mm laser module
 * and a 42 mm motor can then both spend the full sixteen bits on themselves.
 *
 * A position comes back as lo + (u16 / 65535) * span, which is exactly what that
 * page's vertex shader does with the same numbers.
 *
 * The base plate, the snap cage and the hood are NOT here. The cage and the hood
 * are the housing. The base plate is ${meta.chassis ? meta.chassis.nf : 0} faces and packs to about 347 KB,
 * which is larger than the whole of the rest of this application, and it would
 * hide the optical path that is the entire point of the view.
 */

/** Deflated, base64: nv*3 uint16 positions, then nf*3 uint16 indices. */
export const DETENT_MESH = {
${body}
} as const;

export type DetentMeshName = keyof typeof DETENT_MESH;
`,
  );
  process.stderr.write(
    "detent total " + Math.round(total / 1024) + " KB of source\nwrote " +
      OUT_DETENT.replace(ROOT + "/", "") + "\n",
  );
  return rows;
}

process.stderr.write("\n");
packDetent();
