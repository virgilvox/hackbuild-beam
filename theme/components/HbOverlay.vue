<script setup lang="ts">
/*
 * Modal card on a dimmed page. The manual, a confirm, a firmware dump.
 *
 * Backdrop click closes, and it closes only on a press that both started and ended
 * on the backdrop. Testing the target of the click alone means a drag that begins
 * on text inside the card and releases outside it dismisses the dialog, which loses
 * whatever was in it. That is the standard failure of a naive backdrop handler.
 *
 * Escape closes too, and the listener is bound only while the overlay is open, so a
 * closed overlay is not sitting on the document swallowing key events.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import HbButton from "./HbButton.vue";
import { hbUid } from "./uid";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    /** Card width. Any CSS length. */
    width?: string;
    /** Esc and backdrop stop closing. For an operation that must be answered. */
    persistent?: boolean;
  }>(),
  { title: "", width: "680px", persistent: false },
);

const emit = defineEmits<{
  (e: "close"): void;
}>();

const titleId = hbUid("hb-overlay");
const card = ref<HTMLElement | null>(null);
let pressedBackdrop = false;

function close(): void {
  emit("close");
}

function onBackdropDown(ev: MouseEvent): void {
  pressedBackdrop = ev.target === ev.currentTarget;
}

function onBackdropUp(ev: MouseEvent): void {
  const bothOnBackdrop = pressedBackdrop && ev.target === ev.currentTarget;
  pressedBackdrop = false;
  if (bothOnBackdrop && !props.persistent) close();
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && !props.persistent) close();
}

/*
 * The document listener is bound in onMounted and in the watcher rather than by an
 * immediate watcher, because an immediate watcher runs during setup, which on a
 * server or in a test environment with no document is a crash before the component
 * has rendered anything. onMounted only ever runs where a document exists.
 */
function bind(on: boolean): void {
  if (on) document.addEventListener("keydown", onKeydown);
  else document.removeEventListener("keydown", onKeydown);
}

onMounted(() => {
  if (props.open) {
    bind(true);
    card.value?.focus();
  }
});

watch(
  () => props.open,
  async (isOpen) => {
    bind(isOpen);
    if (!isOpen) return;
    await nextTick();
    card.value?.focus();
  },
);

onBeforeUnmount(() => {
  bind(false);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="hb-overlay"
      @mousedown="onBackdropDown"
      @mouseup="onBackdropUp"
    >
      <div
        ref="card"
        class="card"
        :style="{ maxWidth: width }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="title ? titleId : undefined"
        tabindex="-1"
      >
        <div v-if="title || !persistent" class="head">
          <h2 v-if="title" :id="titleId" class="t">{{ title }}</h2>
          <span class="sp"></span>
          <HbButton
            v-if="!persistent"
            class="x"
            size="sm"
            variant="ghost"
            icon="x"
            title="close"
            @click="close"
          >
            close
          </HbButton>
        </div>
        <div class="body"><slot /></div>
        <div v-if="$slots.footer" class="foot"><slot name="footer" /></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.hb-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow: auto;
  padding: 30px 14px;
  background: rgba(10, 10, 10, 0.6);
}

.card {
  position: relative;
  width: 100%;
  background: var(--hb-bg);
  color: var(--hb-fg);
  border: 3px solid var(--hb-fg);
  border-radius: var(--hb-radius);
  box-shadow: 8px 8px 0 0 var(--hb-pink);
  padding: var(--hb-space-5);
}

.card:focus {
  outline: none;
}

.card:focus-visible {
  outline: 3px solid var(--hb-pink);
  outline-offset: 4px;
}

.head {
  display: flex;
  align-items: center;
  gap: var(--hb-space-3);
  margin-bottom: var(--hb-space-4);
  padding-bottom: var(--hb-space-2);
  border-bottom: var(--hb-border-thick);
}

.t {
  margin: 0;
  font-family: var(--hb-font-display);
  font-weight: 400;
  font-size: 21px;
  line-height: 1.2;
  color: var(--hb-fg);
}

.sp {
  flex: 1 1 auto;
}

.body {
  font-family: var(--hb-font-prose);
  font-size: var(--hb-text-md);
  line-height: 1.62;
  color: var(--hb-fg);
}

.foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--hb-space-2);
  margin-top: var(--hb-space-4);
  padding-top: var(--hb-space-3);
  border-top: 2px solid var(--hb-rule);
}
</style>
