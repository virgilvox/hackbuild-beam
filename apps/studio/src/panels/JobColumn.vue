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
    /* Dither changes what the machine can resolve, so it changes the legibility
     * budget and the warning that comes off it, not just what the board is told. */
    machine.dither,
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
        <label class="hb-row">
          source
          <select v-model="p.source">
            <optgroup label="draw">
              <option value="text">text</option>
              <option value="sketch">sketch on the target</option>
              <option value="svg">svg file</option>
              <option value="image">image</option>
            </optgroup>
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
              <option value="ramp">rate ramp</option>
            </optgroup>
          </select>
        </label>

        <template v-if="p.source === 'text'">
          <textarea v-model="p.text" rows="2"></textarea>
          <label class="hb-row">cap height<input v-model.number="p.capMm" type="number" step="1" /><span class="unit">mm</span></label>
          <label class="hb-row">
            face
            <select v-model="p.face">
              <option value="servo">condensed</option>
              <option value="default">regular</option>
            </select>
          </label>
          <p class="hb-note">
            Cap height is millimetres on the target, so the text is as big as you ask and the size
            slider below does not apply to it. The condensed face is narrower, which is what lets a
            line fit at a bigger cap height: on a machine that misses by a fixed number of
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
