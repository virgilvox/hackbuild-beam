<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import type { MachineProfile, Point } from "@virgilvox/beam-core";

/**
 * The target plane: what the machine is aiming at, drawn from above the operator's
 * point of view.
 *
 * It draws three things and the order matters. The ideal path as a ghost, the
 * simulated path as the solid trace, and the live beam position. The simulated path
 * is the one drawn solid because it is what the wall will show: the preview is only
 * worth looking at if it replays the machine's real behavior rather than the plan.
 */
const props = defineProps<{
  profile: MachineProfile | null;
  fieldW: number;
  fieldH: number;
  /** Ideal polylines in mm, what was asked for. */
  strokes: Point[][];
  /** What the machine will actually do, after quantisation and the error model. */
  simulated: { x: number; y: number; on: boolean }[];
  /** Where the beam is now, in mm. */
  live: Point | null;
  beamOn: boolean;
  /** Captured corners in axis units, TL TR BR BL. */
  corners: Array<[number, number] | null>;
  showLattice: boolean;
  showIdeal: boolean;
  clipped: boolean;
}>();

const emit = defineEmits<{
  (e: "aim", p: Point): void;
  (e: "draw", p: Point): void;
  (e: "draw-end"): void;
}>();

const cv = ref<HTMLCanvasElement | null>(null);
const wrap = ref<HTMLDivElement | null>(null);
const cursor = ref<Point | null>(null);
let dragging = false;
let ro: ResizeObserver | null = null;

/* View transform, recomputed on every paint so a resize needs no bookkeeping. */
let k = 1;
let ox = 0;
let oy = 0;
const PAD = 26;

function toPx(p: Point): [number, number] {
  return [ox + p.x * k, oy - p.y * k];
}
function toMm(clientX: number, clientY: number): Point {
  const r = cv.value!.getBoundingClientRect();
  return { x: (clientX - r.left - ox) / k, y: -(clientY - r.top - oy) / k };
}

/*
 * Two layers, because they change at wildly different rates.
 *
 * The lattice, the field, the ideal ghost and the simulated path depend only on the
 * plan and the geometry. The beam position changes on every frame of a plot. Drawing
 * both together meant every beam move recomputed roughly twelve hundred profile
 * forward maps for the lattice and stroked five thousand path points, which took
 * about 800 ms and made a plot advance at fifteen points a second.
 *
 * So the slow half is rendered once into an offscreen canvas and blitted.
 */
let bg: HTMLCanvasElement | null = null;

/*
 * Cache validity by reference, never by serialising.
 *
 * The first version of this built a string key and included the point arrays in it,
 * which stringified five thousand objects on every single paint. That is worse than
 * the problem it was written to fix: it turned a slow repaint into a slow repaint
 * that also allocated seventy kilobytes of string per frame.
 *
 * The arrays are replaced wholesale on replan, so identity is exactly the right
 * test and it is free.
 */
interface BgKey {
  w: number; h: number; fieldW: number; fieldH: number;
  profile: unknown; strokes: unknown; simulated: unknown;
  lattice: boolean; ideal: boolean; clipped: boolean;
}
let bgKeyObj: BgKey | null = null;

function currentKey(w: number, h: number): BgKey {
  return {
    w, h,
    fieldW: props.fieldW, fieldH: props.fieldH,
    profile: props.profile,
    strokes: props.strokes,
    simulated: props.simulated,
    lattice: props.showLattice, ideal: props.showIdeal, clipped: props.clipped,
  };
}

function sameKey(a: BgKey | null, b: BgKey): boolean {
  if (!a) return false;
  return a.w === b.w && a.h === b.h && a.fieldW === b.fieldW && a.fieldH === b.fieldH
    && a.profile === b.profile && a.strokes === b.strokes && a.simulated === b.simulated
    && a.lattice === b.lattice && a.ideal === b.ideal && a.clipped === b.clipped;
}

function paintBackground(w: number, h: number, dpr: number) {
  if (!bg) bg = document.createElement("canvas");
  if (bg.width !== Math.round(w * dpr) || bg.height !== Math.round(h * dpr)) {
    bg.width = Math.round(w * dpr);
    bg.height = Math.round(h * dpr);
  }
  const ctx = bg.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawStatic(ctx);
}

