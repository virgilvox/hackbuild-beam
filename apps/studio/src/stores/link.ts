import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { selectProfile, type MachineProfile } from "@virgilvox/beam-core";
import { useMachine } from "./machine";
import { useLog } from "./log";

export type LinkKind = "none" | "serial" | "ble" | "sim";
export type LinkState = "disconnected" | "classifying" | "unknown" | "ready";

/**
 * The connection, and the one rule that makes connecting safe.
 *
 * Nothing is written to a board until it has been classified. The two text
 * vocabularies collide destructively: the stepper firmware dispatches on the first
 * character of the line, so the servo tool's `ECHO 0` arrives as command E with an
 * argument of zero and releases both coil sets, and `M 1500 1500 0` is a millimetre
 * move on that board, which is an unclamped full travel slam.
 *
 * So: send `?`, which is the status command in both protocols and cannot open a
 * binary frame, and wait. The case of the reply's first token is the discriminator,
 * uppercase for the servo lineage and lowercase for the stepper one, and both
 * shipped apps already match it case sensitively.
 */
export const useLink = defineStore("link", () => {
  const kind = ref<LinkKind>("none");
  const state = ref<LinkState>("disconnected");
  const lineage = ref<"pulse" | "step" | null>(null);
  const legacy = ref(false);
  const hello = ref("");
  const transport = shallowRef<unknown>(null);
  const device = shallowRef<unknown>(null);

  const connected = computed(() => state.value === "ready");
  const simulated = computed(() => kind.value === "sim");

  const machine = useMachine();
  const log = useLog();

  /**
   * Simulator mode: no board, so the profile is chosen rather than discovered. This
   * is the only place a human picks the machine, and it is honest because there is
   * nothing to ask.
   */
  function startSimulator(profileId: string) {
    kind.value = "sim";
    state.value = "ready";
    lineage.value = profileId === "washer-servo" ? "pulse" : "step";
    legacy.value = false;
    hello.value = `simulated ${profileId}`;
    machine.rebuildProfile(profileId);
    machine.adopted = true;
    log.sys(`simulator: ${profileId}. Nothing is connected and no beam will fire.`);
  }

  function disconnect() {
    kind.value = "none";
    state.value = "disconnected";
    lineage.value = null;
    hello.value = "";
    transport.value = null;
    device.value = null;
    machine.adopted = false;
    log.sys("disconnected");
  }

  /** Classify a status line into a lineage and pick the profile from it. */
  function classifyFrom(line: string, config: Record<string, string>): MachineProfile | null {
    if (/^STAT /.test(line)) lineage.value = "pulse";
    else if (/^st /.test(line)) lineage.value = "step";
    else return null;

    legacy.value = !/\bproto=/.test(line);

    const match = selectProfile(hello.value || line, config);
    if (!match.ok) {
      /* Ambiguous or unknown. Do not guess: a wrong profile aims a live beam through
       * the wrong map. Stay read only and say so. */
      state.value = "unknown";
      log.err(
        match.reason === "ambiguous"
          ? `more than one profile claims this board: ${match.candidates.join(", ")}. Staying read only.`
          : "this board did not match a known machine. Staying read only.",
      );
      return null;
    }
    machine.setProfile(match.profile);
    state.value = "ready";
    return match.profile;
  }

  return {
    kind, state, lineage, legacy, hello, transport, device,
    connected, simulated,
    startSimulator, disconnect, classifyFrom,
  };
});
