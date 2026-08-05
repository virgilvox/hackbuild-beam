import type { Mesh } from "./mesh.js";

/*
 * The parts, with a real depth buffer.
 *
 * The 2D painter this replaces could not draw these solids correctly and no amount
 * of tuning would have fixed it. Painting back to front by centroid depth is exact
 * for a convex part and wrong for a concave one: the scanner body has pockets,
 * internal walls and a floor that sit inside its own silhouette, so faces on the
 * far side of the part sort ahead of faces on the near side and get painted over
 * them. On screen that reads as the body being see through, which is what it was.
 *
 * Measured before changing anything, because the obvious suspect was the sub pixel
 * cull punching holes: at the size this draws, the cull accounts for 95 pixels out
 * of 64273 covered, or 0.15 percent. It was never the cull.
 *
 * So the mesh layer moves to WebGL2, which is what the detent page uses for the
 * same geometry and for the same reason. This is not a scene graph and it is not a
 * dependency: one program, one draw call per part, and a depth buffer. Everything
 * that is not a solid stays on the 2D canvas above it.
 *
 * The projection is deliberately NOT a normal perspective matrix. It reproduces
 * the 2D canvas's own weak perspective line for line, because the beam, the target
 * plane and every label are still drawn in 2D through that arithmetic. Anything
 * else and the rig would drift away from its own beam as the camera swings, which
 * is precisely the bug laser-rig.html shipped when its rig view and its aiming
 * used different mappings.
 */

/** Camera depth that maps to the far plane. The whole scene is a few hundred. */
const Z_FAR = 2000;

const VERT = `#version 300 es
in vec3 aPos;
uniform mat3 uRot;     // camera rotation, model space to camera space
uniform mat3 uBasis;   // the part's own basis, already scaled
uniform vec3 uOrigin;  // the part's origin, in model units
uniform vec4 uScreen;  // ox, oy, sc, dist
uniform vec2 uSize;    // drawing surface, in the same units ox and oy are in
out vec3 vCam;
void main(){
  vec3 m = uOrigin + uBasis * aPos;
  vec3 c = uRot * m;
  /* The same weak perspective the 2D canvas uses. 0.9 on the depth term is the
     original's: enough parallax to read as depth, not enough to bend a bench. */
  float w = 1.0 + 0.9 * c.z / uScreen.w;
  float sx = uScreen.x + uScreen.z * c.x / w;
  float sy = uScreen.y - uScreen.z * c.y / w;
  /* Screen pixels back to clip space. Multiplying through by w cancels the
     divide the hardware is about to do, so what lands on screen is exactly the
     pixel the 2D code would have computed. */
  float xn = 2.0 * sx / uSize.x - 1.0;
  float yn = 1.0 - 2.0 * sy / uSize.y;
  /* Depth is linear in camera z rather than in 1/z: the scene is two hundred
     units deep and there is no near plane to crowd, so a linear buffer has
     precision to spare and no z fighting anywhere. */
  float zn = c.z / ${Z_FAR}.0;
  gl_Position = vec4(xn * w, yn * w, zn * w, w);
  vCam = c;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vCam;
uniform vec3 uLo, uHi, uLight;
out vec4 o;
void main(){
  /* Flat shaded from the derivative of camera position across the triangle, so
     the mesh needs no normals on the wire and a part's facets read as facets. */
  vec3 n = normalize(cross(dFdx(vCam), dFdy(vCam)));
  /* Half lambert, matching the 2D renderer this replaces: a pure lambert drops
     every face turned from the light onto the floor colour, which on parts this
     faceted collapses whole features into one silhouette. */
  float lit = clamp(0.5 + 0.5 * dot(n, uLight), 0.0, 1.0);
  o = vec4(mix(uLo, uHi, lit), 1.0);
}`;

export interface GlPart {
  vao: WebGLVertexArrayObject;
  count: number;
  /** UNSIGNED_SHORT for indexed parts; 0 when the part is drawn as an array. */
  indexType: number;
}

