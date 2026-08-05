<script setup lang="ts">
/*
 * A number with a unit and a label tied to it.
 *
 * The component does not clamp. min, max and step go to the element so the native
 * stepper and native validation behave, but what the operator typed is what gets
 * emitted, because clamping is a machine decision and the machine is not in the
 * theme. The rig's soft limits, the profile's axis range and the planner's own
 * budgets all clamp differently, and a control that quietly rewrites a number the
 * operator can still see on screen is how a value gets pushed to a board without
 * anybody noticing it changed.
 */
import { computed } from "vue";
import HbField from "./HbField.vue";
import { hbUid } from "./uid";

const props = withDefaults(
  defineProps<{
    label: string;
    modelValue: number;
    unit?: string;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    id?: string;
    stacked?: boolean;
    controlWidth?: string;
  }>(),
  { unit: "", disabled: false, id: "", stacked: false, controlWidth: "96px" },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: number): void;
  (e: "commit", value: number): void;
}>();

const fallbackId = hbUid("hb-num");
const inputId = computed(() => props.id || fallbackId);

function read(ev: Event): number | null {
  const el = ev.target as HTMLInputElement | null;
  if (!el) return null;
  /*
   * A half typed number is not a number. "-", "" and "1e" all parse to NaN, and
   * emitting NaN upward puts it straight into a geometry pipeline where it turns
   * into a plan of NaN and a job that never advances. Swallow it and wait.
   */
  const v = Number.parseFloat(el.value);
  return Number.isFinite(v) ? v : null;
}

function onInput(ev: Event): void {
  const v = read(ev);
  if (v !== null) emit("update:modelValue", v);
}

function onChange(ev: Event): void {
  const v = read(ev);
  if (v !== null) emit("commit", v);
}
</script>

<template>
  <!-- Through `props` so withDefaults' defaults narrow. See HbConsole. -->
  <HbField
    :label="label"
    :for="inputId"
    :stacked="props.stacked"
    :control-width="props.controlWidth"
    class="hb-number"
  >
    <span class="wrap" :class="{ disabled }">
      <input
        :id="inputId"
        class="inp"
        type="number"
        inputmode="decimal"
        :value="modelValue"
        :min="min"
        :max="max"
        :step="step"
        :disabled="disabled"
        @input="onInput"
        @change="onChange"
      />
      <span v-if="unit" class="unit" aria-hidden="true">{{ unit }}</span>
    </span>
  </HbField>
</template>

<style scoped>
.wrap {
  display: flex;
  align-items: stretch;
  width: 100%;
  background: var(--hb-bg-raised);
  border: var(--hb-border);
  border-color: var(--hb-fg);
  border-radius: var(--hb-radius);
}

.wrap:focus-within {
  border-color: var(--hb-pink);
  box-shadow: var(--hb-shadow-accent);
}

.wrap.disabled {
  opacity: 0.45;
}

.inp {
  flex: 1 1 auto;
  min-width: 0;
  background: transparent;
  color: var(--hb-fg);
  border: none;
  border-radius: var(--hb-radius);
  font-family: var(--hb-font-terminal);
  font-size: var(--hb-text-lg);
  line-height: 1.15;
  padding: 5px 7px;
  /* Firefox draws its own spinner and it is 20px of nothing in a 96px field. */
  -moz-appearance: textfield;
  appearance: textfield;
}

.inp::-webkit-outer-spin-button,
.inp::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.inp:focus {
  outline: none;
}

.unit {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  padding: 0 7px 0 4px;
  font-family: var(--hb-font-mono);
  font-size: var(--hb-text-xs);
  color: var(--hb-fg-faint);
  border-left: 1px dashed var(--hb-rule);
}
</style>
