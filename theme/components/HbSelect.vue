<script setup lang="ts">
/*
 * A labelled native select. Native because the option list on a bench is opened
 * with a thumb on a laptop trackpad or with a keyboard, and no custom listbox
 * repays that. The arrow is drawn beside it rather than replacing the element's
 * own, because hiding the native indicator on a native control is where custom
 * selects start.
 */
import { computed, nextTick, ref, watch } from "vue";
import HbIcon from "./HbIcon.vue";
import { hbUid } from "./uid";
import type { HbSelectOption } from "./types";

const props = withDefaults(
  defineProps<{
    label: string;
    modelValue: string;
    options: HbSelectOption[];
    disabled?: boolean;
    id?: string;
    /** Label above rather than beside. The default, since option text is wide. */
    stacked?: boolean;
  }>(),
  { disabled: false, id: "", stacked: true },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const fallbackId = hbUid("hb-sel");
const selectId = computed(() => props.id || fallbackId);
const el = ref<HTMLSelectElement | null>(null);

/*
 * Re-seat the selection when the option list is replaced.
 *
 * Vue sets `value` on a select as a DOM property, and a select whose options have
 * just changed drops back to its first option, so the element and the prop
 * disagree with nothing to fix it. Option lists here arrive late by nature: the
 * profile comes from the board's hello line, and its presets land after connect.
 */
watch(
  () => props.options,
  async () => {
    await nextTick();
    if (el.value && el.value.value !== props.modelValue) el.value.value = props.modelValue;
  },
);

function onChange(ev: Event): void {
  const el = ev.target as HTMLSelectElement | null;
  if (el) emit("update:modelValue", el.value);
}
</script>

<template>
  <div class="hb-select" :class="{ stacked, disabled }">
    <label class="lbl" :for="selectId">{{ label }}</label>
    <span class="wrap">
      <select
        :id="selectId"
        ref="el"
        class="sel"
        :value="modelValue"
        :disabled="disabled"
        @change="onChange"
      >
        <option
          v-for="o in options"
          :key="o.value"
          :value="o.value"
          :disabled="o.disabled === true"
        >
          {{ o.label }}
        </option>
      </select>
      <HbIcon class="chev" name="chevron" size="12" />
    </span>
  </div>
</template>

<style scoped>
.hb-select {
  display: flex;
  align-items: center;
  gap: var(--hb-space-2);
  min-width: 0;
}

.stacked {
  display: block;
}

.lbl {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--hb-font-mono);
  font-size: var(--hb-text-xs);
  letter-spacing: 0.02em;
  color: var(--hb-fg-muted);
  cursor: pointer;
}

.stacked .lbl {
  display: block;
  margin-bottom: var(--hb-space-1);
}

.wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  min-width: 0;
}

.stacked .wrap {
  display: flex;
  width: 100%;
}

.sel {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  background: var(--hb-bg-raised);
  color: var(--hb-fg);
  border: var(--hb-border);
  border-color: var(--hb-fg);
  border-radius: var(--hb-radius);
  font-family: var(--hb-font-mono);
  font-size: var(--hb-text-sm);
  line-height: 1.3;
  padding: 6px 26px 6px 7px;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}

.sel:focus {
  outline: none;
  border-color: var(--hb-pink);
  box-shadow: var(--hb-shadow-accent);
}

.sel:focus-visible {
  outline: 3px solid var(--hb-pink);
  outline-offset: 2px;
}

.chev {
  position: absolute;
  right: 8px;
  color: var(--hb-pink);
  pointer-events: none;
}

.disabled {
  opacity: 0.45;
}

.disabled .sel {
  cursor: not-allowed;
}
</style>
