<script setup lang="ts">
import { computed, ref } from "vue";
import { guideFor, nextStep, progress, type SetupState } from "../guidance";
import type { MachineProfile } from "@virgilvox/beam-core";

/**
 * What to do next with the machine you just connected.
 *
 * Both original tools knew this and neither surfaced it: one kept it behind a
 * manual modal, the other spread it through inline explainers. The order is load
 * bearing on the stepper rig (limits stay off until the corners exist, because
 * free jog is how you find the edges) and getting it wrong wastes a session.
 *
 * So it is a checklist that knows what you have already done, and it points at the
 * panel where the next thing happens.
 */
const props = defineProps<{ profile: MachineProfile | null; state: SetupState }>();
const emit = defineEmits<{ (e: "goto", panel: string): void }>();

const open = ref(true);
const showAll = ref(false);

const guide = computed(() => guideFor(props.profile));
const next = computed(() => nextStep(guide.value, props.state));
const prog = computed(() => progress(guide.value, props.state));
const complete = computed(() => prog.value.total > 0 && prog.value.done === prog.value.total);
</script>

<template>
  <section v-if="guide" class="guide">
    <header @click="open = !open">
      <span class="chev">{{ open ? "-" : "+" }}</span>
      <h3>{{ complete ? "Set up" : "Next" }}</h3>
      <span class="prog">{{ prog.done }} / {{ prog.total }}</span>
    </header>

    <div v-if="open" class="body">
      <p class="summary">{{ guide.summary }}</p>

      <div v-if="next" class="next">
        <div class="ntitle">{{ next.title }}</div>
        <p class="nbody">{{ next.body }}</p>
        <p v-if="next.why" class="nwhy"><span>Why now:</span> {{ next.why }}</p>
        <p v-if="next.caution" class="ncaution">{{ next.caution }}</p>
        <button class="jump" @click="emit('goto', next.panel)">take me there</button>
      </div>

      <p v-else class="done">
        Everything is set up. The machine is ready to plot.
      </p>

      <button class="toggle" @click="showAll = !showAll">
        {{ showAll ? "hide" : "show" }} the whole procedure
      </button>

      <ol v-if="showAll" class="steps">
        <li v-for="s in guide.steps" :key="s.id" :class="{ ok: s.done(state), now: s.id === next?.id }">
          <button class="steplink" @click="emit('goto', s.panel)">{{ s.title }}</button>
        </li>
      </ol>

      <details v-if="showAll" class="facts">
        <summary>What this machine is</summary>
        <p class="what">{{ guide.what }}</p>
        <div v-for="f in guide.facts" :key="f.title" class="fact">
          <div class="ft">{{ f.title }}</div>
          <p class="fb">{{ f.body }}</p>
        </div>
        <div v-for="c in guide.cautions" :key="c" class="caution">{{ c }}</div>
      </details>
    </div>
  </section>
</template>

<style scoped>
/* The guide is paperwork, not an instrument, so it stays on paper. It gets the
   pink rule and the display face because it is the first thing you should read. */
.guide { border-bottom: 2px solid var(--hb-rule); background: var(--hb-bg-raised); }
header {
  display: flex; align-items: center; gap: 9px; padding: 9px 12px 6px; cursor: pointer;
  background: var(--hb-pink); color: var(--hb-paper); user-select: none;
}
h3 { margin: 0; font-family: var(--hb-marker); font-size: 15px; font-weight: 400; flex: 1; letter-spacing: .02em; }
.chev { font-family: var(--hb-mono); font-weight: 700; }
.prog { font-family: var(--hb-term); font-size: 17px; }
.body { padding: 11px 12px 14px; display: flex; flex-direction: column; gap: 9px; }
.summary { font-family: var(--hb-type); font-size: 11px; line-height: 1.5; color: var(--hb-fg-faint); margin: 0; }
.next { border-left: 4px solid var(--hb-pink); padding-left: 9px; }
.ntitle { font-family: var(--hb-marker); font-size: 15px; margin-bottom: 4px; }
.nbody { font-family: var(--hb-type); font-size: 12px; line-height: 1.55; margin: 0 0 7px; }
.nwhy { font-family: var(--hb-type); font-size: 11px; color: var(--hb-fg-faint); line-height: 1.5; margin: 0 0 7px; }
.nwhy span { color: var(--hb-pink); }
.ncaution {
  font-family: var(--hb-mono); font-weight: 700; font-size: 9px; letter-spacing: .11em;
  text-transform: uppercase; color: var(--hb-paper); background: var(--hb-danger);
  padding: 5px 7px; margin: 0 0 7px;
}
.done { font-family: var(--hb-type); font-size: 12px; color: var(--hb-fg); margin: 0; }
.jump { align-self: flex-start; }
.toggle {
  align-self: flex-start; background: transparent; border: none; box-shadow: none;
  color: var(--hb-fg-faint); text-decoration: underline; padding: 0; font-size: 9px;
}
.toggle:hover { background: transparent; color: var(--hb-pink); }
.steps { margin: 0 0 0 20px; padding: 0; font-family: var(--hb-mono); font-size: 10px; }
.steps li { margin: 4px 0; color: var(--hb-fg-faint); }
.steps li.ok { color: #1f9c58; }
.steps li.now { color: var(--hb-pink); font-weight: 700; }
.steplink { border: none; padding: 0; color: inherit; text-align: left; background: none; box-shadow: none; font: inherit; text-transform: none; letter-spacing: 0; }
.steplink:hover { background: none; color: var(--hb-pink); }
.facts { font-family: var(--hb-type); font-size: 11px; }
summary { cursor: pointer; font-family: var(--hb-mono); font-size: 9px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: var(--hb-fg-muted); }
.what, .fb { font-size: 11px; line-height: 1.55; color: var(--hb-fg-faint); margin: 4px 0 0; }
.ft { margin-top: 9px; font-family: var(--hb-mono); font-size: 10px; font-weight: 700; letter-spacing: .06em; color: var(--hb-fg); }
.caution { border-left: 4px solid var(--hb-danger); color: var(--hb-danger); padding-left: 8px; margin-top: 8px; font-size: 11px; line-height: 1.5; }
</style>
