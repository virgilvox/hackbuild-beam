<script setup lang="ts">
/*
 * Header status chip: a square dot, a name, and a value. LINK, BEAM, POS, Q.
 *
 * The dot is a square, not a circle, and it either blinks or it does not. A hard
 * two step blink is picked up in peripheral vision while the operator is looking
 * at the wall; a smooth pulse is not, and a beam state that has to be looked at
 * directly to be read is not a beam state indicator.
 *
 * The live value is announced politely, because BEAM ON arriving silently is the
 * one state change a screen reader user cannot afford to miss.
 */
import type { HbChipState } from "./types";

withDefaults(
  defineProps<{
    label: string;
    value?: string | number | null;
    state?: HbChipState;
    /** Announce value changes. Leave off for chips that update many times a second. */
    live?: boolean;
  }>(),
  { value: null, state: "idle", live: false },
);
</script>

<template>
  <div class="hb-chip" :class="`st-${state}`">
    <span class="dot" aria-hidden="true"></span>
    <span class="k">{{ label }}</span>
    <span
      v-if="value !== null && value !== ''"
      class="v"
      :aria-live="live ? 'polite' : undefined"
      >{{ value }}</span
    >
  </div>
</template>

<style scoped>
.hb-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 2px 9px;
  background: var(--hb-bg-sunken);
  border: 2px solid var(--hb-rule);
  border-radius: var(--hb-radius);
  font-family: var(--hb-font-terminal);
  font-size: var(--hb-text-lg);
  line-height: 1.25;
  color: var(--hb-fg-muted);
  white-space: nowrap;
}

.k {
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.v {
  color: var(--hb-fg);
}

.dot {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  background: var(--hb-fg-faint);
  border: 1px solid var(--hb-rule);
  border-radius: var(--hb-radius);
}

.st-on .dot,
.st-hot .dot {
  background: var(--hb-pink);
  border-color: var(--hb-pink);
}

.st-hot {
  border-color: var(--hb-pink);
}

.st-hot .dot {
  border-color: var(--hb-fg);
  animation: hb-blip 0.9s steps(2, end) infinite;
}

.st-danger {
  border-color: var(--hb-danger);
  color: var(--hb-fg);
}

.st-danger .dot {
  background: var(--hb-danger);
  border-color: var(--hb-danger);
  animation: hb-blip 0.9s steps(2, end) infinite;
}

@keyframes hb-blip {
  50% {
    opacity: 0.25;
  }
}

/*
 * An operator who has asked for less motion still needs to know the beam is lit,
 * so the blink becomes a solid lit dot rather than nothing at all.
 */
@media (prefers-reduced-motion: reduce) {
  .st-hot .dot,
  .st-danger .dot {
    animation: none;
  }
}
</style>
