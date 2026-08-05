<script setup lang="ts">
/*
 * A short muted paragraph in the typewriter face, with a pink rule down its left
 * edge. Both original tools used exactly this for the sentence that explains what
 * a control costs, and the face change is what keeps a paragraph of prose from
 * reading as another row of machine numbers.
 *
 * Keep it short. A note longer than about three lines belongs inside an HbFold.
 */
withDefaults(
  defineProps<{
    /** Danger keeps the same shape and swaps the rule, for a consequence note. */
    tone?: "default" | "danger";
  }>(),
  { tone: "default" },
);
</script>

<template>
  <p class="hb-note" :class="`t-${tone}`"><slot /></p>
</template>

<style scoped>
.hb-note {
  margin: 0;
  padding-left: var(--hb-space-2);
  border-left: 4px solid var(--hb-pink);
  font-family: var(--hb-font-prose);
  font-size: var(--hb-text-sm);
  line-height: 1.55;
  color: var(--hb-fg-muted);
}

.t-danger {
  border-left-color: var(--hb-danger);
  color: var(--hb-fg);
}
</style>
