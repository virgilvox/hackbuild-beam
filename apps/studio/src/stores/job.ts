import { defineStore } from "pinia";
import { computed, ref } from "vue";

export type RunState = "idle" | "planning" | "running" | "paused" | "stopping";

/**
 * The run. Deliberately small: the SDK owns the streaming, the credit window and
 * every safety behavior, so this is only what the operator sees.
 */
export const useJob = defineStore("job", () => {
  const state = ref<RunState>("idle");
  const sent = ref(0);
  const total = ref(0);
  /** Live tempo override. Scales the timeline, not the wire duration. */
  const speed = ref(1);
  const dryRun = ref(false);
  const framing = ref(false);
  const startedAt = ref(0);
  const etaSec = ref(0);

  const running = computed(() => state.value === "running" || state.value === "paused");
  const progress = computed(() => (total.value ? sent.value / total.value : 0));

  function begin(n: number) {
    state.value = "running";
    sent.value = 0;
    total.value = n;
    startedAt.value = Date.now();
  }
  function finish() {
    state.value = "idle";
    sent.value = 0;
    total.value = 0;
    framing.value = false;
  }

  return { state, sent, total, speed, dryRun, framing, startedAt, etaSec, running, progress, begin, finish };
});
