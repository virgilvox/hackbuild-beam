<script setup lang="ts">
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import ConnectScreen from "./panels/ConnectScreen.vue";
import GuidePanel from "./panels/GuidePanel.vue";
import MachineColumn from "./panels/MachineColumn.vue";
import JobColumn from "./panels/JobColumn.vue";
import TargetCanvas from "./canvas/TargetCanvas.vue";
import ScannerCanvas from "./canvas/ScannerCanvas.vue";
import PhosphorCanvas from "./canvas/PhosphorCanvas.vue";
import ConsolePane from "./panels/ConsolePane.vue";
import RunDock from "./panels/RunDock.vue";
import HbMark from "@theme/components/HbMark.vue";
import { useLink } from "./stores/link";
import { useMachine } from "./stores/machine";
import { useJob } from "./stores/job";
import { useLog } from "./stores/log";
import { useProject } from "./stores/project";
import type { SetupState } from "./guidance";
import type { Point } from "@virgilvox/beam-core";

/*
 * One app, two machines, and the machine decides the app.
 *
 * Panels appear because the connected rig has that capability, not because the user
 * chose a mode. A servo head shows dither and a pulse window; a stepper shows
 * backlash and coil release. Whole panels gate, never individual controls inside
 * one, because a half populated panel reads as a bug.
 */
const link = useLink();
const machine = useMachine();
const job = useJob();
const log = useLog();
const project = useProject();

const { connected, simulated, state: linkState } = storeToRefs(link);
const { profile } = storeToRefs(machine);

const busy = ref(false);
const connectError = ref<string | null>(null);
const focusPanel = ref<string | null>(null);
/* Paper by default. That is what both shipped tools look like and what the design
 * language was built for; ink is there for a dark room. */
const scheme = ref<"paper" | "ink">("paper");

/*
 * Which view of the machine you are looking at.
 *
 * The two views answer different questions and the shipped tools each had only one
 * of them. The target plane tells you what will be on the wall; the scanner tells
 * you where the rig is pointing and whether the geometry you typed in matches the
 * thing bolted to the bench. Side by side is how you catch a rig aimed somewhere the
 * drawing says it is not, which is a mistake that otherwise costs a whole session.
 */
type ViewMode = "2d" | "3d" | "both";
const view = ref<ViewMode>("2d");

/* The phosphor trail is the target plane with a memory: it shows where the beam has
 * dwelt rather than only where it went, which is the difference between a plot and a
 * burn. It belongs to the 2D view, so it is a toggle rather than a fourth tab. */
const glow = ref(false);

/** What the guide needs to know to decide what you have already done. */
const setupState = computed<SetupState>(() => ({
  connected: connected.value,
  adopted: machine.adopted,
  invertChecked: machine.invertChecked,
  cornersCaptured: machine.cornersCaptured,
  mappingSolved: machine.mappingSolved,
  residualMm: machine.residualMm,
  limitsDerived: machine.limitsDerived,
  limitsOn: machine.limitsOn,
  persisted: machine.persisted,
  originSet: machine.originSet,
  hasContent: project.strokes.length > 0,
  planned: project.planned,
}));

const beamLive = computed<Point | null>(() =>
  profile.value ? profile.value.forward(machine.axis, machine.activeCal) : null,
);

async function connectSerial() {
  busy.value = true;
  connectError.value = null;
  try {
    const { connectSerialDevice } = await import("./session");
    await connectSerialDevice();
  } catch (e) {
    connectError.value = e instanceof Error ? e.message : String(e);
    log.err(connectError.value);
  } finally {
    busy.value = false;
  }
}

async function connectBle() {
  busy.value = true;
  connectError.value = null;
  try {
    const { connectBleDevice } = await import("./session");
    await connectBleDevice();
  } catch (e) {
    connectError.value = e instanceof Error ? e.message : String(e);
    log.err(connectError.value);
  } finally {
    busy.value = false;
  }
}

function simulate(profileId: string) {
  link.startSimulator(profileId);
  project.rebuild();
}

