<script setup lang="ts">
import { computed, ref } from "vue";

/**
 * The first screen. It has one job: get you to a machine, or to an honest
 * simulation of one, without you having to know which app you would have opened
 * before.
 *
 * There is no machine dropdown for a real connection. You connect, the board says
 * what it is, and the app becomes the tool for that rig. The only place a human
 * picks is the simulator, where there is no board to ask.
 */
defineProps<{ busy: boolean; error: string | null }>();
const emit = defineEmits<{
  (e: "serial"): void;
  (e: "ble"): void;
  (e: "simulate", profileId: string): void;
}>();

const simProfile = ref("detent-28byj");

const hasSerial = computed(() => typeof navigator !== "undefined" && "serial" in navigator);
const hasBle = computed(() => typeof navigator !== "undefined" && "bluetooth" in navigator);
const why = "Needs Chrome or Edge, over https or from a local file.";
</script>

<template>
  <div class="screen">
    <div class="card">
      <div class="head">
        <span class="mark">BEAM</span>
        <span class="tag">laser scanner control</span>
      </div>

      <p class="lede">
        Connect a rig and this becomes the tool for that rig. The board is asked what it is,
        so there is nothing to choose and nothing to get wrong.
      </p>

      <div class="opts">
        <button class="opt" :disabled="busy || !hasSerial" @click="emit('serial')">
          <span class="ot">USB</span>
          <span class="od">A cable. The most reliable option, and the one to use while you are setting up.</span>
          <span v-if="!hasSerial" class="on">Web Serial unavailable. {{ why }}</span>
        </button>

        <button class="opt" :disabled="busy || !hasBle" @click="emit('ble')">
          <span class="ot">Bluetooth</span>
          <span class="od">No cable. Slower and lossier, so the app keeps a longer buffer to cover it.</span>
          <span v-if="!hasBle" class="on">Web Bluetooth unavailable. {{ why }}</span>
        </button>

        <div class="opt sim">
          <span class="ot">Simulator</span>
          <span class="od">
            No hardware. The whole app works, driven by a model of the board, so you can plan a job
            or learn the rig before you own one.
          </span>
          <div class="simrow">
            <select v-model="simProfile" aria-label="machine to simulate">
              <option value="detent-28byj">DETENT: two mirror stepper scanner</option>
              <option value="washer-servo">WASHER: servo pan and tilt head</option>
            </select>
            <button class="hb-pri" :disabled="busy" @click="emit('simulate', simProfile)">start</button>
          </div>
        </div>
      </div>

      <p v-if="error" class="err">{{ error }}</p>
      <p v-if="busy" class="busy">listening for the board</p>

      <p class="foot">
        Connecting reads the board's stored setup and adopts it. Nothing is written to it until
        you ask, because the board is the thing bolted to the wall and it is the authority on how
        it is installed.
      </p>
    </div>
  </div>
</template>

<style scoped>
.screen { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--hb-bg-sunken); }
.card {
  width: min(680px, 100%); background: var(--hb-bg); border: 3px solid var(--hb-rule);
  box-shadow: var(--hb-shadow-modal); padding: 24px 26px 26px;
}
.head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
.mark { font-family: var(--hb-marker); font-size: 40px; letter-spacing: .04em; }
.tag { font-family: var(--hb-mono); font-weight: 700; font-size: 9px; letter-spacing: .2em; text-transform: uppercase; color: var(--hb-fg-muted); }
.lede { font-family: var(--hb-type); font-size: 12.5px; line-height: 1.62; margin: 0 0 20px; }
.opts { display: grid; gap: 12px; }
.opt {
  display: grid; gap: 5px; text-align: left; padding: 13px 14px; background: var(--hb-bg-raised);
  border: 2px solid var(--hb-rule); box-shadow: var(--hb-shadow-sm); cursor: pointer;
  text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--hb-fg);
  /* The base button rule centres its content. These are cards, so start-align them
     or the headings drift into the middle. */
  justify-items: start; justify-content: stretch;
}
button.opt:hover:not(:disabled) { background: var(--hb-pink); color: var(--hb-paper); border-color: var(--hb-rule); }
button.opt:hover:not(:disabled) .od { color: var(--hb-paper); }
button.opt:active:not(:disabled) { transform: translate(3px, 3px); box-shadow: none; }
button.opt:disabled { opacity: .45; cursor: not-allowed; box-shadow: none; }
.opt.sim { cursor: default; }
.ot { font-family: var(--hb-marker); font-size: 17px; }
.od { font-family: var(--hb-type); font-size: 11.5px; line-height: 1.5; color: var(--hb-fg-faint); }
.on { font-family: var(--hb-mono); font-size: 9px; letter-spacing: .1em; color: var(--hb-danger); }
.simrow { display: flex; gap: 9px; margin-top: 7px; }
.simrow select { flex: 1; }
.err { font-family: var(--hb-mono); font-size: 10px; letter-spacing: .1em; color: var(--hb-danger); margin-top: 14px; }
.busy { font-family: var(--hb-mono); font-size: 10px; letter-spacing: .1em; color: var(--hb-pink); margin-top: 14px; }
.foot {
  font-family: var(--hb-type); font-size: 11px; color: var(--hb-fg-faint); line-height: 1.55;
  margin: 20px 0 0; border-top: 2px solid var(--hb-rule); padding-top: 14px;
}
</style>
