import { RIG_MESH_B64, MESH_QUANT, type RigMeshName } from "./rig-meshes.js";

/*
 * Getting the real parts into memory.
 *
 * Decoding only. The drawing lives in mesh-gl.ts, because these solids need a
 * depth buffer: a 2D painter sorted by centroid depth is exact for a convex part
 * and wrong for a concave one, and the scanner body has pockets and internal walls
 * that sort ahead of the wall in front of them. Still no scene graph and still no
 * dependency, just one shader and a depth test.
 */

/**
 * A part, ready to draw. Positions in millimetres.
 *
 * Two shapes, because the two source apps chose differently and both choices were
 * right for what they carried. Without `idx` the positions are triangle soup, three
 * consecutive vertices per face, which is what an STL is. With `idx` they are an
 * indexed mesh and a shared corner is stored once, which is how the detent page
 * ships its parts: its mirror hub is 6028 faces over 3014 vertices, so soup would
 * carry every corner six times and the projection would run six times too.
 */
export interface Mesh {
  pos: Float32Array;
  tris: number;
  idx?: Uint16Array | null;
}

/** Per part quantisation, as the detent page stores it. */
export interface QuantisedPart {
  nv: number;
  nf: number;
  lo: readonly number[];
  span: readonly number[];
  b64: string;
}

/**
 * Inflate one indexed part.
 *
 * Positions arrive as unsigned sixteenths of the part's OWN bounding box rather
 * than in a global unit, so each part spends its whole sixteen bits on itself: a
 * 12 mm laser module resolves to about two tenths of a micrometre instead of being
 * swamped by the largest part in the file. Undoing that is the same arithmetic the
 * source page does in its vertex shader.
 */
export async function decodeQuantised(part: QuantisedPart): Promise<Mesh> {
  const raw = Uint8Array.from(atob(part.b64), (c) => c.charCodeAt(0));
  const ds = new DecompressionStream("deflate");
  const buf = await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(ds)).arrayBuffer();
  const u = new Uint16Array(buf);
  const pos = new Float32Array(part.nv * 3);
  const lo = part.lo;
  const span = part.span;
  for (let i = 0; i < part.nv; i++) {
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = lo[k]! + (u[i * 3 + k]! / 65535) * span[k]!;
    }
  }
  /* Indices follow the positions in the same blob. */
  const idx = new Uint16Array(part.nf * 3);
  idx.set(u.subarray(part.nv * 3, part.nv * 3 + part.nf * 3));
  return { pos, tris: part.nf, idx };
}

/**
 * Inflate one packed part.
 *
 * DecompressionStream is the same primitive laser-rig.html used and it is in every
 * browser that can do Web Bluetooth, so there is no fallback path to maintain: a
 * browser that cannot inflate this also cannot talk to the rig.
 */
export async function decodeMesh(name: RigMeshName): Promise<Mesh> {
  const b64 = RIG_MESH_B64[name];
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const ds = new DecompressionStream("deflate");
  const buf = await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(ds)).arrayBuffer();
  const q = new Int16Array(buf);
  const pos = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) pos[i] = q[i]! / MESH_QUANT;
  return { pos, tris: q.length / 9 };
}

/**
 * Mesh millimetres to camera space, as one flat 3x4.
 *
 * Rows are [xx xy xz tx, yx yy yz ty, zx zy zz tz]. The part transform and the
 * camera rotation are folded together once per part per frame so the inner loop
 * over ten thousand vertices is nine multiplies and three adds with no branches
 * and no allocation.
 */
export type Mat34 = Float64Array;

export function mat34(): Mat34 {
  return new Float64Array(12);
}

/**
 * Build a transform from an orthonormal-ish basis and an origin.
 *
 * The three axes are the part's own forward, up and lateral expressed in model
 * space, already scaled, so this doubles as the millimetres-to-model-units scale.
 */
export function basisTo(
  out: Mat34,
  ex: readonly [number, number, number],
  ey: readonly [number, number, number],
  ez: readonly [number, number, number],
  origin: readonly [number, number, number],
): Mat34 {
  out[0] = ex[0];
  out[1] = ey[0];
  out[2] = ez[0];
  out[3] = origin[0];
  out[4] = ex[1];
  out[5] = ey[1];
  out[6] = ez[1];
  out[7] = origin[1];
  out[8] = ex[2];
  out[9] = ey[2];
  out[10] = ez[2];
  out[11] = origin[2];
  return out;
}

/** camera . model, so the per vertex loop applies one matrix instead of two. */
export function composeCamera(out: Mat34, cam: Mat34, model: Mat34): Mat34 {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 4 + c] =
        cam[r * 4]! * model[c]! + cam[r * 4 + 1]! * model[4 + c]! + cam[r * 4 + 2]! * model[8 + c]!;
    }
    out[r * 4 + 3] =
      cam[r * 4]! * model[3]! +
      cam[r * 4 + 1]! * model[7]! +
      cam[r * 4 + 2]! * model[11]! +
      cam[r * 4 + 3]!;
  }
  return out;
}

/**
 * A closed cylinder along local +X, unit length and unit radius.
 *
 * The pan/tilt head's laser module has no STL because it is a bought part, but it
 * still has to be a solid: drawn as an overlay it would sit in front of the very
 * bracket that grips it, and left out entirely the beam springs from thin air 29 mm
 * ahead of the rig. Generated rather than packed because a cylinder is four lines
 * of arithmetic and would otherwise cost real bytes in a file that has to open
 * offline.
 *
 * Unit sized so the placement carries both the length and the radius, which is how
 * every other part here is scaled.
 */
export function unitCylinder(segments = 20): Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  /* Two rings, then a centre for each cap. */
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pos.push(0, c, s, 1, c, s);
  }
  const capA = pos.length / 3;
  pos.push(0, 0, 0);
  const capB = pos.length / 3;
  pos.push(1, 0, 0);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const a0 = i * 2;
    const a1 = a0 + 1;
    const b0 = j * 2;
    const b1 = b0 + 1;
    idx.push(a0, b0, a1, a1, b0, b1);
    idx.push(capA, b0, a0);
    idx.push(capB, a1, b1);
  }
  return { pos: new Float32Array(pos), tris: idx.length / 3, idx: new Uint16Array(idx) };
}
