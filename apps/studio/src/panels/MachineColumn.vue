<script setup lang="ts">
import { computed, ref } from "vue";
import { SERVO_PRESETS } from "@virgilvox/beam-core";
import { useMachine } from "../stores/machine";
import { useLink } from "../stores/link";
import { useLog } from "../stores/log";

/**
 * The machine column: everything about the rig rather than the job.
 *
 * Every group here is gated on a capability the connected machine actually has.
 * That gating is the whole reason this is one app: a servo head has a pulse window
 * and dither and no backlash compensation, a stepper has backlash and coil release
 * and a pull-out rate, and neither wants to look at the other's controls.
 *
 * Whole groups gate, never individual controls inside a group. A half populated
 * panel reads as a bug.
 */
defineProps<{ focus: string | null }>();

const m = useMachine();
const link = useLink();
const log = useLog();

const caps = computed(() => m.caps);

/** The presets the actuator model knows how to simulate, for the picker. */
const servoChoices = computed(() =>
  Object.entries(SERVO_PRESETS).map(([id, p]) => ({ id, label: p.label })),
);

/**
 * One deadband, in millimetres on the target.
 *
 * The single number that explains this rig's behaviour, and it is not on the
 * datasheet: a deadband is microseconds of pulse, and what it costs you depends on
 * the throw. Showing the microseconds alone would be showing the input to the
 * calculation nobody wants to do.
 */
const deadbandMm = computed(() => {
  const p = SERVO_PRESETS[m.servo];
  if (!p || !caps.value?.pulseWindow) return null;
  /* Same conversion the profile uses: the pulse window spans the servo's travel. */
  const degPerUs = 180 / 2000;
  return m.throwMm * Math.tan((p.deadband * degPerUs * Math.PI) / 180);
});
const unit = computed(() => m.axisUnit);
const jogStep = ref(10);

async function send(fn: string, ...args: unknown[]) {
  const s = await import("../session");
  const f = (s as unknown as Record<string, (...a: unknown[]) => Promise<void>>)[fn];
  if (f) await f(...args);
}

function jog(da: number, db: number) {
  void send("jog", da * jogStep.value, db * jogStep.value);
}
function capture(i: number) {
  m.captureCorner(i);
  log.sys(`captured corner ${["TL", "TR", "BR", "BL"][i]}`);
}
function solve() {
  const r = m.solve();
  (r.ok ? log.sys : log.err)(r.message);
}

/* The +/- on every heading promised collapsing and did nothing. Groups you have
   finished with should get out of the way, which is the whole reason the shipped
   tools made them collapsible. */
const collapsed = ref<Record<string, boolean>>({});
function toggleGrp(id: string) {
  collapsed.value = { ...collapsed.value, [id]: !collapsed.value[id] };
}
</script>

