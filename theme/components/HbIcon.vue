<script setup lang="ts">
/*
 * Inline SVG, one weight, 24 unit grid. See icons.ts for why this is not a webfont.
 *
 * An icon with no title is decorative and is hidden from assistive tech, because
 * every icon in this set sits next to a real text label. An icon that genuinely
 * carries meaning on its own passes `title` and becomes an image with a name.
 */
import { computed } from "vue";
import { HB_ICONS, type HbIconName } from "./icons";

const props = withDefaults(
  defineProps<{
    name: HbIconName;
    /** Number is px. A string passes through, so `1em` tracks the text it sits in. */
    size?: number | string;
    title?: string;
  }>(),
  { size: 14, title: "" },
);

const shapes = computed(() => HB_ICONS[props.name]);
const dim = computed(() => (typeof props.size === "number" ? `${props.size}px` : props.size));
</script>

<template>
  <svg
    class="hb-icon"
    viewBox="0 0 24 24"
    :width="dim"
    :height="dim"
    :role="title ? 'img' : undefined"
    :aria-hidden="title ? undefined : 'true'"
    :aria-label="title || undefined"
    focusable="false"
  >
    <title v-if="title">{{ title }}</title>
    <path
      v-for="(s, i) in shapes"
      :key="i"
      :d="s.d"
      :fill="'fill' in s && s.fill ? 'currentColor' : 'none'"
      :stroke="'fill' in s && s.fill ? 'none' : 'currentColor'"
      stroke-width="2"
      stroke-linecap="square"
      stroke-linejoin="miter"
    />
  </svg>
</template>

<style scoped>
.hb-icon {
  display: inline-block;
  flex: 0 0 auto;
  vertical-align: -0.14em;
  color: inherit;
}
</style>