function goto(panel: string) {
  focusPanel.value = panel;
  document.getElementById(`panel-${panel}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => (focusPanel.value = null), 1600);
}

/* The one control that is never hidden behind a tab or a scroll. */
async function estop() {
  const { emergencyStop } = await import("./session");
  await emergencyStop();
}

/*
 * Pointer to beam.
 *
 * In direct mode the canvas drives the machine and nothing else: no sketch is
 * accumulated and no replan is triggered. Every other source keeps the sketching
 * behaviour, so the one canvas serves both without a mode flag reaching into it.
 *
 * Deliberately fire and forget. A drag emits points faster than a board can answer,
 * and awaiting each one would queue a backlog that keeps moving the beam long after
 * the pointer has stopped.
 */
async function onCanvasAim(p: Point) {
  if (project.source !== "direct") return project.onAim(p);
  const { aimAt } = await import("./session");
  void aimAt(p);
}

async function onCanvasDraw(p: Point) {
  if (project.source !== "direct") return project.onDraw(p);
  const { aimAt } = await import("./session");
  void aimAt(p);
}
</script>

<template>
  <ConnectScreen
    v-if="!connected && linkState !== 'unknown'"
    :busy="busy"
    :error="connectError"
    @serial="connectSerial"
    @ble="connectBle"
    @simulate="simulate"
  />

  <div v-else class="app" :data-scheme="scheme">
    <header class="bar">
      <HbMark class="mark" />
      <span class="brand">BEAM<i>.</i></span>
      <span class="wordmark">hack<b>.build</b></span>

      <span class="hb-chip"><i class="hb-dot" :class="{ on: connected }"></i>
        <b>{{ simulated ? "SIM" : link.kind.toUpperCase() }}</b>
      </span>
      <span class="hb-chip machine"><b>{{ profile?.label ?? "unknown machine" }}</b></span>
      <span class="hb-chip"><i class="hb-dot" :class="{ hot: machine.beamOn }"></i>
        BEAM <b>{{ machine.beamOn ? "ON" : "off" }}</b>
      </span>
      <span v-if="machine.queueFree >= 0" class="hb-chip">Q <b>{{ machine.queueFree }}</b></span>

      <span class="spacer"></span>

      <button class="hdrbtn" @click="scheme = scheme === 'ink' ? 'paper' : 'ink'">
        {{ scheme === "ink" ? "paper" : "ink" }}
      </button>
      <button class="hdrbtn" @click="link.disconnect()">disconnect</button>
      <button class="hb-danger estop" @click="estop">stop the beam</button>
    </header>

    <main>
      <aside class="col machine hb-scroll" :class="{ focus: focusPanel === 'link' }">
        <GuidePanel :profile="profile" :state="setupState" @goto="goto" />
        <MachineColumn :focus="focusPanel" />
      </aside>

      <section class="stage">
        <div class="viewtabs">
          <div class="tabs" role="tablist" aria-label="viewer">
            <button
              v-for="m in (['2d', '3d', 'both'] as const)"
              :key="m"
              role="tab"
              :aria-selected="view === m"
              :class="{ act: view === m }"
              @click="view = m"
            >
              {{ m === "2d" ? "target" : m === "3d" ? "scanner" : "both" }}
            </button>
          </div>
          <label v-if="view !== '3d'" class="glow">
            <input v-model="glow" type="checkbox" />
            glow trail
          </label>
        </div>

        <div class="views" :class="view">
          <TargetCanvas
            v-if="view !== '3d' && !glow"
            :profile="profile"
            :field-w="machine.fieldW"
            :field-h="machine.fieldH"
            :strokes="project.strokes"
            :simulated="project.simulated"
            :live="beamLive"
            :beam-on="machine.beamOn"
            :corners="machine.corners"
            :show-lattice="project.showLattice"
            :show-ideal="project.showIdeal"
            :clipped="project.clipped"
            @aim="onCanvasAim"
            @draw="onCanvasDraw"
            @draw-end="project.onDrawEnd"
          />

          <PhosphorCanvas
            v-if="view !== '3d' && glow"
            :simulated="project.simulated"
            :live="beamLive"
            :beam-on="machine.beamOn"
            :field-w="machine.fieldW"
            :field-h="machine.fieldH"
            :running="job.running"
          />

          <ScannerCanvas
            v-if="view !== '2d'"
            :profile="profile"
            :live="machine.axis"
            :beam-on="machine.beamOn"
            :simulated="project.simulated"
            :field-w="machine.fieldW"
            :field-h="machine.fieldH"
            :cal="machine.activeCal"
          />
        </div>

        <RunDock />
        <ConsolePane />
      </section>

      <aside class="col job hb-scroll">
        <JobColumn :focus="focusPanel" />
      </aside>
    </main>

    <footer class="status">
      <span>state <b>{{ job.state }}</b></span>
      <span>link <b>{{ link.kind }}</b></span>
      <span :class="{ danger: machine.beamOn }">beam <b>{{ machine.beamOn ? "ARMED" : "off" }}</b></span>
      <span>points <b>{{ project.commandCount }}</b></span>
      <span class="grow">{{ project.health }}</span>
    </footer>
  </div>
</template>

<style scoped>
/*
 * Paper and ink, letterpress. The page is cream; the header, the viewport and the
 * console invert to near black because those are the instrument surfaces and the
 * contrast is what tells you which parts of the screen are the machine.
 */
.app { display: flex; flex-direction: column; height: 100vh; background: var(--hb-bg); color: var(--hb-fg); }

.bar {
  display: flex; align-items: center; gap: 11px; padding: 0 12px; height: var(--hb-header-h);
  flex: none; background: var(--hb-ink); border-bottom: 3px solid var(--hb-pink);
  color: var(--hb-paper); flex-wrap: wrap;
}
.mark { color: var(--hb-paper); }
.brand {
  font-family: var(--hb-marker); font-size: 21px; letter-spacing: .05em; line-height: 1;
  color: var(--hb-paper);
}
.brand i { color: var(--hb-pink); font-style: normal; }
.wordmark {
  font-family: var(--hb-mono); font-weight: 700; font-size: 10px; letter-spacing: .02em;
  color: var(--hb-paper); opacity: .55; margin-left: -4px;
}
.wordmark b { color: var(--hb-pink); font-weight: 700; }
.hb-chip.machine b { color: var(--hb-paper); font-size: 13px; }
.spacer { flex: 1; }
.hdrbtn {
  background: transparent; border: 2px solid #3a3733; color: var(--hb-dim);
  box-shadow: none; padding: 4px 10px;
}
.estop { box-shadow: 3px 3px 0 0 #000; }

main { flex: 1; display: grid; grid-template-columns: var(--hb-aside-w) minmax(0, 1fr) 316px; min-height: 0; }
.col { overflow-y: auto; overflow-x: hidden; min-width: 0; background: var(--hb-bg); }
.col.machine { border-right: 2px solid var(--hb-rule); }
.col.job { border-left: 2px solid var(--hb-rule); }
.col.focus { box-shadow: inset 0 0 0 2px var(--hb-pink); }

/* The stage sits a shade darker so the viewport reads as mounted on it. */
.stage {
  display: grid; grid-template-rows: auto minmax(240px, 1fr) auto auto; gap: 12px; padding: 12px;
  min-height: 0; min-width: 0; background: var(--hb-bg-sunken);
}

.viewtabs { display: flex; align-items: center; gap: 12px; }
.tabs { display: flex; gap: 0; }
.tabs button {
  background: var(--hb-bg-raised); border: 2px solid var(--hb-rule); border-right-width: 0;
  box-shadow: none; padding: 5px 16px;
}
.tabs button:last-child { border-right-width: 2px; }
.tabs button.act { background: var(--hb-ink); color: var(--hb-paper); border-color: var(--hb-ink); }
.tabs button.act:hover { background: var(--hb-ink); }
.glow {
  display: inline-flex; align-items: center; gap: 6px; font-family: var(--hb-mono);
  font-weight: 700; font-size: 9px; letter-spacing: .11em; text-transform: uppercase;
  color: var(--hb-fg-muted);
}

/* Both views share the row. Side by side while there is width for it, stacked when
   there is not, because two half width viewports are worse than one of each. */
.views { display: grid; gap: 12px; min-height: 0; min-width: 0; }
.views.both { grid-template-columns: 1fr 1fr; }
@media (max-width: 1180px) {
  .views.both { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
}

.status {
  display: flex; gap: 0; flex: none; align-items: stretch;
  border-top: 2px solid var(--hb-rule); background: var(--hb-ink); color: var(--hb-dim);
  font-family: var(--hb-mono); font-size: 9px; font-weight: 700; letter-spacing: .18em;
}
.status span { padding: 5px 12px; border-right: 1px solid var(--hb-dim-line-2); display: flex; gap: 7px; align-items: center; }
.status b { color: var(--hb-paper); font-weight: 400; font-family: var(--hb-term); font-size: 14px; letter-spacing: 0; }
/* An armed beam is a safety state, so it gets the one piece of solid colour on the
   bar and nothing else is allowed to compete with it. */
.status .danger { background: var(--hb-pink); color: var(--hb-paper); }
.status .danger b { color: var(--hb-paper); }
.grow { flex: 1; justify-content: flex-end; border-right: none; letter-spacing: .02em; font-weight: 400; }

@media (max-width: 1080px) {
  /* The machine column folds under the viewport before the job column does, because
     setup is the thing you finish and walk away from while the job column stays in
     use. Once anything is stacked the page scrolls and the columns stop scrolling
     inside themselves: two nested scrollers with no room is unreachable content. */
  .app { height: auto; min-height: 100vh; }
  main { grid-template-columns: minmax(0, 1fr) 316px; min-height: 0; }
  .col { overflow: visible; max-height: none; }
  .stage { grid-row: 1; grid-column: 1; min-height: 58vh; }
  .col.job { grid-row: 1; grid-column: 2; }
  .col.machine { grid-column: 1 / -1; grid-row: 2; border-right: none; border-top: 2px solid var(--hb-rule); }
}
@media (max-width: 940px) {
  main { grid-template-columns: minmax(0, 1fr); }
  .stage { grid-row: 1; grid-column: 1; min-height: 54vh; }
  .col.job { grid-row: 2; grid-column: 1; border-left: none; border-top: 2px solid var(--hb-rule); }
  .col.machine { grid-row: 3; grid-column: 1; }
  .bar { height: auto; padding: 8px 12px; gap: 8px; }
}
</style>
