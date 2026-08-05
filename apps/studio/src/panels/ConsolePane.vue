<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useLog } from "../stores/log";
import { useLink } from "../stores/link";

/**
 * The raw protocol trace, not a friendly summary.
 *
 * This is the escape hatch when something is wrong, and it is also where you type a
 * command the UI does not expose. Both original tools kept one and both were right
 * to: the moment a board behaves oddly, the only useful view is what actually went
 * over the wire.
 */
const log = useLog();
const link = useLink();
const open = ref(false);
const cmd = ref("");
const box = ref<HTMLDivElement | null>(null);

watch(
  () => log.lines.length,
  async () => {
    await nextTick();
    if (box.value) box.value.scrollTop = box.value.scrollHeight;
  },
);

async function send() {
  const line = cmd.value.trim();
  if (!line) return;
  cmd.value = "";
  const s = await import("../session");
  await s.sendRaw(line);
}
</script>

<template>
  <section class="hb-console" :class="{ open }">
    <header @click="open = !open">
      <span>console</span>
      <span class="count">{{ log.lines.length }}</span>
      <span class="chev">{{ open ? "-" : "+" }}</span>
    </header>
    <div v-if="open" class="wrap">
      <div ref="box" class="hb-log">
        <div v-for="l in log.lines" :key="l.id" :class="['ln', l.level]">
          <span class="pre">{{ l.level === "tx" ? ">" : l.level === "rx" ? "<" : "-" }}</span>{{ l.text }}<span
            v-if="link.simulated && l.level === 'tx'"
            class="simtag"
          >[sim]</span>
        </div>
      </div>
      <div class="entry">
        <input v-model="cmd" placeholder="type a command" @keydown.enter="send" />
        <button @click="send">send</button>
        <button @click="log.clear()">clear</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hb-console { flex: none; }
header {
  display: flex; align-items: center; gap: 10px; padding: 3px 10px; cursor: pointer;
  border-bottom: 1px solid var(--hb-dim-line-2);
  font-family: var(--hb-mono); font-weight: 700; font-size: 9px; letter-spacing: .2em; color: #7d7770;
}
.count { font-family: var(--hb-term); font-size: 15px; letter-spacing: 0; color: var(--hb-dim); }
.chev { margin-left: auto; }
.hb-log { max-height: 168px; }
.ln { white-space: pre-wrap; word-break: break-word; }
.ln.tx { color: var(--hb-pink); }
.ln.rx { color: var(--hb-dim); }
.ln.err { color: var(--hb-danger); }
.ln.sys { color: var(--hb-paper); }
.ln.sim { color: #6a645d; }
.pre { color: #5a554f; margin-right: 6px; }
.simtag { color: #5a554f; margin-left: 8px; }
.entry { display: flex; gap: 6px; padding: 6px 10px; border-top: 1px solid var(--hb-dim-line-2); }
.entry input {
  flex: 1; background: var(--hb-ink-2); color: var(--hb-paper); border: 2px solid #3a3733;
  font: 15px/1 var(--hb-term); padding: 3px 7px; width: auto;
}
.entry input:focus { border-color: var(--hb-pink); box-shadow: none; }
.entry button { background: transparent; border: 2px solid #3a3733; color: var(--hb-dim); box-shadow: none; padding: 2px 9px; }
</style>
