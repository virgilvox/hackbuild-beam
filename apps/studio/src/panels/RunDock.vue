<script setup lang="ts">
import { computed } from "vue";
import { useJob } from "../stores/job";
import { useProject } from "../stores/project";
import { useMachine } from "../stores/machine";

/**
 * The pinned run strip.
 *
 * It never scrolls and it never hides behind a tab, because these are the controls
 * you reach for while a beam is live. The speed slider lives here rather than in
 * the tuning fold for the same reason: it is the one knob you touch mid plot.
 */
const job = useJob();
const project = useProject();
const machine = useMachine();

const canRun = computed(() => project.planned && project.commandCount > 0);

async function run() {
  const s = await import("../session");
  await s.runJob();
}
async function frame() {
  const s = await import("../session");
  await s.frameJob();
}
async function pause() {
  const s = await import("../session");
  await s.pauseJob();
}
async function stop() {
  const s = await import("../session");
  await s.stopJob();
}
</script>

<template>
  <div class="dock" :class="{ running: job.running }">
    <div class="row">
      <button class="hb-pri" :disabled="!canRun || job.running" @click="run">
        {{ job.dryRun ? "dry run" : "plot" }}
      </button>
      <button :disabled="!canRun || job.running" @click="frame">frame it</button>
      <button :disabled="!job.running" @click="pause">
        {{ job.state === "paused" ? "resume" : "pause" }}
      </button>
      <button :disabled="!job.running" @click="stop">stop</button>
      <label class="chk"><input v-model="job.dryRun" type="checkbox" /> dry run</label>
    </div>

    <div class="row">
      <label class="speed">
        speed
        <input v-model.number="job.speed" type="range" min="0.1" max="2" step="0.05" />
        <b>{{ job.speed.toFixed(2) }}x</b>
      </label>
    </div>

    <div class="bar"><i :style="{ width: (job.progress * 100).toFixed(1) + '%' }"></i></div>

    <div class="meta">
      <span>{{ job.sent }} / {{ job.total }}</span>
      <span>{{ project.estimate }}</span>
      <span v-if="machine.queueFree >= 0">board queue {{ machine.queueFree }}</span>
    </div>
  </div>
</template>

<style scoped>
/* The run dock is an instrument surface: it inverts, so the controls you reach for
   with a live beam are visually part of the machine rather than the paperwork. */
.dock {
  background: var(--hb-ink); border: 2px solid var(--hb-ink); box-shadow: var(--hb-shadow-sm);
  padding: 9px 11px; display: grid; gap: 8px; flex: none;
}
.dock.running { background: #2a0d16; border-color: var(--hb-pink); box-shadow: 3px 3px 0 0 var(--hb-pink); }
.row { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; }
.dock button {
  background: var(--hb-ink-2); border: 2px solid #3a3733; color: var(--hb-paper); box-shadow: none;
}
.dock button:hover:not(:disabled) { background: var(--hb-pink); border-color: var(--hb-pink); }
.dock .hb-pri { background: var(--hb-pink); border-color: var(--hb-pink); color: var(--hb-paper); }
.dock .hb-pri:hover:not(:disabled) { background: var(--hb-paper); color: var(--hb-ink); }
.chk {
  display: inline-flex; gap: 6px; align-items: center; font-family: var(--hb-mono);
  font-size: 9px; font-weight: 700; letter-spacing: .11em; color: var(--hb-dim); text-transform: uppercase;
}
.speed {
  display: flex; gap: 9px; align-items: center; flex: 1;
  font-family: var(--hb-mono); font-size: 9px; font-weight: 700; letter-spacing: .11em;
  color: var(--hb-dim); text-transform: uppercase;
}
.speed input { flex: 1; }
.speed b { font-family: var(--hb-term); font-size: 17px; color: var(--hb-paper); font-weight: 400; letter-spacing: 0; }
.bar { height: 7px; background: var(--hb-ink-2); border: 1px solid #3a3733; }
.bar i { display: block; height: 100%; background: var(--hb-pink); transition: width .15s linear; }
.meta {
  display: flex; gap: 18px; font-family: var(--hb-term); font-size: 15px; color: var(--hb-dim);
}
</style>
