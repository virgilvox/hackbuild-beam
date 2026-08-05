<script setup lang="ts">
import { ref, watch } from "vue";
import { useProject } from "../stores/project";
import { useMachine } from "../stores/machine";
import { useLog } from "../stores/log";
import { useJob } from "../stores/job";
import { useAnimate } from "../stores/animate";

/**
 * The job column: what to draw and how to lay it out.
 *
 * Nothing here is machine specific. Content is content, and a stroke font does not
 * care whether the axis counts microseconds or half steps. That is the point of
 * keeping the sources unit blind, and it is why this column looks the same on both
 * rigs while the machine column does not.
 */
defineProps<{ focus: string | null }>();

const p = useProject();

/*
 * The source tabs.
 *
 * `pattern` collects everything generated from a formula, because those share one
 * panel and differ only by which formula. The rest are distinct enough to deserve
 * their own tab: they take different inputs and answer different questions.
 *
 * `direct` is here because from where you sit it is a way of drawing, even though
 * nothing downstream treats it as a source.
 */
const SOURCE_TABS = [
  { id: "text", label: "text", pick: "text" },
  { id: "sketch", label: "draw", pick: "sketch" },
  { id: "direct", label: "direct", pick: "direct" },
  { id: "pattern", label: "patterns", pick: "cube" },
  { id: "svg", label: "svg", pick: "svg" },
  { id: "image", label: "image", pick: "image" },
] as const;

const PATTERNS = [
  "cube", "tesseract", "ico", "knot", "sphere", "lissajous",
  "circle", "star", "spiral", "grid", "lash", "ruler", "square", "ramp",
];

/** Which tab a source belongs to. */
function tabOf(src: string): string {
  if (PATTERNS.includes(src)) return "pattern";
  if (src === "sketch") return "sketch";
  return src;
}

/*
 * Selecting a tab remembers nothing on purpose. Coming back to patterns lands on
 * the cube rather than on whichever calibration target was last used, because the
 * calibration ones fire a live beam at a wall and are not a thing to arrive at by
 * pressing back.
 */
function pickTab(t: { pick: string }) {
  if (tabOf(p.source) === tabOf(t.pick)) return;
  p.source = t.pick as typeof p.source;
}
const machine = useMachine();
const log = useLog();
const job = useJob();
const anim = useAnimate();

/* The loop driver lives in the session facade with everything else that reaches a
 * machine, and it is imported the same lazy way the run dock imports the run. */
async function loop() {
  const s = await import("../session");
  await s.loopFrames();
}

/* Replanning a raster touches tens of thousands of points, so coalesce. */
let timer = 0;
function replan() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => p.rebuild(), 60);
}

watch(
  () => [
    p.source, p.text, p.capMm, p.face, p.tracking, p.scalePct, p.toleranceMm,
    p.rotateDeg, p.offX, p.offY, p.mirrorX, p.mirrorY,
    p.reorder, p.unidirectional, p.yaw, p.pitch, p.detail,
    p.imgThreshold, p.imgPitchSteps, p.imgInvert,
    machine.fieldW, machine.fieldH, machine.throwMm, machine.sepMm, machine.calibrationOn,
    /*
     * The profile itself, by identity. It is rebuilt whenever anything it is made
     * from changes, so watching it covers the servo, dither, the inversions and the
     * limits in one entry rather than as a list that has to be remembered. The
     * geometry fields above stay listed because they also move the placement, which
     * is upstream of the profile.
     */
    machine.profile,
    machine.dither,
    /* The feed is a planner input rather than a profile input, so rebuilding the
     * profile does not cover it and it needs its own entry here. Without one the
     * box accepted a number and changed nothing, which is the same shape of bug as
     * the dither checkbox that only moved the estimate. */
    machine.feedMmS,
    machine.backlashComp,
  ],
  replan,
  { immediate: true },
);

async function loadSvg(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  p.svgText = await f.text();
  p.source = "svg";
  log.sys(`svg loaded, ${f.name}`);
  replan();
}

