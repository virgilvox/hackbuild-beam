import { defineStore } from "pinia";
import { ref } from "vue";

export type LogLevel = "tx" | "rx" | "err" | "sys" | "sim";

export interface LogLine {
  id: number;
  level: LogLevel;
  text: string;
  at: number;
}

/**
 * The console. It is the escape hatch when something is wrong, so it keeps the raw
 * protocol trace rather than a friendly summary.
 *
 * Capped, because a plot is thousands of lines and an unbounded log turns the tab
 * into a memory leak halfway through a job.
 */
export const useLog = defineStore("log", () => {
  const lines = ref<LogLine[]>([]);
  const cap = 400;
  let seq = 0;

  function push(level: LogLevel, text: string) {
    lines.value.push({ id: seq++, level, text, at: Date.now() });
    if (lines.value.length > cap) lines.value.splice(0, lines.value.length - cap);
  }

  const tx = (t: string) => push("tx", t);
  const rx = (t: string) => push("rx", t);
  const err = (t: string) => push("err", t);
  const sys = (t: string) => push("sys", t);
  const sim = (t: string) => push("sim", t);
  const clear = () => { lines.value = []; };

  return { lines, push, tx, rx, err, sys, sim, clear };
});
