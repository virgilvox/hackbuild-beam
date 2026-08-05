<script setup lang="ts">
/*
 * One sentence sitting directly under the control it explains, with a marker so it
 * reads as annotation and not as another field. Smaller and quieter than HbNote:
 * the note is for what a setting costs, the hint is for what it is.
 */
import HbIcon from "./HbIcon.vue";

const props = withDefaults(
  defineProps<{
    marker?: "info" | "warning" | "question" | "eye";
    tone?: "default" | "warning";
  }>(),
  { marker: "info", tone: "default" },
);
</script>

<template>
  <p class="hb-hint" :class="`t-${tone}`">
    <!-- Through `props` so withDefaults' default narrows. See HbConsole. -->
    <HbIcon class="mk" :name="props.marker" size="12" />
    <span class="txt"><slot /></span>
  </p>
</template>

<style scoped>
.hb-hint {
  display: flex;
  align-items: flex-start;
  gap: var(--hb-space-2);
  margin: 0;
  font-family: var(--hb-font-prose);
  font-size: var(--hb-text-sm);
  line-height: 1.5;
  color: var(--hb-fg-muted);
}

.mk {
  color: var(--hb-pink);
  /* Nudged to sit on the first line's cap height, not on its box. */
  margin-top: 2px;
}

.txt {
  min-width: 0;
}

.t-warning {
  color: var(--hb-fg);
}

.t-warning .mk {
  color: var(--hb-danger);
}
</style>
