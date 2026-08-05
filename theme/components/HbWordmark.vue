<script setup lang="ts">
/*
 * "hack" then a pink dot then "build". The dot is the whole mark: it is the only
 * accent in the system and it is the thing that survives being printed on a
 * sticker at 8mm. It is a real span rather than a period glyph so its colour and
 * size are ours and not the font's.
 *
 * The BEAM lockup is the same mark with the product name carrying the display
 * face and hack.build dropped to a subline, which is how the two original tools
 * badged themselves in their headers.
 */
withDefaults(
  defineProps<{
    variant?: "hackbuild" | "beam";
    size?: "sm" | "md" | "lg";
    /** Shown after the product name in the beam lockup. The active machine, usually. */
    sub?: string;
  }>(),
  { variant: "hackbuild", size: "md", sub: "" },
);
</script>

<template>
  <div class="hb-wordmark" :class="[`v-${variant}`, `s-${size}`]">
    <template v-if="variant === 'beam'">
      <span class="product">BEAM<span class="dot">.</span></span>
      <span class="lockup">hack<span class="dot">.</span>build</span>
      <span v-if="sub" class="sub">{{ sub }}</span>
    </template>
    <template v-else>
      <span class="mark">hack<span class="dot">.</span>build</span>
      <span v-if="sub" class="sub">{{ sub }}</span>
    </template>
  </div>
</template>

<style scoped>
.hb-wordmark {
  display: inline-flex;
  align-items: baseline;
  gap: var(--hb-space-2);
  line-height: 1;
  user-select: none;
}

.mark,
.product {
  font-family: var(--hb-font-display);
  color: var(--hb-fg);
  letter-spacing: 0.02em;
  line-height: 1;
}

/* The dot is set solid, never inherited, so it holds in both schemes. */
.dot {
  color: var(--hb-pink);
}

/*
 * In the beam lockup the product name takes the display face and the house mark
 * drops to small mono, so the two never compete for the same read.
 */
.v-beam .lockup {
  font-family: var(--hb-font-mono);
  font-weight: 700;
  font-size: var(--hb-text-xs);
  letter-spacing: 0.02em;
  color: var(--hb-fg-muted);
}

.sub {
  font-family: var(--hb-font-terminal);
  font-size: var(--hb-text-lg);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--hb-fg-faint);
}

.s-sm .mark,
.s-sm .product {
  font-size: 15px;
}
.s-md .mark,
.s-md .product {
  font-size: 21px;
}
.s-lg .mark,
.s-lg .product {
  font-size: 28px;
}

.s-sm .sub {
  font-size: var(--hb-text-md);
}
</style>