<template>
  <div>
    <!-- Jog and origin. Every machine has this. -->
    <section id="panel-jog" class="hb-grp" :class="{ focus: focus === 'jog' , collapsed: collapsed['position'] }">
      <h3 @click="toggleGrp('position')">position</h3>
      <div class="hb-body">
        <div class="jog">
          <button class="up" @click="jog(0, 1)">up</button>
          <button class="left" @click="jog(-1, 0)">left</button>
          <button class="mid hb-pri" @click="send('setOrigin')">zero</button>
          <button class="right" @click="jog(1, 0)">right</button>
          <button class="down" @click="jog(0, -1)">down</button>
        </div>
        <label class="hb-row">
          step
          <input v-model.number="jogStep" type="number" min="1" step="1" />
          <span class="unit">{{ unit }}</span>
        </label>
        <div class="hb-kv"><span>at</span><b>{{ m.axis.a }}, {{ m.axis.b }} {{ unit }}</b></div>
        <div class="hb-btnrow">
          <button @click="send('goHome')">go to origin</button>
          <button :class="m.beamOn ? 'hb-act' : ''" @click="send('toggleBeam')">
            beam {{ m.beamOn ? "off" : "on" }}
          </button>
        </div>
        <p class="hb-note">
          There are no limit switches. Home is wherever you say it is, so zero somewhere you can
          find again.
        </p>
      </div>
    </section>

    <!-- Four corners. Both rigs offer it; the stepper needs it, the servo benefits. -->
    <section v-if="caps?.corners" id="panel-corners" class="hb-grp" :class="{ focus: focus === 'corners' , collapsed: collapsed['four corners'] }">
      <h3 @click="toggleGrp('four corners')">four corners</h3>
      <div class="hb-body">
        <div class="cgrid">
          <button v-for="(lbl, i) in ['TL', 'TR']" :key="lbl" :class="{ set: m.corners[i] }" @click="capture(i)">
            {{ lbl }}
          </button>
          <button :class="{ set: m.corners[3] }" @click="capture(3)">BL</button>
          <button :class="{ set: m.corners[2] }" @click="capture(2)">BR</button>
        </div>
        <div class="hb-kv"><span>captured</span><b>{{ m.cornersCaptured }} / 4</b></div>
        <div class="hb-kv"><span>mapping</span><b :class="{ ok: m.mappingSolved }">{{ m.mappingSolved ? "measured" : "ideal" }}</b></div>
        <div v-if="m.residualMm !== null" class="hb-kv">
          <span>residual</span>
          <b :class="m.residualMm < 0.3 ? 'ok' : 'bad'">{{ m.residualMm.toFixed(3) }} mm</b>
        </div>
        <div v-if="m.aspect" class="hb-kv"><span>quad aspect</span><b>{{ m.aspect.toFixed(3) }}</b></div>
        <div class="hb-btnrow">
          <button @click="solve">solve</button>
          <button @click="m.clearCalibration()">clear</button>
          <label class="chk"><input v-model="m.calibrationOn" type="checkbox" /> use it</label>
        </div>
        <p class="hb-note">
          Capture in the order shown. The solver expects TL TR BR BL, and out of order it produces a
          map that looks solved and aims wrong.
        </p>
      </div>
    </section>

    <!-- Soft limits. Stepper only: the servo's window is its pulse range. -->
    <section v-if="!caps?.pulseWindow" id="panel-limits" class="hb-grp" :class="{ focus: focus === 'limits' , collapsed: collapsed['limits'] }">
      <h3 @click="toggleGrp('limits')">limits</h3>
      <div class="hb-body">
        <label class="chk"><input v-model="m.limitsOn" type="checkbox" /> enforce limits</label>
        <div class="grid2">
          <label class="hb-row">min a<input v-model.number="m.limits.minA" type="number" /></label>
          <label class="hb-row">max a<input v-model.number="m.limits.maxA" type="number" /></label>
          <label class="hb-row">min b<input v-model.number="m.limits.minB" type="number" /></label>
          <label class="hb-row">max b<input v-model.number="m.limits.maxB" type="number" /></label>
        </div>
        <button @click="m.limitsFromCorners()">derive from corners</button>
        <p class="hb-note">
          Leave these off while you are finding the edges. Free jog is how you find them.
        </p>
      </div>
    </section>

    <!-- Installation geometry. Both, but the fields differ. -->
    <section id="panel-geometry" class="hb-grp" :class="{ focus: focus === 'geometry' , collapsed: collapsed['geometry'] }">
      <h3 @click="toggleGrp('geometry')">geometry</h3>
      <div class="hb-body">
        <label class="hb-row">throw<input v-model.number="m.throwMm" type="number" step="1" /><span class="unit">mm</span></label>
        <label v-if="!caps?.pulseWindow" class="hb-row">
          mirror sep<input v-model.number="m.sepMm" type="number" step="1" /><span class="unit">mm</span>
        </label>
        <label v-if="caps?.pulseWindow" class="hb-row">
          mount height<input v-model.number="m.mountHMm" type="number" step="1" /><span class="unit">mm</span>
        </label>
        <label class="hb-row">field w<input v-model.number="m.fieldW" type="number" step="5" /><span class="unit">mm</span></label>
        <label class="hb-row">field h<input v-model.number="m.fieldH" type="number" step="5" /><span class="unit">mm</span></label>
        <p v-if="caps?.pulseWindow" class="hb-note">
          Mount height is not cosmetic. The target sits on the floor so its centre is half its height
          up while the head is lower, and the difference is what the tilt axis has to cover.
        </p>
      </div>
    </section>

    <!-- Motion. This is where the two machines diverge most. -->
    <section id="panel-motion" class="hb-grp" :class="{ focus: focus === 'motion' , collapsed: collapsed['motion'] }">
      <h3 @click="toggleGrp('motion')">motion</h3>
      <div class="hb-body">
        <div class="hb-btnrow">
          <label class="chk"><input v-model="m.invA" type="checkbox" @change="m.invertChecked = true" /> invert a</label>
          <label class="chk"><input v-model="m.invB" type="checkbox" @change="m.invertChecked = true" /> invert b</label>
        </div>
        <p class="hb-note">
          Inversion is a wiring correction. It changes what the hardware does and never the preview,
          so jog it and watch the beam rather than the screen.
        </p>

        <template v-if="caps?.backlash">
          <label class="hb-row">lash comp a<input type="number" step="1" /><span class="unit">steps</span></label>
          <label class="hb-row">lash comp b<input type="number" step="1" /><span class="unit">steps</span></label>
          <p class="hb-note">
            Comp is what the board applies. Measure the real slack with the lash gauge pattern: it
            draws the same line both ways and the gap between the traces is the slack.
          </p>
        </template>

        <template v-if="caps?.pulseWindow">
          <label class="hb-row">
            servo
            <select v-model="m.servo">
              <option v-for="c in servoChoices" :key="c.id" :value="c.id">{{ c.label }}</option>
            </select>
          </label>
          <p v-if="deadbandMm !== null" class="hb-note">
            One deadband is <b>{{ deadbandMm.toFixed(2) }} mm</b> on your target at a
            {{ m.throwMm.toFixed(0) }} mm throw. That is the miss this rig cannot plan its way out
            of, and it is why the same drawing looks better larger. Changing this changes what the
            preview predicts, so you can see what a different servo would buy before buying one:
            on the bench model the metal geared 9g takes a 58 mm cap line from 1.70 mm to 0.73 mm.
          </p>
        </template>

        <template v-if="caps?.pulseWindow">
          <label class="hb-row">
            backlash comp
            <input v-model.number="m.backlashComp" type="range" min="0" max="1.5" step="0.05" />
            <b>{{ (m.backlashComp * 100).toFixed(0) }}%</b>
          </label>
          <p class="hb-note">
            Pushes each axis command a deadband in the direction it is travelling, cancelling the
            miss instead of averaging it away. A servo stops a whole deadband short of a target it
            approaches from below and a deadband past one it approaches from above, and which of
            the two happens depends only on direction, so it can simply be subtracted. This is the
            largest single improvement available to this rig: on a 58 mm cap line it takes the
            error from 6.56 mm to 0.52 mm. 100 percent is one deadband and is usually right.
            <b>It replaces dither rather than joining it</b>: run together they are worse than this
            alone, and this one does not leave the servos hunting.
          </p>
        </template>

        <template v-if="caps?.dither">
          <label class="chk"><input v-model="m.dither" type="checkbox" /> dither</label>
          <label class="hb-row">
            draw feed<input v-model.number="m.feedMmS" type="number" step="5" min="0" max="400" />
            <span class="unit">mm/s</span>
          </label>
          <p class="hb-note">
            Dither alternates the command either side of where the planner put it, once per servo
            frame. It needs the feed to be slow enough that the mechanics can average the carrier
            out, so the two are one setting in two boxes: at a 40 mm cap height, dither alone takes
            the ninetieth percentile error from 5.1 to 3.5 mm, a slow feed alone changes nothing at
            all, and both together reach 1.5 mm. 40 mm/s is a good starting point. Zero means no
            limit. Dither is off by default because it holds both servos hunting, which is buzzing
            and current.
          </p>
        </template>

        <template v-if="caps?.lead">
          <label class="hb-row">
            lead a<input v-model.number="m.leadPanMs" type="number" step="0.5" min="0" max="30" />
            <span class="unit">ms</span>
          </label>
          <label class="hb-row">
            lead b<input v-model.number="m.leadTiltMs" type="number" step="0.5" min="0" max="30" />
            <span class="unit">ms</span>
          </label>
          <p class="hb-note">
            The first axis hauls the second, so it answers late and diagonals grow a hook at every
            stroke start. Two to four milliseconds on a straightens them. Worth a few tenths of a
            millimetre, not the headline: the feed and dither pair above is what carries this rig.
          </p>
        </template>

        <template v-if="caps?.coilRelease">
          <label class="chk"><input type="checkbox" checked /> release coils when idle</label>
          <p class="hb-note">These motors cook if a phase is left energised all day.</p>
        </template>

        <div class="hb-btnrow">
          <button :disabled="link.simulated" @click="send('pushConfig')">send to board</button>
          <button :disabled="link.simulated" @click="send('pullConfig')">re-read</button>
          <button :disabled="link.simulated" @click="send('persistConfig')">save to flash</button>
        </div>
      </div>
    </section>

    <!-- Pull-out hunt. Stepper only, and it is a safety tool. -->
    <section v-if="caps?.pullOut" id="panel-patterns" class="hb-grp" :class="{ focus: focus === 'patterns' , collapsed: collapsed['calibration patterns'] }">
      <h3 @click="toggleGrp('calibration patterns')">calibration patterns</h3>
      <div class="hb-body">
        <div class="hb-btnrow">
          <button @click="send('pattern', 'lash')">lash gauge</button>
          <button @click="send('pattern', 'ruler')">ruler</button>
          <button @click="send('pattern', 'square')">square</button>
        </div>
        <button @click="send('stallHunt')">stall hunt</button>
        <p class="hb-note">
          The hunt blinks the beam at home before each pass. Mark that spot. The first rate whose
          blink comes back somewhere else is past pull-out, and a skipped step is geometry that is
          silently gone.
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* A cross, placed explicitly. Letting five buttons flow through a three column
   grid puts "left" beside "up", which reads as a list rather than a direction pad. */
.jog { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; }
.jog button { padding: 10px 0; }
.jog .up { grid-area: 1 / 2; }
.jog .left { grid-area: 2 / 1; }
.jog .mid { grid-area: 2 / 2; }
.jog .right { grid-area: 2 / 3; }
.jog .down { grid-area: 3 / 2; }
.cgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.cgrid button.set { border-color: var(--hb-pink); color: var(--hb-pink); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.hb-grp.focus { box-shadow: inset 0 0 0 2px var(--hb-pink); }
.hb-row input[type=number] { width: 76px; }
.chk {
  display: inline-flex; align-items: center; gap: 6px; font-family: var(--hb-mono);
  font-size: 10px; color: var(--hb-fg-muted); letter-spacing: .02em;
}
.unit { font-family: var(--hb-mono); font-size: 9px; color: var(--hb-fg-faint); letter-spacing: .1em; }
</style>
