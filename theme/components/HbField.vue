<script setup lang="ts">
/*
 * Label on the left, control on the right, one line. This is the stepper tool's
 * `label.row` and it is the reason that rail fits a dozen numbers in a column
 * narrow enough to leave the viewport its space.
 *
 * The label is a real <label for>, so the caller passes the id of whatever it puts
 * in the slot. A field with no `for` renders as a plain span rather than a label
 * pointing at nothing, because a label with a dangling `for` is worse than none:
 * it reads as a control to assistive tech and then does not focus one.
 */
withDefaults(
  defineProps<{
    label: string;
    /** id of the control in the slot. */
    for?: string;
    /** Stack label above control. For wide inputs, textareas and file pickers. */
    stacked?: boolean;
    /** Right hand column width. The rail looks wrong when these disagree. */
    controlWidth?: string;
  }>(),
  { for: "", stacked: false, controlWidth: "96px" },
);
</script>

<template>
  <div class="hb-field" :class="{ stacked }" :style="{ '--cw': controlWidth }">
    <label v-if="$props.for" class="lbl" :for="$props.for">{{ label }}</label>
    <span v-else class="lbl">{{ label }}</span>
    <div class="ctrl"><slot /></div>
  </div>
</template>

<style scoped>
.hb-field {
  display: flex;
  align-items: center;
  gap: var(--hb-space-2);
  min-width: 0;
}

.lbl {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--hb-font-mono);
  font-size: var(--hb-text-xs);
  letter-spacing: 0.02em;
  line-height: 1.3;
  color: var(--hb-fg-muted);
}

label.lbl {
  cursor: pointer;
}

.ctrl {
  flex: 0 0 auto;
  width: var(--cw);
  min-width: 0;
}

.stacked {
  display: block;
}

.stacked .lbl {
  display: block;
  margin-bottom: var(--hb-space-1);
}

.stacked .ctrl {
  width: 100%;
}
</style>
