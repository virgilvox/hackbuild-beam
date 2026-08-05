<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import type { Point } from "@virgilvox/beam-core";

/**
 * The phosphor wall: what the beam looks like on glow paint.
 *
 * Ported from laser-rig.html. The target plane view is a plot, and a plot cannot
 * tell you the one thing that decides whether a piece comes out: how long the beam
 * dwelt on each part of it. This view can, because it does what the paint does. It
 * deposits light additively and fades toward black, so a slow pass is bright and a
 * fast pass is a thin scratch, and the difference is visible without reading a
 * single number.
 *
 * It is not the same picture as TargetCanvas and it is not meant to be. That one is
 * geometry, this one is exposure.
 */
const props = defineProps<{
  /** What the machine will really do, after quantisation and the error model. */
  simulated: { x: number; y: number; on: boolean }[];
  /** Where the beam is now, in mm. */
  live: Point | null;
  beamOn: boolean;
  fieldW: number;
  fieldH: number;
  /** True while a job is streaming. Drives the frame loop. */
  running: boolean;
}>();

const cv = ref<HTMLCanvasElement | null>(null);
const wrap = ref<HTMLDivElement | null>(null);
let ro: ResizeObserver | null = null;
let raf = 0;
let lastT = 0;

/*
 * 405 nm violet, and a constant rather than a setting.
 *
 * There is one diode on this rig. The accent pink belongs to the interface and
 * using it here would say the beam colour is a design choice, which it is not: it
 * is the wavelength, and it is also the reason the phosphor charges at all. Violet
 * charges strontium aluminate fully, green weakly, red barely.
 */
const BEAM_R = 157;
const BEAM_G = 92;
const BEAM_B = 255;

/*
 * The deposit and the decay, both carried over unchanged from the rig tool.
 *
 * The fade is a lerp toward black of clamp(dt * 0.55, 0, 0.06) per frame, which at
 * 60 Hz takes a single unrepeated visit down to noise in about a second. The cap at
 * 0.06 is what makes a dropped frame or a backgrounded tab fade by one frame's worth
 * instead of wiping the wall.
 *
 * The deposit alpha is high on purpose. A dwelling beam saturates to white within a
 * few frames, which is exactly what a real one does to the paint, and it is the
 * contrast against a fast pass that carries the information.
 */
const FADE_RATE = 0.55;
const FADE_MAX = 0.06;
const DEPOSIT_ALPHA = 0.96;
const LINE_W = 4;
const GLOW_BLUR = 10;

/*
 * The idle composite deposits far weaker than the live run.
 *
 * With no fade running, every segment of the plan lands on the wall at once, so the
 * live alpha would paint the whole path solid white and destroy the very ranking the
 * view exists to show. At this alpha a single pass reads at about a fifth of full and
 * repeated coverage still saturates, which preserves the rank ordering the live decay
 * produces.
 */
const COMPOSITE_ALPHA = 0.18;

/*
 * Fixed buffer resolution, sized off the field aspect rather than the element.
 *
 * The buffer holds accumulated history, so reallocating it erases the trail. Tying
 * it to the element size would mean any layout change, a panel opening, a window
 * drag, wiped the wall mid-run. A fixed buffer scaled on blit survives all of that,
 * and it is also what the rig tool did with its 1024 x 640 wall texture.
 */
const BUF_LONG = 1024;

let buf: HTMLCanvasElement | null = null;
let bctx: CanvasRenderingContext2D | null = null;
let bw = 0;
let bh = 0;

/* The previous deposit point in buffer pixels, or null when the beam is off. */
let prevPx: [number, number] | null = null;

const PAD = 26;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Field millimetres, y up, to buffer pixels, y down. */
function toBuf(p: { x: number; y: number }): [number, number] {
  return [bw / 2 + (p.x * bw) / props.fieldW, bh / 2 - (p.y * bh) / props.fieldH];
}