async function loadImage(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const bmp = await createImageBitmap(f);
  /* The canvas sampling happens here, in the app. The source package takes a plain
   * grayscale buffer so it stays testable without a browser. */
  const cap = 420;
  const k = Math.min(1, cap / Math.max(bmp.width, bmp.height));
  const w = Math.max(2, Math.round(bmp.width * k));
  const h = Math.max(2, Math.round(bmp.height * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  /* White first, so a transparent PNG reads as white rather than black. */
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const src = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0, o = 0; i < data.length; i++, o += 4) {
    data[i] = (src[o]! * 3 + src[o + 1]! * 6 + src[o + 2]!) / 10;
  }
  p.image = { width: w, height: h, data };
  p.source = "image";
  log.sys(`image loaded, ${w} by ${h}`);
  replan();
}

/* The +/- on every heading promised collapsing and did nothing. Groups you have
   finished with should get out of the way, which is the whole reason the shipped
   tools made them collapsible. */
const collapsed = ref<Record<string, boolean>>({});
function toggleGrp(id: string) {
  collapsed.value = { ...collapsed.value, [id]: !collapsed.value[id] };
}
</script>

<template>
  <div>
    <section id="panel-content" class="hb-grp" :class="{ focus: focus === 'content' , collapsed: collapsed['content'] }">
      <h3 @click="toggleGrp('content')">content</h3>
      <div class="hb-body">
        <!-- Tabs rather than a dropdown. The source is the first decision and the
             one you change most, and a select hides every option but the one already
             chosen, which is the wrong way round for a control whose whole job is to
             show you what this machine can be pointed at. -->
        <div class="tabs" role="tablist">
          <button
            v-for="t in SOURCE_TABS"
            :key="t.id"
            type="button"
            role="tab"
            :aria-selected="tabOf(p.source) === t.id"
            :class="{ act: tabOf(p.source) === t.id }"
            @click="pickTab(t)"
          >
{{ t.label }}
</button>
        </div>

        <!-- Only the groups with more than one member need a second choice. -->
        <label v-if="tabOf(p.source) === 'pattern'" class="hb-row">
          pattern
          <select v-model="p.source">
            <optgroup label="wireframe">
              <option value="cube">cube</option>
              <option value="tesseract">tesseract</option>
              <option value="ico">icosahedron</option>
              <option value="knot">torus knot</option>
              <option value="sphere">sphere</option>
              <option value="lissajous">lissajous</option>
            </optgroup>
            <optgroup label="shapes">
              <option value="circle">circle</option>
              <option value="star">star</option>
              <option value="spiral">spiral</option>
              <option value="grid">grid</option>
            </optgroup>
            <optgroup label="calibration">
              <option value="lash">lash gauge</option>
              <option value="ruler">ruler</option>
              <option value="square">square</option>
              <option value="ramp">speed ramp</option>
            </optgroup>
          </select>
        </label>

        <p v-if="p.source === 'direct'" class="hb-note">
          Drag on the target and the beam goes where you point, with no planner in the
          way. Nothing is recorded and nothing is plotted: this is you driving. On a rig
          that misses by a fixed fraction of a millimetre it is often the most accurate
          way to draw, because your eye closes the loop the machine cannot close for
          itself and you correct as you go instead of committing a plan and watching it
          miss. Use <b>sketch</b> instead if you want to keep what you drew and replot it.
        </p>

        <template v-if="p.source === 'text'">
          <textarea v-model="p.text" rows="2"></textarea>
          <label class="hb-row">cap height<input v-model.number="p.capMm" type="number" step="1" /><span class="unit">mm</span></label>
          <!-- The slider drives the cap height itself rather than a second scale
               factor, so there is still only one number that decides the size and it
               is the one on screen in millimetres. The top of its travel is the
               largest cap that fits, which makes dragging it to the end mean "fill
               the field" without needing a separate control that says so. -->
          <label class="hb-row">
            size
            <input
              v-model.number="p.capMm"
              type="range"
              min="4"
              :max="Math.max(8, p.capToFitMm)"
              step="1"
            />
            <button class="mini" type="button" @click="p.fitTextToField()">fit</button>
          </label>
          <label class="hb-row">
            face
            <select v-model="p.face">
              <option value="servo">condensed</option>
              <option value="default">regular</option>
            </select>
          </label>
          <p class="hb-note">
            Cap height is millimetres on the target, so the text comes out exactly as big as you
            ask. The slider is the same number: its top is the largest cap that still fits, which
            here is {{ p.capToFitMm }} mm. The condensed face is narrower, and narrower is what
            lets a line fit at a bigger cap height: on a machine that misses by a fixed number of
            millimetres, bigger letters are the only thing that makes the miss matter less.
          </p>
          <label class="hb-row">tracking<input v-model.number="p.tracking" type="number" step="0.05" /></label>
        </template>

        <template v-if="p.source === 'svg'">
          <input type="file" accept=".svg,image/svg+xml" @change="loadSvg" />
        </template>

        <template v-if="p.source === 'image'">
          <input type="file" accept="image/*" @change="loadImage" />
          <label class="hb-row">threshold<input v-model.number="p.imgThreshold" type="range" min="10" max="245" /><b>{{ p.imgThreshold }}</b></label>
          <label class="hb-row">row pitch<input v-model.number="p.imgPitchSteps" type="number" min="1" max="8" /><span class="unit">steps</span></label>
          <label class="chk"><input v-model="p.imgInvert" type="checkbox" /> invert</label>
          <p class="hb-note">Dark pixels become dashes on serpentine rows. Reordering is off for raster so the rows stay serpentine.</p>
        </template>

        <template v-if="p.source === 'sketch'">
          <p class="hb-note">Drag on the target to draw. A point is kept only when it has moved more than about a millimetre.</p>
          <button @click="p.clearSketch()">clear sketch</button>
        </template>

        <template v-if="p.is3d">
          <label class="hb-row">yaw<input v-model.number="p.yaw" type="range" min="0" max="360" /><b>{{ p.yaw }}</b></label>
          <label class="hb-row">pitch<input v-model.number="p.pitch" type="range" min="0" max="360" /><b>{{ p.pitch }}</b></label>
          <label class="hb-row">detail<input v-model.number="p.detail" type="range" min="1" max="5" /><b>{{ p.detail }}</b></label>
          <div class="hb-btnrow">
            <button :class="{ 'hb-act': anim.animOn }" @click="anim.toggle()">
              {{ anim.animOn ? "animating" : "animate" }}
            </button>
            <button
              :class="{ 'hb-act': anim.looping }"
              :disabled="!p.planned || (job.running && !anim.looping)"
              @click="loop"
            >
              {{ anim.looping ? "stop loop" : "loop" }}
            </button>
          </div>
          <p class="hb-note">
            Frames plot one at a time. A cube frame is a few seconds of motion, so LOOP is a slow
            flipbook, not animation.
          </p>
        </template>

        <!-- Not shown for text: text has a real size and cap height is it. Leaving a
             second size control on screen is how the two ended up fighting, with the
             percentage silently winning and the millimetre field doing nothing. -->
        <!-- Text has its own size control above, in millimetres. A percentage of the
             field on top of it would be a second number deciding one thing, which is
             how the cap height came to be silently ignored in the first place. -->
        <label v-if="!p.isPatternSource && p.source !== 'text'" class="hb-row">
          size<input v-model.number="p.scalePct" type="range" min="10" max="100" /><b>{{ p.scalePct }}%</b>
        </label>
        <label class="hb-row">
          tolerance<input v-model.number="p.toleranceMm" type="range" min="0.02" max="1" step="0.02" /><b>{{ p.toleranceMm.toFixed(2) }}</b>
        </label>
        <p class="hb-note">
          Tolerance is in target millimetres, so a letter at 10 mm and at 200 mm is flattened to the
          same accuracy on the wall rather than to the same number of points.
        </p>
      </div>
    </section>

    <section v-if="!p.isPatternSource" class="hb-grp" :class="{ collapsed: collapsed['place'] }">
      <h3 @click="toggleGrp('place')">place</h3>
      <div class="hb-body">
        <div class="grid2">
          <label class="hb-row">x<input v-model.number="p.offX" type="number" step="1" /></label>
          <label class="hb-row">y<input v-model.number="p.offY" type="number" step="1" /></label>
        </div>
        <label class="hb-row">rotate<input v-model.number="p.rotateDeg" type="range" min="-180" max="180" /><b>{{ p.rotateDeg }}</b></label>
        <div class="hb-btnrow">
          <label class="chk"><input v-model="p.mirrorX" type="checkbox" /> mirror x</label>
          <label class="chk"><input v-model="p.mirrorY" type="checkbox" /> mirror y</label>
        </div>
        <p class="hb-note">
          Mirror when the rig fires at the back of something you read from the front, or a fold down
          mirror turns the beam. Without it the writing comes out reversed and you find out with a laser.
        </p>
      </div>
    </section>

    <section id="panel-path" class="hb-grp" :class="{ focus: focus === 'path' , collapsed: collapsed['path'] }">
      <h3 @click="toggleGrp('path')">path</h3>
      <div class="hb-body">
        <div class="hb-btnrow">
          <label class="chk"><input v-model="p.reorder" type="checkbox" :disabled="p.isPatternSource" /> reorder travel</label>
          <label class="chk"><input v-model="p.unidirectional" type="checkbox" /> one direction</label>
        </div>
        <div class="hb-btnrow">
          <label class="chk"><input v-model="p.showIdeal" type="checkbox" /> show intent</label>
          <label class="chk"><input v-model="p.showLattice" type="checkbox" /> show step grid</label>
        </div>
        <p class="hb-note" v-if="p.unidirectional">
          Always approaching a stroke from the same side trades speed for repeatability, because it
          never asks the gear train to reverse mid drawing.
        </p>
        <div class="hb-kv"><span>strokes</span><b>{{ p.strokes.length }}</b></div>
        <div class="hb-kv"><span>points</span><b>{{ p.commandCount }}</b></div>
        <div class="hb-kv"><span>estimate</span><b>{{ p.estimate }}</b></div>
        <div class="hb-kv"><span>one step</span><b>{{ p.stepMm().toFixed(3) }} mm</b></div>
        <div class="hb-kv"><span>one step here</span><b>{{ p.resolutionMm.toFixed(2) }} mm</b></div>
        <div class="hb-kv"><span>steps across field</span><b>{{ p.stepsAcross.toFixed(0) }}</b></div>
        <div v-if="p.detailWarning" class="hb-note warn">{{ p.detailWarning }}</div>
        <div v-if="p.clipped" class="hb-note warn">
          Content is hitting the limits and being clipped. Make it smaller, move it, or widen the limits.
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* One row, wrapping. Six tabs do not fit a narrow column on one line and a
 * horizontal scroller would hide the one you want. */
.tabs { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 8px; }
.tabs button {
  flex: 1 0 auto;
  font-family: var(--hb-mono);
  font-size: 10px;
  letter-spacing: .08em;
  text-transform: uppercase;
  padding: 4px 8px;
  border: 1px solid var(--hb-rule);
  background: transparent;
  color: var(--hb-fg-muted);
  cursor: pointer;
}
.tabs button:hover { color: var(--hb-fg); }
.tabs button.act {
  background: var(--hb-pink);
  border-color: var(--hb-pink);
  color: var(--hb-on-pink, #fff);
}

/* A one word action that belongs on the same line as the control it acts on, so it
 * reads as part of the slider rather than as a separate command. */
.mini {
  font-family: var(--hb-mono);
  font-size: 10px;
  letter-spacing: .1em;
  text-transform: uppercase;
  padding: 2px 7px;
  border: 1px solid var(--hb-rule);
  background: transparent;
  color: var(--hb-fg-muted);
  cursor: pointer;
}
.mini:hover { color: var(--hb-fg); border-color: var(--hb-fg-muted); }

.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.hb-grp.focus { box-shadow: inset 0 0 0 2px var(--hb-pink); }
.hb-row input[type=range] { flex: 1; min-width: 0; }
.hb-row b {
  font-family: var(--hb-term); font-size: 17px; font-weight: 400; color: var(--hb-fg);
  min-width: 40px; text-align: right;
}
.chk {
  display: inline-flex; align-items: center; gap: 6px; font-family: var(--hb-mono);
  font-size: 10px; color: var(--hb-fg-muted); letter-spacing: .02em;
}
.unit { font-family: var(--hb-mono); font-size: 9px; color: var(--hb-fg-faint); letter-spacing: .1em; }
.warn { border-left-color: var(--hb-danger); color: var(--hb-danger); }
</style>
