<script setup lang="ts">
/*
 * A bordered group with a heading. The stepper tool's left rail was a stack of
 * these and it is the right shape for a machine column: the heading is the hit
 * target, collapsing is one click, and the body is whatever the app puts in it.
 *
 * Collapsible panels are controlled: the app owns `open` so a layout can restore
 * which groups were shut. Passing no handler still works, because the heading
 * falls back to an internal flag when `open` is not supplied.
 */
import { computed, ref, watch } from "vue";
import HbIcon from "./HbIcon.vue";
import { hbUid } from "./uid";

const props = withDefaults(
  defineProps<{
    heading: string;
    collapsible?: boolean;
    /** Controlled state. Omit to let the panel keep its own. */
    open?: boolean;
    /** Sunken heading strip rather than a solid one. Used inside dark columns. */
    flat?: boolean;
  }>(),
  { collapsible: false, open: true, flat: false },
);

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
}>();

const bodyId = hbUid("hb-panel");
const inner = ref(props.open);
watch(
  () => props.open,
  (v) => {
    inner.value = v;
  },
);

const shown = computed(() => (props.collapsible ? inner.value : true));

function toggle(): void {
  inner.value = !inner.value;
  emit("update:open", inner.value);
}
</script>

<template>
  <section class="hb-panel" :class="{ flat, closed: !shown }">
    <!-- The strip is not the button: the actions slot holds buttons, and a
         button inside a button is invalid and unreachable by keyboard. -->
    <div class="head">
      <button
        v-if="collapsible"
        class="title titlebtn"
        type="button"
        :aria-expanded="shown"
        :aria-controls="bodyId"
        @click="toggle"
      >
        <span class="titletext">{{ heading }}</span>
        <HbIcon class="chev" name="chevron" size="12" />
      </button>
      <h3 v-else class="title">{{ heading }}</h3>
      <span class="acts"><slot name="actions" /></span>
    </div>

    <div v-show="shown" :id="bodyId" class="body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.hb-panel {
  background: var(--hb-bg);
  border: var(--hb-border);
  border-color: var(--hb-fg);
  border-radius: var(--hb-radius);
  box-shadow: var(--hb-shadow-sm);
}

[data-scheme="ink"] .hb-panel {
  box-shadow: 3px 3px 0 0 var(--hb-rule);
}

.head {
  display: flex;
  align-items: center;
  gap: var(--hb-space-2);
  width: 100%;
  padding: 0 var(--hb-space-3);
  background: var(--hb-bg-sunken);
  border-bottom: var(--hb-border-thick);
}

.title {
  display: flex;
  align-items: center;
  gap: var(--hb-space-2);
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  padding: 8px 0 7px;
  background: transparent;
  color: var(--hb-fg);
  border: none;
  border-radius: var(--hb-radius);
  font-family: var(--hb-font-display);
  font-weight: 400;
  font-size: var(--hb-text-lg);
  letter-spacing: 0.02em;
  line-height: 1.2;
  text-align: left;
}

.titletext {
  flex: 1 1 auto;
  min-width: 0;
}

.titlebtn {
  cursor: pointer;
}

.titlebtn:focus-visible {
  outline: 3px solid var(--hb-pink);
  outline-offset: -3px;
}

.acts {
  display: flex;
  align-items: center;
  gap: var(--hb-space-2);
  flex: 0 0 auto;
}

.chev {
  color: var(--hb-pink);
  transition: transform 0.08s linear;
}

.closed .chev {
  transform: rotate(-90deg);
}

.flat > .head {
  background: transparent;
  border-bottom: 2px solid var(--hb-rule);
}

.flat > .head > .title {
  font-family: var(--hb-font-terminal);
  font-size: var(--hb-text-lg);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--hb-fg-muted);
}

.body {
  display: flex;
  flex-direction: column;
  gap: var(--hb-space-3);
  padding: var(--hb-space-3);
}
</style>
