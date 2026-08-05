<script setup lang="ts">
/*
 * Slider with the live value beside its label.
 *
 * The value is always visible and never a tooltip. Every slider in this app sets
 * something with a real unit on the wall, and a control whose number only appears
 * while you are dragging it cannot be read back afterwards to see what the rig is
 * actually set to.
 */
import { computed } from "vue";
import { hbUid } from "./uid";

const props = withDefaults(
  defineProps<{
    label: string;
    modelValue: number;
    min: number;
    max: number;
    step?: number;
    unit?: string;
    /** Decimal places in the readout. The slider's own step is unaffected. */
    decimals?: number;
    disabled?: boolean;
    id?: string;
    /** Sits on a dark strip, as it does in the run dock. */
    onDark?: boolean;
  }>(),
  { step: 1, unit: "", decimals: 0, disabled: false, id: "", onDark: false },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: number): void;
  (e: "commit", value: number): void;
}>();

const fallbackId = hbUid("hb-rng");
const inputId = computed(() => props.id || fallbackId);
const shown = computed(() => props.modelValue.toFixed(props.decimals));

function onInput(ev: Event): void {
  const el = ev.target as HTMLInputElement | null;
  if (!el) return;
  const v = Number.parseFloat(el.value);
  if (Number.isFinite(v)) emit("update:modelValue", v);
}

function onChange(ev: Event): void {
  const el = ev.target as HTMLInputElement | null;
  if (!el) return;
  const v = Number.parseFloat(el.value);
  if (Number.isFinite(v)) emit("commit", v);
}
</script>

<template>
  <div class="hb-range" :class="{ ondark: onDark, disabled }">
    <div class="top">
      <label class="lbl" :for="inputId">{{ label }}</label>
      <output class="val" :for="inputId">{{ shown }}<span v-if="unit" class="u">{{ unit }}</span></output>
    </div>
    <input
      :id="inputId"
      class="sld"
      type="range"
      :value="modelValue"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      @input="onInput"
      @change="onChange"
    />
  </div>
</template>

<style scoped>
.hb-range {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--hb-space-2);
}

.lbl {
  font-family: var(--hb-font-terminal);
  font-size: var(--hb-text-lg);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--hb-fg-muted);
  cursor: pointer;
}

.val {
  font-family: var(--hb-font-terminal);
  font-size: 17px;
  color: var(--hb-pink);
  white-space: nowrap;
}

.u {
  font-family: var(--hb-font-mono);
  font-size: var(--hb-text-xs);
  color: var(--hb-fg-faint);
  margin-left: 3px;
}

/* Zero radius means building the track and the thumb by hand in both engines. */
.sld {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  margin: 7px 0 4px;
  background: var(--hb-fg);
  border-radius: var(--hb-radius);
  outline: none;
  cursor: pointer;
}

.sld::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  background: var(--hb-pink);
  border: 2px solid var(--hb-fg);
  border-radius: var(--hb-radius);
  cursor: pointer;
}

.sld::-moz-range-thumb {
  width: 16px;
  height: 16px;
  background: var(--hb-pink);
  border: 2px solid var(--hb-fg);
  border-radius: var(--hb-radius);
  cursor: pointer;
}

.sld:focus-visible {
  outline: 3px solid var(--hb-pink);
  outline-offset: 4px;
}

.disabled {
  opacity: 0.45;
}

.disabled .sld {
  cursor: not-allowed;
}

/*
 * On the run dock the strip is ink in both schemes, so the track and thumb are
 * lit against it rather than against the page.
 */
.ondark .lbl {
  color: rgba(245, 240, 230, 0.55);
}

.ondark .sld {
  background: rgba(245, 240, 230, 0.28);
}

.ondark .sld::-webkit-slider-thumb {
  border-color: var(--hb-paper);
}

.ondark .sld::-moz-range-thumb {
  border-color: var(--hb-paper);
}
</style>