function ensureBuffer() {
  const aspect = props.fieldH / props.fieldW;
  const w = aspect > 1 ? Math.max(64, Math.round(BUF_LONG / aspect)) : BUF_LONG;
  const h = aspect > 1 ? BUF_LONG : Math.max(64, Math.round(BUF_LONG * aspect));
  /* Only reallocate when the field aspect actually moved. Reallocating clears the
   * wall, so doing it on anything else throws away history for nothing. */
  if (buf && bw === w && bh === h) return;
  if (!buf) buf = document.createElement("canvas");
  buf.width = w;
  buf.height = h;
  bw = w;
  bh = h;
  bctx = buf.getContext("2d");
  clearWall();
}

/** Back to an uncharged wall. */
function clearWall() {
  if (!bctx) return;
  bctx.globalCompositeOperation = "source-over";
  bctx.fillStyle = "#000";
  bctx.fillRect(0, 0, bw, bh);
  prevPx = null;
}

function fade(dt: number) {
  if (!bctx) return;
  bctx.globalCompositeOperation = "source-over";
  const a = clamp(dt * FADE_RATE, 0, FADE_MAX);
  bctx.fillStyle = `rgba(0,0,0,${a.toFixed(4)})`;
  bctx.fillRect(0, 0, bw, bh);
}

/**
 * One additive deposit, from the last point to this one.
 *
 * Additive is the whole model: two passes over the same spot are brighter than one,
 * and that is how dwell becomes visible. A zero length call still deposits, because
 * the caps are round, which is what makes a stationary beam burn in.
 */
function deposit(px: [number, number], alpha: number) {
  if (!bctx) return;
  bctx.globalCompositeOperation = "lighter";
  bctx.strokeStyle = `rgba(${BEAM_R},${BEAM_G},${BEAM_B},${alpha.toFixed(3)})`;
  bctx.lineWidth = LINE_W;
  bctx.lineCap = "round";
  bctx.lineJoin = "round";
  bctx.shadowColor = `rgba(${BEAM_R},${BEAM_G},${BEAM_B},0.9)`;
  bctx.shadowBlur = GLOW_BLUR;
  bctx.beginPath();
  const from = prevPx ?? px;
  bctx.moveTo(from[0], from[1]);
  bctx.lineTo(px[0], px[1]);
  bctx.stroke();
  bctx.shadowBlur = 0;
  prevPx = px;
}

/*
 * Break the trail at every gate change.
 *
 * Without this the next deposit runs a line from wherever the beam was when it went
 * dark to wherever it came back on, so every reposition between letters paints a
 * bright bar straight across the work. Nulling the previous point is the entire fix
 * and it has to happen on the off edge, not on the on edge.
 */
function depositLive() {
  if (!props.live || !props.beamOn) {
    prevPx = null;
    return;
  }
  deposit(toBuf(props.live), DEPOSIT_ALPHA);
}

/**
 * The held picture: the whole plan deposited at once, no decay.
 *
 * This is what the wall would look like after the job, and it is what stands in for
 * the run while nothing is streaming.
 */
function composite() {
  if (!bctx) return;
  clearWall();
  const sim = props.simulated;
  if (sim.length < 2) return;

  /*
   * Decimate to a segment budget. Every segment is its own stroke, because batching
   * them into one path would composite the whole path once and throw away exactly
   * the overlap accumulation this view is for. A raster can carry tens of thousands
   * of points and per segment strokes with a shadow blur are not free, so the budget
   * bounds the one pass that pays for it.
   */
  const stride = Math.max(1, Math.floor(sim.length / 6000));
  for (let i = 0; i < sim.length; i += stride) {
    const pt = sim[i]!;
    if (!pt.on) {
      prevPx = null;
      continue;
    }
    deposit(toBuf(pt), COMPOSITE_ALPHA);
  }
  prevPx = null;
}

