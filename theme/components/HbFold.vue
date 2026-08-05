<script setup lang="ts">
/*
 * Closed by default, on purpose.
 *
 * The servo tool learned this the expensive way: the explanations that make the
 * motion tuning numbers usable are each a full paragraph, and left open they push
 * the controls they explain off the bottom of the column. Folded, the paragraph is
 * one line of summary until somebody wants it.
 *
 * Native <details> rather than a hand rolled disclosure, because it is keyboard
 * operable, findable by in page search in browsers that support it, and it degrades
 * to an open block with no script at all.
 */
import { ref, watch } from "vue";
import HbIcon from "./HbIcon.vue";

const props = withDefaults(
  defineProps<{
    summary: string;
    open?: boolean;
    icon?: "info" | "question" | "warning" | "gear";
  }>(),
  { open: false, icon: "info" },
);

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
}>();

const inner = ref(props.open);
watch(
  () => props.open,
  (v) => {
    inner.value = v;
  },
);

function onToggle(ev: Event): void {
  const el = ev.currentTarget as HTMLDetailsElement | null;
  if (!el) return;
  if (el.open === inner.value) return;
  inner.value = el.open;
  emit("update:open", el.open);
}
</script>

<template>
  <details class="hb-fold" :open="inner" @toggle="onToggle">
    <summary>
      <!-- Through `props` so withDefaults' default narrows. See HbConsole. -->
      <HbIcon :name="props.icon" size="12" />
      <span>{{ summary }}</span>
    </summary>
    <div class="foldbody">
      <slot />
    </div>
  </details>
</template>

<style scoped>
.hb-fold {
  margin: 0;
}

summary {
  display: flex;
  align-items: center;
  gap: var(--hb-space-2);
  list-style: none;
  cursor: pointer;
  padding: 3px 0 4px;
  font-family: var(--hb-font-terminal);
  font-size: var(--hb-text-lg);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--hb-fg-muted);
}

/* Safari still ships the default triangle behind a vendor pseudo element. */
summary::-webkit-details-marker {
  display: none;
}

summary:hover {
  color: var(--hb-fg);
}

summary:focus-visible {
  outline: 3px solid var(--hb-pink);
  outline-offset: 2px;
}

summary :deep(.hb-icon) {
  color: var(--hb-pink);
}

.foldbody {
  padding: var(--hb-space-1) 0 var(--hb-space-2);
  font-family: var(--hb-font-prose);
  font-size: var(--hb-text-md);
  line-height: 1.6;
  color: var(--hb-fg-muted);
}
</style>