function paint() {
  const c = cv.value;
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (w === 0 || h === 0) return;
  if (c.width !== Math.round(w * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  k = Math.min((w - PAD * 2) / props.fieldW, (h - PAD * 2) / props.fieldH);
  ox = w / 2;
  oy = h / 2;

  const key = currentKey(w, h);
  if (!sameKey(bgKeyObj, key) || !bg) {
    bgKeyObj = key;
    paintBackground(w, h, dpr);
  }
  if (bg) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bg, 0, 0);
    ctx.restore();
  }
  drawLive(ctx, h);
}

/**
 * Everything that only changes when the plan or the geometry does.
 *
 * It works entirely in the view transform set up by `paint`, so it never needs the
 * pixel size of the surface it is drawing on.
 */
function drawStatic(ctx: CanvasRenderingContext2D) {

  /* The axis lattice. Drawn by walking whole axis values and mapping them back to
   * millimetres, so the spacing on screen is the machine's real resolution at that
   * spot. It is not a uniform grid, and that is the point: a uniform grid would be
   * a lie about a non-linear map. */
  if (props.showLattice && props.profile) {
    const p = props.profile;
    const c0 = p.quantise(p.inverse({ x: -props.fieldW / 2, y: -props.fieldH / 2 }));
    const c1 = p.quantise(p.inverse({ x: props.fieldW / 2, y: props.fieldH / 2 }));
    const aLo = Math.min(c0.a, c1.a);
    const aHi = Math.max(c0.a, c1.a);
    const bLo = Math.min(c0.b, c1.b);
    const bHi = Math.max(c0.b, c1.b);
    const stride = Math.max(1, Math.round(Math.max(aHi - aLo, bHi - bLo) / 40));

    /* Only when it would be legible. A lattice denser than a few pixels is noise. */
    const probe = p.forward({ a: aLo, b: bLo });
    const probe2 = p.forward({ a: aLo + stride, b: bLo });
    if (Math.abs(probe2.x - probe.x) * k > 4) {
      ctx.strokeStyle = "rgba(254,3,134,.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let a = Math.ceil(aLo / stride) * stride; a <= aHi; a += stride) {
        let started = false;
        for (let b = bLo; b <= bHi; b += Math.max(1, (bHi - bLo) / 30)) {
          const q = p.forward({ a, b });
          const [X, Y] = toPx(q);
          if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
        }
      }
      for (let b = Math.ceil(bLo / stride) * stride; b <= bHi; b += stride) {
        let started = false;
        for (let a = aLo; a <= aHi; a += Math.max(1, (aHi - aLo) / 30)) {
          const q = p.forward({ a, b });
          const [X, Y] = toPx(q);
          if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
        }
      }
      ctx.stroke();
    }
  }

  /* Field boundary and centre cross. */
  const tl = toPx({ x: -props.fieldW / 2, y: props.fieldH / 2 });
  ctx.strokeStyle = props.clipped ? "#ff5b3a" : "rgba(245,240,230,.45)";
  ctx.lineWidth = 2;
  ctx.strokeRect(tl[0], tl[1], props.fieldW * k, props.fieldH * k);

  ctx.strokeStyle = "rgba(245,240,230,.14)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(...toPx({ x: -props.fieldW / 2, y: 0 }));
  ctx.lineTo(...toPx({ x: props.fieldW / 2, y: 0 }));
  ctx.moveTo(...toPx({ x: 0, y: -props.fieldH / 2 }));
  ctx.lineTo(...toPx({ x: 0, y: props.fieldH / 2 }));
  ctx.stroke();

  /* The ideal path, as a ghost. What you asked for. */
  if (props.showIdeal) {
    ctx.strokeStyle = "rgba(245,240,230,.30)";
    ctx.setLineDash([1, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const s of props.strokes) {
      s.forEach((pt, i) => {
        const [X, Y] = toPx(pt);
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      });
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /* What the machine will really do. Solid, because this is the one that matters.
   * Travel moves are dashed and dim: they are motion, not drawing. */
  const sim = props.simulated;
  if (sim.length > 1) {
    /* Decimate long paths so a raster with tens of thousands of points still paints
     * inside a frame. */
    const stride = Math.max(1, Math.floor(sim.length / 6000));

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#FE0386";
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < sim.length; i += stride) {
      const pt = sim[i]!;
      const [X, Y] = toPx(pt);
      if (pt.on && pen) ctx.lineTo(X, Y);
      else ctx.moveTo(X, Y);
      pen = pt.on;
    }
    ctx.stroke();

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(245,240,230,.13)";
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    pen = true;
    for (let i = 0; i < sim.length; i += stride) {
      const pt = sim[i]!;
      const [X, Y] = toPx(pt);
      if (!pt.on && !pen) ctx.lineTo(X, Y);
      else ctx.moveTo(X, Y);
      pen = pt.on;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** The cheap half: where the beam is, and the captured corners. */
function drawLive(ctx: CanvasRenderingContext2D, h: number) {
  /* Captured corners. Green is the one green in the system and it means exactly
   * this: a corner is captured. */
  if (props.profile) {
    props.corners.forEach((c, i) => {
      if (!c) return;
      const at = props.profile!.forward({ a: c[0], b: c[1] });
      const [X, Y] = toPx(at);
      ctx.strokeStyle = "#37ff8b";
      ctx.lineWidth = 2;
      ctx.strokeRect(X - 5, Y - 5, 10, 10);
      ctx.fillStyle = "#37ff8b";
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(["TL", "TR", "BR", "BL"][i]!, X + 8, Y - 6);
    });
  }

  /* The beam. An armed beam gets the one piece of solid colour, and nothing else is
   * allowed to compete with it. */
  if (props.live) {
    const [X, Y] = toPx(props.live);
    if (props.beamOn) {
      ctx.fillStyle = "rgba(254,3,134,.35)";
      ctx.beginPath(); ctx.arc(X, Y, 11, 0, 7); ctx.fill();
      ctx.fillStyle = "#FE0386";
      ctx.beginPath(); ctx.arc(X, Y, 5, 0, 7); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(X, Y, 2, 0, 7); ctx.fill();
    } else {
      ctx.fillStyle = "#5e574f";
      ctx.beginPath(); ctx.arc(X, Y, 3, 0, 7); ctx.fill();
    }
  }

  if (cursor.value) {
    ctx.fillStyle = "rgba(245,240,230,.5)";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(`${cursor.value.x.toFixed(1)}, ${cursor.value.y.toFixed(1)} mm`, 8, h - 8);
  }
}

function onDown(e: PointerEvent) {
  if (e.button !== 0) return;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  dragging = true;
  emit("aim", toMm(e.clientX, e.clientY));
}
function onMove(e: PointerEvent) {
  cursor.value = toMm(e.clientX, e.clientY);
  if (dragging) emit("draw", cursor.value);
  paint();
}
function onUp() {
  if (dragging) emit("draw-end");
  dragging = false;
}

onMounted(() => {
  ro = new ResizeObserver(paint);
  if (wrap.value) ro.observe(wrap.value);
  paint();
});
onBeforeUnmount(() => ro?.disconnect());

/*
 * Repaint on identity, never deeply.
 *
 * A deep watch here looks harmless and is not: `simulated` holds one object per
 * emitted point, so a plot of a few hundred points made every single position
 * update walk the whole array before it could draw. The animation crawled to about
 * three points a second and looked like a hang.
 *
 * The arrays are replaced wholesale when the plan changes rather than mutated, so
 * comparing references is both correct and free.
 */
watch(
  () => [
    props.profile, props.fieldW, props.fieldH,
    props.strokes, props.simulated, props.corners,
    props.live, props.beamOn,
    props.showLattice, props.showIdeal, props.clipped,
  ],
  paint,
);
</script>

<template>
  <div ref="wrap" class="wrap">
    <canvas
      ref="cv"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointerleave="cursor = null"
    ></canvas>
    <div class="vlabel">target plane</div>
    <div v-if="clipped" class="clip">clipping at limits</div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative; width: 100%; height: 100%; min-height: 0;
  background: var(--hb-ink); border: 2px solid var(--hb-ink);
  /* The one place the accent is spent on something structural. */
  box-shadow: var(--hb-shadow-view);
}
canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: crosshair; }
.vlabel {
  position: absolute; top: 0; left: 0; z-index: 3; pointer-events: none;
  font-family: var(--hb-mono); font-weight: 700; font-size: 9px; letter-spacing: .2em;
  color: var(--hb-ink); background: var(--hb-pink); padding: 3px 9px;
}
.clip {
  position: absolute; top: 8px; right: 10px; z-index: 5;
  background: var(--hb-danger); color: var(--hb-paper);
  font: 700 10px var(--hb-mono); letter-spacing: .15em; padding: 4px 9px;
}
</style>
