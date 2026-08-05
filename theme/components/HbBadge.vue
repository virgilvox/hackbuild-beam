<script setup lang="ts">
/*
 * A small hard edged tag. No dot and no live state: that is HbChip's job. This is
 * for a label on a thing, a count, a format name, a profile id.
 */
withDefaults(
  defineProps<{
    tone?: "default" | "accent" | "ok" | "danger";
  }>(),
  { tone: "default" },
);
</script>

<template>
  <span class="hb-badge" :class="`t-${tone}`"><slot /></span>
</template>

<style scoped>
.hb-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--hb-space-1);
  padding: 2px 6px;
  background: transparent;
  color: var(--hb-fg-muted);
  border: 2px solid var(--hb-rule);
  border-radius: var(--hb-radius);
  font-family: var(--hb-font-mono);
  font-weight: 700;
  font-size: var(--hb-text-xs);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  line-height: 1.25;
  white-space: nowrap;
}

.t-accent {
  background: var(--hb-pink);
  color: var(--hb-paper);
  border-color: var(--hb-pink);
}

/* Green means one thing here. See tokens.css. */
.t-ok {
  background: var(--hb-ok-bg);
  color: var(--hb-ok);
  border-color: var(--hb-ok);
}

.t-danger {
  background: var(--hb-danger);
  color: var(--hb-ink);
  border-color: var(--hb-danger);
}
</style>
