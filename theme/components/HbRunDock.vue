<script setup lang="ts">
/*
 * The run dock, pinned.
 *
 * From the servo tool: plot, pause and stop live in a strip that is always on
 * screen rather than inside a scrolling column, the way a sender keeps its laser
 * panel resident. A stop control that is a scroll away is not a stop control.
 *
 * The speed slider rides in the dock for the same reason. It is the one number the
 * operator reaches for mid-plot, so it never sits behind the motion tuning fold
 * with the set-once values.
 *
 * The dock decides nothing. It cannot tell whether a job may start, so `canRun`,
 * `canPause` and `canStop` come in as props and every press goes out as an event.
 */
import { computed } from "vue";
import HbButton from "./HbButton.vue";
import HbRange from "./HbRange.vue";

const props = withDefaults(
  defineProps<{
    primaryLabel?: string;
    running?: boolean;
    paused?: boolean;
    /** 0 to 1. Anything outside is clamped for the bar only. */
    progress?: number;
    canRun?: boolean;
    canPause?: boolean;
    canStop?: boolean;
    /** Left of the progress bar. Elapsed, remaining, segment counts. */
    status?: string;
    /** Right of the progress bar, in accent. Whatever the app wants to shout. */
    detail?: string;
    showSpeed?: boolean;
    speed?: number;
    speedMin?: number;
    speedMax?: number;
    speedStep?: number;
    speedLabel?: string;
    speedUnit?: string;
    speedDecimals?: number;
  }>(),
  {
    primaryLabel: "PLOT",
    running: false,
    paused: false,
    progress: 0,
    canRun: true,
    canPause: false,
    canStop: false,
    status: "",
    detail: "",
    showSpeed: true,
    speed: 1,
    speedMin: 0.1,
    speedMax: 2,
    speedStep: 0.05,
    speedLabel: "SPEED",
    speedUnit: "x",
    speedDecimals: 2,
  },
);

const emit = defineEmits<{
  (e: "run"): void;
  (e: "pause"): void;
  (e: "stop"): void;
  (e: "update:speed", value: number): void;
}>();

const pct = computed(() => {
  const p = Number.isFinite(props.progress) ? props.progress : 0;
  return Math.max(0, Math.min(1, p)) * 100;
});

const barValue = computed(() => Math.round(pct.value));
</script>

<template>
  <div class="hb-rundock" :class="{ running, paused }">
    <div class="btns">
      <HbButton
        class="pri"
        variant="primary"
        size="lg"
        :icon="running ? 'wave' : 'play'"
        :disabled="!canRun"
        @click="emit('run')"
      >
        {{ primaryLabel }}
      </HbButton>
      <!-- Through `props` so withDefaults' defaults narrow. See HbConsole. -->
      <HbButton
        size="lg"
        icon="pause"
        toggle
        :pressed="props.paused"
        :disabled="!canPause"
        @click="emit('pause')"
      >
        {{ paused ? "RESUME" : "PAUSE" }}
      </HbButton>
      <HbButton
        variant="danger"
        size="lg"
        icon="stop"
        :disabled="!canStop"
        @click="emit('stop')"
      >
        STOP
      </HbButton>
    </div>

    <div
      class="prog"
      role="progressbar"
      aria-label="job progress"
      :aria-valuenow="barValue"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div class="fill" :style="{ width: `${pct}%` }"></div>
    </div>

    <div v-if="status || detail" class="line">
      <span class="s">{{ status }}</span>
      <b v-if="detail" class="d">{{ detail }}</b>
    </div>

    <HbRange
      v-if="showSpeed"
      class="spd"
      on-dark
      :label="props.speedLabel"
      :model-value="props.speed"
      :min="props.speedMin"
      :max="props.speedMax"
      :step="props.speedStep"
      :unit="props.speedUnit"
      :decimals="props.speedDecimals"
      @update:model-value="emit('update:speed', $event)"
    />

    <div class="extra"><slot /></div>
  </div>
</template>

<style scoped>
/*
 * Ink in both schemes, like the header, and for the same reason: this strip
 * carries the stop.
 */
.hb-rundock {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: var(--hb-space-3);
  background: var(--hb-ink-2);
  border: var(--hb-border);
  border-color: var(--hb-ink);
  border-bottom: var(--hb-border-thick);
  border-radius: var(--hb-radius);
  box-shadow: var(--hb-shadow);

  --hb-bg: var(--hb-ink-2);
  --hb-bg-raised: var(--hb-ink);
  --hb-bg-sunken: #000;
  --hb-fg: var(--hb-paper);
  --hb-fg-muted: rgba(245, 240, 230, 0.62);
  --hb-fg-faint: rgba(245, 240, 230, 0.38);
  --hb-rule: rgba(245, 240, 230, 0.24);
  --hb-shadow-color: rgba(245, 240, 230, 0.24);
}

/*
 * A running dock is tinted, because the difference between armed and idle has to
 * be readable from across a room without reading any words.
 */
.running {
  background: #2a0d16;
  border-color: var(--hb-pink);
}

.btns {
  display: grid;
  grid-template-columns: 1.35fr 1fr 1fr;
  gap: 7px;
}

.prog {
  height: 14px;
  background: var(--hb-bg-sunken);
  border: 2px solid var(--hb-rule);
  border-radius: var(--hb-radius);
  overflow: hidden;
}

.fill {
  height: 100%;
  width: 0;
  background: var(--hb-pink);
  transition: width 0.12s linear;
}

.line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--hb-space-3);
  font-family: var(--hb-font-terminal);
  font-size: var(--hb-text-lg);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--hb-fg-muted);
}

.d {
  font-weight: 400;
  font-size: 17px;
  color: var(--hb-pink);
  white-space: nowrap;
}

.extra:empty {
  display: none;
}

@media (max-width: 560px) {
  .btns {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fill {
    transition: none;
  }
}
</style>