export interface GlView {
  gl: WebGL2RenderingContext;
  prog: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
  parts: Map<Mesh, GlPart>;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    /* Left as a console error rather than thrown: a rig that will not shade is
     * still a rig you can orbit, and the 2D overlay carries the beam regardless. */
    console.error(gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

/** Bring up the context, or return null and let the caller keep its schematic. */
export function initGl(canvas: HTMLCanvasElement): GlView | null {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, depth: true });
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(prog));
    return null;
  }
  const loc: Record<string, WebGLUniformLocation | null> = {};
  for (const n of ["uRot", "uBasis", "uOrigin", "uScreen", "uSize", "uLo", "uHi", "uLight"]) {
    loc[n] = gl.getUniformLocation(prog, n);
  }
  return { gl, prog, loc, parts: new Map() };
}

/** Upload a part once and remember it. Keyed by the mesh itself. */
function upload(v: GlView, mesh: Mesh): GlPart | null {
  const hit = v.parts.get(mesh);
  if (hit) return hit;
  const gl = v.gl;
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  if (!vao || !vbo) return null;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(v.prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

  let indexType = 0;
  if (mesh.idx) {
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
    indexType = gl.UNSIGNED_SHORT;
  }
  gl.bindVertexArray(null);
  const part: GlPart = { vao, count: mesh.tris * 3, indexType };
  v.parts.set(mesh, part);
  return part;
}

export interface GlFrame {
  /** Camera rotation, row major 3x3, the same one the 2D canvas builds. */
  rot: Float32Array;
  ox: number;
  oy: number;
  sc: number;
  dist: number;
  /** Drawing surface in CSS pixels, matching the units ox and oy are given in. */
  w: number;
  h: number;
  /** Background, as the 2D canvas would have filled it. */
  clear: [number, number, number];
  light: readonly [number, number, number];
}

export function beginFrame(v: GlView, f: GlFrame, dpr: number) {
  const gl = v.gl;
  const W = Math.round(f.w * dpr);
  const H = Math.round(f.h * dpr);
  if (gl.canvas.width !== W || gl.canvas.height !== H) {
    gl.canvas.width = W;
    gl.canvas.height = H;
  }
  gl.viewport(0, 0, W, H);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  /*
   * No face culling. The depth buffer already resolves what is in front, and
   * these meshes come from three different toolchains: trusting every one of them
   * to have wound every triangle outward is how a part ends up with holes in it.
   * Drawing both sides costs nothing here and cannot be wrong.
   */
  gl.disable(gl.CULL_FACE);
  gl.clearColor(f.clear[0], f.clear[1], f.clear[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.useProgram(v.prog);
  gl.uniformMatrix3fv(v.loc.uRot!, false, f.rot);
  gl.uniform4f(v.loc.uScreen!, f.ox, f.oy, f.sc, f.dist);
  /* CSS pixels, not device pixels: ox, oy and sc are all in CSS pixels, and the
   * viewport has already taken the ratio into account. */
  gl.uniform2f(v.loc.uSize!, f.w, f.h);
  gl.uniform3f(v.loc.uLight!, f.light[0], f.light[1], f.light[2]);
}

/** One part, at one placement, in one material. */
export function drawGl(
  v: GlView,
  mesh: Mesh,
  basis: Float32Array,
  origin: readonly [number, number, number],
  lo: readonly [number, number, number],
  hi: readonly [number, number, number],
) {
  const part = upload(v, mesh);
  if (!part) return;
  const gl = v.gl;
  gl.uniformMatrix3fv(v.loc.uBasis!, false, basis);
  gl.uniform3f(v.loc.uOrigin!, origin[0], origin[1], origin[2]);
  gl.uniform3f(v.loc.uLo!, lo[0], lo[1], lo[2]);
  gl.uniform3f(v.loc.uHi!, hi[0], hi[1], hi[2]);
  gl.bindVertexArray(part.vao);
  if (part.indexType) gl.drawElements(gl.TRIANGLES, part.count, part.indexType, 0);
  else gl.drawArrays(gl.TRIANGLES, 0, part.count);
  gl.bindVertexArray(null);
}