/**
 * Blit the wall and draw the live beam over it.
 *
 * Same split as TargetCanvas: the expensive layer lives in an offscreen canvas and
 * is only ever copied here, and the cheap per frame drawing happens on top. There is
 * no second cached layer for the frame chrome because the chrome is two strokes.
 */
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

  const k = Math.min((w - PAD * 2) / props.fieldW, (h - PAD * 2) / props.fieldH);
  const rw = props.fieldW * k;
  const rh = props.fieldH * k;
  const rx = (w - rw) / 2;
  const ry = (h - rh) / 2;

  if (buf) ctx.drawImage(buf, rx, ry, rw, rh);

  ctx.strokeStyle = "rgba(245,240,230,.45)";
  ctx.lineWidth = 2;
  ctx.strokeRect(rx, ry, rw, rh);

  /* The live spot. The wall shows where the beam has been; this is where it is. */
  if (props.live) {
    const X = rx + rw / 2 + (props.live.x * rw) / props.fieldW;
    const Y = ry + rh / 2 - (props.live.y * rh) / props.fieldH;
    if (props.beamOn) {
      ctx.fillStyle = `rgba(${BEAM_R},${BEAM_G},${BEAM_B},.30)`;
      ctx.beginPath(); ctx.arc(X, Y, 10, 0, 7); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(X, Y, 2, 0, 7); ctx.fill();
    } else {
      ctx.strokeStyle = "rgba(245,240,230,.35)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(X, Y, 4, 0, 7); ctx.stroke();
    }
  }
}

/*
 * The frame loop runs only while a job does.
 *
 * Decay is the only thing that needs a clock, and there is nothing to decay when
 * nothing is emitting, so an idle view holds its composite at zero cost instead of
 * burning a frame budget fading a picture that is not changing.
 */
function frame(t: number) {
  const dt = lastT ? (t - lastT) / 1000 : 1 / 60;
  lastT = t;
  fade(dt);
  /* Deposit every frame, not only when a new point arrives. A beam that is holding
   * still emits nothing, and a wall that only charges on movement would show a dwell
   * as a dim spot, which is backwards. */
  depositLive();
  paint();
  raf = requestAnimationFrame(frame);
}

function start() {
  if (raf) return;
  /* Start from a dark wall. Leaving the idle composite underneath would bake the
   * finished picture in at full brightness and there would be no way to read the
   * trail against it. */
  clearWall();
  lastT = 0;
  raf = requestAnimationFrame(frame);
}

function stop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  /* Hold whatever the run left on the wall. Rebuilding the composite here would
   * throw away the one image the operator was watching for. */
  paint();
}

onMounted(() => {
  ensureBuffer();
  composite();
  ro = new ResizeObserver(paint);
  if (wrap.value) ro.observe(wrap.value);
  paint();
  if (props.running) start();
});

onBeforeUnmount(() => {
  ro?.disconnect();
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
});

watch(() => props.running, (on) => (on ? start() : stop()));

/*
 * Watch by identity, never deeply.
 *
 * `simulated` holds one object per emitted point. A deep watch here walks the whole
 * array before every repaint, which is what once made the target preview advance at
 * about three points a second and read as a hang. The arrays are replaced wholesale
 * on replan, so reference equality is both correct and free.
 */
watch(() => [props.fieldW, props.fieldH], () => {
  ensureBuffer();
  if (!props.running) composite();
  paint();
});

watch(() => props.simulated, () => {
  /* A replan mid run does not disturb the run: the wall is showing what is actually
   * happening, and the plan it is being compared against is the one that started. */
  if (props.running) return;
  composite();
  paint();
});

watch(() => [props.live, props.beamOn], () => {
  /*
   * Deposit on every live update as well as on every frame. Points can arrive faster
   * than frames do, and sampling only at frame rate would cut corners off the path by
   * running a chord between whichever two positions happened to land on frames.
   */
  depositLive();
  if (!props.running) paint();
});

/* The rig tool had a Clear button and it earns its place: the wall accumulates, so
 * there has to be a way to start looking again from nothing. */
defineExpose({ clear: () => { clearWall(); paint(); } });
</script>

<template>
  <div ref="wrap" class="hb-view wrap">
    <canvas ref="cv"></canvas>
    <div class="hb-vlabel">phosphor wall</div>
  </div>
</template>

<style scoped>
.wrap { width: 100%; height: 100%; min-height: 0; }
canvas { display: block; width: 100%; height: 100%; }
</style>
