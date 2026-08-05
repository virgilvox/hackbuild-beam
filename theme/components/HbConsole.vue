<script setup lang="ts">
/*
 * The wire log.
 *
 * Two behaviours here were paid for in the originals and are ported rather than
 * reinvented.
 *
 * The node cap: both tools trimmed the log from the front, at 300 and at 400 lines.
 * A running plot logs on every credit report, several times a second, for as long
 * as the job lasts. Uncapped, the browser spends the tail of a long plot laying out
 * scrollback nobody is reading, on the same main thread that is pacing the emitter.
 *
 * The scroll: both tools set scrollTop to scrollHeight on every line. That is right
 * while you are watching the tail and wrong the moment you scroll up to read what
 * happened, because it drags you back down on the next packet. So the stick is
 * conditional: within a line or so of the bottom, follow; anywhere else, hold still.
 *
 * The buffer belongs to the app. This component takes lines and emits nothing into
 * them; `clear` is a request, not an action.
 */
import { computed, nextTick, ref, watch } from "vue";
import HbButton from "./HbButton.vue";
import { capLines, HB_CONSOLE_MAX, type HbConsoleLine } from "./console";

const props = withDefaults(
  defineProps<{
    lines: HbConsoleLine[];
    max?: number;
    autoScroll?: boolean;
    /** Any CSS length. The servo tool ran 300px, the stepper tool 118px. */
    height?: string;
    title?: string;
    showClear?: boolean;
  }>(),
  {
    max: HB_CONSOLE_MAX,
    autoScroll: true,
    height: "180px",
    title: "CONSOLE",
    showClear: true,
  },
);

const emit = defineEmits<{
  (e: "clear"): void;
}>();

/*
 * Template reads of a defaulted prop go through `props`, here and in the other
 * components in this folder.
 *
 * vue-tsc does not apply `withDefaults` to the template's own view of the props, so
 * a bare `max` in the markup still types as `number | undefined` and, under
 * exactOptionalPropertyTypes, fails the moment it is handed to anything that wants a
 * number. The `props` object is typed from the return of `withDefaults`, so reading
 * through it is both correct and the same value at runtime.
 */

const view = ref<HTMLElement | null>(null);
const stuck = ref(true);

const shown = computed(() => capLines(props.lines, props.max));

/* One line of slack. Anything tighter and a fractional scrollHeight unsticks it. */
const STICK_SLACK_PX = 24;

function onScroll(): void {
  const el = view.value;
  if (!el) return;
  stuck.value = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK_PX;
}

watch(
  () => props.lines.length,
  async () => {
    if (!props.autoScroll || !stuck.value) return;
    await nextTick();
    const el = view.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);
</script>

<template>
  <div class="hb-console">
    <div class="bar">
      <span class="t">{{ title }}</span>
      <span class="slot"><slot name="actions" /></span>
      <span v-if="lines.length > props.max" class="trim">last {{ props.max }}</span>
      <HbButton v-if="showClear" size="sm" variant="ghost" @click="emit('clear')">
        clear
      </HbButton>
    </div>

    <div
      ref="view"
      class="view"
      :style="{ height }"
      role="log"
      aria-live="polite"
      tabindex="0"
      @scroll="onScroll"
    >
      <div v-for="(l, i) in shown" :key="i" class="ln" :class="`l-${l.level}`">{{ l.text }}</div>
    </div>
  </div>
</template>

<style scoped>
/*
 * The console is ink in both schemes. It is a terminal, it is read at a glance
 * for colour rather than for words, and the tx/rx/err separation only works
 * against a dark ground.
 */
.hb-console {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--hb-ink-2);
  border: var(--hb-border);
  border-color: var(--hb-fg);
  border-radius: var(--hb-radius);
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--hb-space-2);
  padding: 2px var(--hb-space-2) 2px var(--hb-space-3);
  border-bottom: 1px solid rgba(245, 240, 230, 0.18);
  font-family: var(--hb-font-mono);
  font-weight: 700;
  font-size: var(--hb-text-xs);
  letter-spacing: 0.2em;
  color: rgba(245, 240, 230, 0.5);
}

.t {
  flex: 0 0 auto;
}

.slot {
  display: flex;
  align-items: center;
  gap: var(--hb-space-2);
  flex: 1 1 auto;
  min-width: 0;
}

.trim {
  flex: 0 0 auto;
  font-family: var(--hb-font-terminal);
  font-size: var(--hb-text-md);
  letter-spacing: 0.06em;
  color: rgba(245, 240, 230, 0.34);
}

.bar :deep(.hb-btn) {
  color: rgba(245, 240, 230, 0.5);
}

.bar :deep(.hb-btn:hover:not(:disabled)) {
  color: var(--hb-pink);
}

.view {
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 5px var(--hb-space-3);
  font-family: var(--hb-font-terminal);
  font-size: 15px;
  line-height: 1.32;
  color: rgba(245, 240, 230, 0.55);
  white-space: pre-wrap;
  word-break: break-word;
}

.view:focus-visible {
  outline: 3px solid var(--hb-pink);
  outline-offset: -3px;
}

/* Host to board. */
.l-tx {
  color: var(--hb-pink);
}

/* Board to host. */
.l-rx {
  color: rgba(245, 240, 230, 0.55);
}

.l-err {
  color: var(--hb-danger);
}

/* The app talking about itself. */
.l-sys {
  color: var(--hb-paper);
}

/*
 * The simulator, set in the prose face so a dry run can never be mistaken at a
 * glance for a board that is actually answering. It is not green: green means a
 * captured corner and nothing else.
 */
.l-sim {
  color: rgba(245, 240, 230, 0.42);
  font-family: var(--hb-font-prose);
  font-size: var(--hb-text-sm);
}
</style>
