<script setup lang="ts">
/*
 * The bar across the top: brand, then whatever status the app wants, then the
 * actions that must be reachable from anywhere.
 *
 * It is ink in both schemes with a pink underline. That is deliberate: the header
 * is the one strip that has to look identical on a lit bench and in a dark room,
 * because it carries link state and the stop, and an operator should not have to
 * re-learn where those are when the scheme changes.
 *
 * Chips and actions are slots. The bar has no idea what a link or a beam is.
 */
import HbWordmark from "./HbWordmark.vue";

const props = withDefaults(
  defineProps<{
    variant?: "hackbuild" | "beam";
    /** Small uppercase line after the mark. The active machine, usually. */
    sub?: string;
  }>(),
  { variant: "beam", sub: "" },
);
</script>

<template>
  <header class="hb-header">
    <div class="brand">
      <slot name="brand">
        <!-- Through `props` so withDefaults' defaults narrow. See HbConsole. -->
        <HbWordmark :variant="props.variant" :sub="props.sub" />
      </slot>
    </div>

    <div class="chips">
      <slot name="chips" />
    </div>

    <div class="spacer"></div>

    <div class="actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
/*
 * The bar pins its own scheme to ink rather than following the page, so the
 * tokens below resolve against a dark surface in both schemes.
 */
.hb-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--hb-space-3);
  min-height: var(--hb-header-h);
  padding: var(--hb-space-2) var(--hb-space-4);
  background: var(--hb-ink-2);
  border-bottom: var(--hb-border-thick);

  --hb-bg: var(--hb-ink-2);
  --hb-bg-raised: var(--hb-ink);
  --hb-bg-sunken: #000;
  --hb-fg: var(--hb-paper);
  --hb-fg-muted: rgba(245, 240, 230, 0.62);
  --hb-fg-faint: rgba(245, 240, 230, 0.38);
  --hb-rule: rgba(245, 240, 230, 0.24);
  /* A black block shadow on a black bar is not a shadow. The same value the rule
   * uses is the one that stays visible against this surface in both schemes. */
  --hb-shadow-color: rgba(245, 240, 230, 0.24);

  color: var(--hb-fg);
}

.brand,
.chips,
.actions {
  display: flex;
  align-items: center;
  gap: var(--hb-space-2);
  flex-wrap: wrap;
  min-width: 0;
}

.chips {
  gap: var(--hb-space-2);
}

.spacer {
  flex: 1 1 auto;
}

@media (max-width: 720px) {
  .hb-header {
    gap: var(--hb-space-2);
  }

  .spacer {
    flex-basis: 100%;
  }

  .actions {
    width: 100%;
  }
}
</style>
