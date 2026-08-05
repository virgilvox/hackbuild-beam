<script setup lang="ts">
/*
 * One line of readout: a small mono key on the left, a large terminal value on the
 * right, a dashed rule under both. This is the stepper tool's `.kv` and it is the
 * densest honest way to show a dozen live numbers in a narrow rail.
 *
 * The value takes the terminal face at nearly twice the key's size because these
 * are read at arm's length while looking mostly at the wall.
 */
import type { HbKvState } from "./types";

withDefaults(
  defineProps<{
    k: string;
    v: string | number;
    /* `ok` is the one green in the system and it means a corner is captured.
     * Spending it anywhere else is what makes it stop meaning that. */
    state?: HbKvState;
    /** Unit suffix, set smaller and faint so it never competes with the number. */
    unit?: string;
  }>(),
  { state: "default", unit: "" },
);
</script>

<template>
  <div class="hb-kv" :class="`st-${state}`">
    <span class="k">{{ k }}</span>
    <span class="v"
      >{{ v }}<span v-if="unit" class="u">{{ unit }}</span></span
    >
  </div>
</template>

<style scoped>
.hb-kv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--hb-space-3);
  padding-bottom: 2px;
  border-bottom: 1px dashed var(--hb-rule);
  min-width: 0;
}

.k {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--hb-font-mono);
  font-size: var(--hb-text-xs);
  letter-spacing: 0.02em;
  color: var(--hb-fg-muted);
}

.v {
  flex: 0 0 auto;
  font-family: var(--hb-font-terminal);
  font-size: 17px;
  font-weight: 400;
  line-height: 1;
  color: var(--hb-fg);
  white-space: nowrap;
}

.u {
  font-family: var(--hb-font-mono);
  font-size: var(--hb-text-xs);
  color: var(--hb-fg-faint);
  margin-left: 3px;
}

.st-hot .v {
  color: var(--hb-pink);
}

.st-ok .v {
  color: var(--hb-ok);
}

.st-danger .v {
  color: var(--hb-danger);
}
</style>
