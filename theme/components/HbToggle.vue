<script setup lang="ts">
/*
 * A real checkbox, restyled. `appearance: none` keeps the element, its focus
 * behaviour, its keyboard handling and its role, and only takes the paint away.
 * The tick is two borders on a rotated box rather than a glyph, so it costs no
 * font and holds its weight at any size.
 */
import { computed } from "vue";
import { hbUid } from "./uid";

const props = withDefaults(
  defineProps<{
    label: string;
    modelValue: boolean;
    disabled?: boolean;
    id?: string;
  }>(),
  { disabled: false, id: "" },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
}>();

const fallbackId = hbUid("hb-tog");
const inputId = computed(() => props.id || fallbackId);

function onChange(ev: Event): void {
  const el = ev.target as HTMLInputElement | null;
  if (el) emit("update:modelValue", el.checked);
}
</script>

<template>
  <div class="hb-toggle" :class="{ disabled }">
    <input
      :id="inputId"
      class="box"
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      @change="onChange"
    />
    <label class="lbl" :for="inputId">{{ label }}</label>
  </div>
</template>

<style scoped>
.hb-toggle {
  display: flex;
  align-items: center;
  gap: var(--hb-space-2);
  min-width: 0;
}

.box {
  -webkit-appearance: none;
  appearance: none;
  position: relative;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  margin: 0;
  background: var(--hb-bg-raised);
  border: var(--hb-border);
  border-color: var(--hb-fg);
  border-radius: var(--hb-radius);
  cursor: pointer;
}

.box:checked {
  background: var(--hb-pink);
  border-color: var(--hb-pink);
}

.box:checked::after {
  content: "";
  position: absolute;
  left: 4px;
  top: -1px;
  width: 6px;
  height: 11px;
  border: solid var(--hb-paper);
  border-width: 0 3px 3px 0;
  transform: rotate(45deg);
}

.box:focus-visible {
  outline: 3px solid var(--hb-pink);
  outline-offset: 2px;
}

.lbl {
  min-width: 0;
  font-family: var(--hb-font-terminal);
  font-size: var(--hb-text-lg);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  line-height: 1.2;
  color: var(--hb-fg);
  cursor: pointer;
  user-select: none;
}

.disabled .box,
.disabled .lbl {
  cursor: not-allowed;
}

.disabled {
  opacity: 0.45;
}
</style>
