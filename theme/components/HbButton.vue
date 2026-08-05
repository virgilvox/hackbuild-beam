<script setup lang="ts">
/*
 * A real <button>, always. Both original tools used real buttons and got keyboard
 * and focus for free; a div with a click handler in a laser UI is a stop control
 * that cannot be reached without a mouse.
 *
 * The press is the house gesture: the control translates by exactly the shadow
 * offset and the shadow goes to zero, so the thing physically goes down onto the
 * page instead of animating. One variable, `--o`, is both the shadow offset and
 * the translate, so they can never drift apart.
 */
import HbIcon from "./HbIcon.vue";
import type { HbIconName } from "./icons";

withDefaults(
  defineProps<{
    variant?: "default" | "primary" | "danger" | "ghost";
    size?: "sm" | "md" | "lg";
    block?: boolean;
    disabled?: boolean;
    /** Latched look, for a control that is currently engaged. Needs `toggle`. */
    pressed?: boolean;
    /** Marks the button as a two state control, so `pressed` is announced. */
    toggle?: boolean;
    icon?: HbIconName | "";
    /** Icon after the label rather than before it. */
    iconEnd?: boolean;
    type?: "button" | "submit" | "reset";
    title?: string;
  }>(),
  {
    variant: "default",
    size: "md",
    block: false,
    disabled: false,
    pressed: false,
    toggle: false,
    icon: "",
    iconEnd: false,
    type: "button",
    title: "",
  },
);

const emit = defineEmits<{
  (e: "click", ev: MouseEvent): void;
}>();
</script>

<template>
  <button
    class="hb-btn"
    :class="[`v-${variant}`, `s-${size}`, { block, 'is-pressed': toggle && pressed }]"
    :type="type"
    :disabled="disabled"
    :aria-pressed="toggle ? (pressed ? 'true' : 'false') : undefined"
    :title="title || undefined"
    @click="emit('click', $event)"
  >
    <HbIcon v-if="icon && !iconEnd" :name="icon" size="1em" />
    <span class="lbl"><slot /></span>
    <HbIcon v-if="icon && iconEnd" :name="icon" size="1em" />
  </button>
</template>

<style scoped>
.hb-btn {
  --o: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--hb-space-2);
  font-family: var(--hb-font-mono);
  font-weight: 700;
  font-size: var(--hb-text-sm);
  letter-spacing: 0.11em;
  text-transform: uppercase;
  line-height: 1;
  padding: 8px 11px;
  background: var(--hb-bg-raised);
  color: var(--hb-fg);
  border: var(--hb-border);
  border-color: var(--hb-fg);
  border-radius: var(--hb-radius);
  box-shadow: var(--o) var(--o) 0 0 var(--hb-shadow-color);
  cursor: pointer;
  /* Only the press moves. No blur, no easing curve worth naming. */
  transition:
    transform 0.06s linear,
    box-shadow 0.06s linear;
}

/*
 * In the ink scheme a black shadow on a black page is not a shadow. The rule
 * colour is the one token that is legible against both surfaces, so it carries
 * the offset there.
 */
[data-scheme="ink"] .hb-btn {
  box-shadow: var(--o) var(--o) 0 0 var(--hb-rule);
}

.hb-btn .lbl {
  min-width: 0;
}

.hb-btn:focus-visible {
  outline: 3px solid var(--hb-pink);
  outline-offset: 2px;
}

.hb-btn:hover:not(:disabled) {
  background: var(--hb-pink);
  color: var(--hb-paper);
  border-color: var(--hb-pink);
}

.hb-btn:active:not(:disabled),
.hb-btn.is-pressed:not(:disabled) {
  transform: translate(var(--o), var(--o));
  box-shadow: 0 0 0 0 var(--hb-shadow-color);
}

.hb-btn.is-pressed:not(:disabled) {
  background: var(--hb-pink);
  color: var(--hb-paper);
  border-color: var(--hb-pink);
}

.hb-btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
  box-shadow: none;
}

/* ------------------------------------------------------------- variants -- */

.v-primary {
  background: var(--hb-pink);
  color: var(--hb-paper);
}
.v-primary:hover:not(:disabled) {
  background: var(--hb-fg);
  color: var(--hb-bg);
  border-color: var(--hb-fg);
}

/*
 * Danger is its own colour and not the accent. The accent is on every third
 * control in this app; a stop that looks like every other control is a stop the
 * operator has to read before pressing.
 */
.v-danger {
  background: var(--hb-danger);
  color: var(--hb-ink);
  border-color: var(--hb-ink);
}
.v-danger:hover:not(:disabled) {
  background: var(--hb-ink);
  color: var(--hb-danger);
  border-color: var(--hb-danger);
}

.v-ghost {
  background: transparent;
  color: var(--hb-fg-muted);
  border-color: transparent;
  box-shadow: none;
}
[data-scheme="ink"] .v-ghost {
  box-shadow: none;
}
.v-ghost:hover:not(:disabled) {
  background: transparent;
  color: var(--hb-pink);
  border-color: transparent;
}
.v-ghost:active:not(:disabled),
.v-ghost.is-pressed:not(:disabled) {
  background: transparent;
  color: var(--hb-pink);
  border-color: transparent;
  box-shadow: none;
}

/* ---------------------------------------------------------------- sizes -- */

.s-sm {
  --o: 2px;
  font-size: var(--hb-text-xs);
  padding: 5px 8px;
  gap: var(--hb-space-1);
}

.s-lg {
  --o: 4px;
  font-size: var(--hb-text-md);
  padding: 12px 16px;
}

.block {
  display: flex;
  width: 100%;
}
</style>
