/*
 * The one place the app talks to a machine.
 *
 * Everything the UI can do to a rig goes through here, so there is exactly one
 * place where a command reaches a board and exactly one place to look when
 * something reaches one that should not have.
 *
 * Simulator mode is not a stub. It is a supported way to run the whole app, which
 * matters because most of what you do with these tools (choosing content, laying it
 * out, checking what the machine will really draw) needs no hardware at all.
 */

import { SERVO_PRESETS, type Point } from "@virgilvox/beam-core";
import { useLink } from "./stores/link";
import { useMachine } from "./stores/machine";
import { useJob } from "./stores/job";
import { useLog } from "./stores/log";
import { useProject } from "./stores/project";
import { useAnimate, LOOP_STEP } from "./stores/animate";
import type { Transport } from "@virgilvox/beam-link";

function stores() {
  return {
    link: useLink(),
    machine: useMachine(),
    job: useJob(),
    log: useLog(),
    project: useProject(),
    animate: useAnimate(),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/* --------------------------------------------------------------- connecting -- */

export async function connectSerialDevice(): Promise<void> {
  const { log } = stores();
  const { WebSerialTransport } = await import("@virgilvox/beam-link/web");
  const t = new WebSerialTransport();
  await t.connect();
  log.sys("serial open, listening before saying anything");
  await attach(t);
}

export async function connectBleDevice(): Promise<void> {
  const { log } = stores();
  const { WebBleTransport } = await import("@virgilvox/beam-link/web");
  const t = new WebBleTransport();
  await t.connect();
  log.sys("bluetooth connected, listening before saying anything");
  await attach(t);
}

/**
 * Bring a transport up to a classified, adopted machine.
 *
 * The order here is a safety property, not a preference. Nothing is written until
 * the peer has been classified, because the two text vocabularies collide: the
 * stepper firmware dispatches on the first character of a line, so the servo tool's
 * `ECHO 0` arrives as command E with an argument of zero and releases both coil
 * sets, and `M 1500 1500 0` is a millimetre move that slams to the end of travel.
 */
async function attach(transport: unknown): Promise<void> {
  const { link, machine, log } = stores();
  const { Device } = await import("@virgilvox/beam-link");

  const dev = new Device({ transport: transport as Transport });
  link.transport = transport;
  link.device = dev;

  /* The SDK owns the wire. The app only mirrors what it reports. */
  const LEVELS: Record<string, "tx" | "rx" | "err" | "sys"> = {
    tx: "tx", rx: "rx", error: "err", warn: "err", info: "sys",
  };
  dev.events.on("log", (l) => log.push(LEVELS[l.level] ?? "sys", l.text));
  dev.events.on("error", (e) => log.err(e.message));
  dev.events.on("position", (p) => {
    machine.axis = { a: p.a, b: p.b };
    machine.beamOn = p.laser;
    machine.queueFree = p.free;
  });
  dev.events.on("status", (st) => {
    if (typeof st["free"] === "number") machine.queueFree = st["free"];
  });
  dev.events.on("progress", (pr) => {
    const { job } = stores();
    job.sent = pr.sent;
    job.total = pr.total;
  });
  /* INV-25: dropped segments are erased geometry and are never silent. */
  dev.events.on("drops", (d) => log.err(`the board dropped ${d.delta} more segments, ${d.total} total. That geometry is gone.`));
  dev.events.on("flush", (f) => log.err(`queue flushed: ${f.reason}`));

  await dev.connect();
  const peer = dev.peer;
  if (!peer) {
    link.state = "unknown";
    log.err("this board did not identify itself. Staying read only.");
    return;
  }

  link.hello = peer.hello;
  link.lineage = peer.lineage;
  link.legacy = peer.legacy;
  link.kind = (transport as { kind: "serial" | "ble" }).kind;
  machine.setProfile(peer.profile);
  link.state = "ready";

  await dev.adopt();
  machine.config = { ...dev.config };
  machine.adopted = true;
  applyAdopted(dev.config);
  log.sys(`adopted the board's setup: ${peer.profile.label}`);

  stores().project.rebuild();
}

/** Board config into the app's own fields. The board is the authority. */
function applyAdopted(cfg: Readonly<Record<string, string>>) {
  const { machine } = stores();
  const num = (k: string) => (cfg[k] !== undefined ? Number(cfg[k]) : undefined);

  const thr = num("throw") ?? num("ds");
  const sep = num("sep");
  const mh = num("mh");
  const fw = num("fw") ?? num("ww");
  const fh = num("fh") ?? num("wh");

  if (thr !== undefined && Number.isFinite(thr)) machine.throwMm = thr;
  if (sep !== undefined && Number.isFinite(sep)) machine.sepMm = sep;
  if (mh !== undefined && Number.isFinite(mh)) machine.mountHMm = mh;
  if (fw !== undefined && Number.isFinite(fw)) machine.fieldW = fw;
  if (fh !== undefined && Number.isFinite(fh)) machine.fieldH = fh;

  /* The board knows which servo it is wearing, and it is the authority on its own
   * installation. Only adopt a name the app actually models: a board carrying a
   * string we have no preset for would otherwise silently select the fallback and
   * the operator would be reading predictions for the wrong hardware. */
  const sv = cfg["sv"];
  if (sv !== undefined && Object.prototype.hasOwnProperty.call(SERVO_PRESETS, sv)) {
    machine.servo = sv;
  }
  if (cfg["dit"] !== undefined) machine.dither = cfg["dit"] === "1";
  const ffp = num("ffp");
  const fft = num("fft");
  if (ffp !== undefined && Number.isFinite(ffp)) machine.leadPanMs = ffp;
  if (fft !== undefined && Number.isFinite(fft)) machine.leadTiltMs = fft;

  if (cfg["lon"] !== undefined) machine.limitsOn = cfg["lon"] === "1";
  if (cfg["invx"] !== undefined) machine.invA = cfg["invx"] === "1";
  if (cfg["invy"] !== undefined) machine.invB = cfg["invy"] === "1";

  for (const k of ["minx", "maxx", "miny", "maxy"] as const) {
    const v = num(k);
    if (v === undefined || !Number.isFinite(v)) continue;
    if (k === "minx") machine.limits.minA = v;
    if (k === "maxx") machine.limits.maxA = v;
    if (k === "miny") machine.limits.minB = v;
    if (k === "maxy") machine.limits.maxB = v;
  }
}

/* ------------------------------------------------------------------ motion -- */

const sim = () => stores().link.simulated;

export async function jog(da: number, db: number): Promise<void> {
  const { machine, log, link } = stores();
  const next = { a: machine.axis.a + da, b: machine.axis.b + db };
  if (machine.limitsOn) {
    next.a = Math.min(machine.limits.maxA, Math.max(machine.limits.minA, next.a));
    next.b = Math.min(machine.limits.maxB, Math.max(machine.limits.minB, next.b));
  }
  machine.axis = next;
  if (sim()) {
    log.sim(`jog to ${next.a}, ${next.b}`);
    return;
  }
  await call("jog", da, db);
  void link;
}

/**
 * Point the beam at a place on the target, now.
 *
 * The one path that does not go through the planner. Direct control is worth
 * having as its own mode rather than as a debug affordance, because on a rig whose
 * error is a fixed fraction of a millimetre it is genuinely the most accurate way
 * to draw: your eye closes the loop the machine cannot close for itself, and you
 * correct as you go instead of committing a plan and watching it miss.
 *
 * Position goes out absolute rather than as a jog. A jog accumulates whatever the
 * board did not quite manage, so dragging for a minute walks the two frames apart
 * and the beam ends up somewhere the pointer is not.
 */
export async function aimAt(p: Point): Promise<void> {
  const { machine, link } = stores();
  const profile = machine.profile;
  if (!profile) return;

  const next = profile.quantise(profile.inverse(p, machine.activeCal));
  if (machine.limitsOn) {
    next.a = Math.min(machine.limits.maxA, Math.max(machine.limits.minA, next.a));
    next.b = Math.min(machine.limits.maxB, Math.max(machine.limits.minB, next.b));
  }
  machine.axis = next;
  if (sim()) return;
  /*
   * Deliberately not logged. A drag is hundreds of points a second and every one
   * of them would be a console line, which drowns the log that a live beam is the
   * reason you are watching.
   */
  await call("moveTo", next.a, next.b);
  void link;
}

export async function setOrigin(): Promise<void> {
  const { machine, log } = stores();
  machine.axis = { a: 0, b: 0 };
  machine.originSet = true;
  if (sim()) {
    log.sim("origin set here");
    return;
  }
  await call("home");
}

export async function goHome(): Promise<void> {
  const { machine, log } = stores();
  machine.axis = { a: 0, b: 0 };
  if (sim()) {
    log.sim("moved to origin");
    return;
  }
  void log;
  await call("moveTo", 0, 0);
}

export async function toggleBeam(): Promise<void> {
  const { machine, log } = stores();
  machine.beamOn = !machine.beamOn;
  if (sim()) {
    log.sim(`beam ${machine.beamOn ? "on" : "off"}`);
    return;
  }
  await call("setLaser", machine.beamOn);
}

/* ------------------------------------------------------------------ config -- */

export async function pushConfig(): Promise<void> {
  const { log } = stores();
  if (sim()) return void log.sim("push config");
  await call("push", collectConfig());
  log.sys("config sent to the board");
}

export async function pullConfig(): Promise<void> {
  const { machine, log } = stores();
  if (sim()) return void log.sim("re-read config");
  const cfg = (await call("adopt")) as Record<string, string> | undefined;
  if (cfg) {
    machine.config = cfg;
    applyAdopted(cfg);
    log.sys("re-read the board's config");
  }
}

export async function persistConfig(): Promise<void> {
  const { machine, log } = stores();
  machine.persisted = true;
  if (sim()) return void log.sim("persist to flash");
  await call("persist");
  log.sys("config written to the board's flash");
}

/**
 * The installation, in the names the BOARD's config layer uses.
 *
 * This has to be built per lineage and it has to use the SDK's own field names,
 * which is not a style point. The two board configs share almost no vocabulary:
 * the servo board calls the throw `distMm` and the field `wallW`/`wallH`, the
 * stepper board calls them `throwMm` and `fieldW`/`fieldH`; one has `invX`/`invY`
 * and `minX`, the other has no inversion keys at all. A patch keyed on the app's
 * own names matches nothing, and nothing is exactly what gets sent: the serialiser
 * skips undefined fields silently, so `push` returned a bare `CFG ` on the servo
 * rig and dropped the inversions and limits on the stepper rig, with no error
 * anywhere. Pushing config appeared to work and did nothing.
 *
 * That failure is also self concealing, because connect adopts the board's config:
 * change the throw, push it, reconnect, and the app quietly reverts to the board's
 * old value with no sign that the write was lost.
 *
 * The lineage is the peer's, not the profile's. A profile is what the app thinks it
 * is talking to; the lineage is what the wire actually is.
 */
function collectConfig(): Record<string, unknown> {
  const { machine, link } = stores();
  /* The link's lineage when it has one, and the profile's own geometry as the
   * fallback: two mirrors means the step domain. Parenthesised because `??` binds
   * looser than `>=`, so the obvious one line version reads as
   * `(lineage ?? (angle >= 2)) ? ...` and a truthy "pulse" then selects "step". */
  const lineage: "pulse" | "step" =
    link.lineage ?? ((machine.profile?.beamAnglePerAxisAngle ?? 1) >= 2 ? "step" : "pulse");

  if (lineage === "step") {
    return {
      throwMm: machine.throwMm,
      sepMm: machine.sepMm,
      fieldW: machine.fieldW,
      fieldH: machine.fieldH,
      invX: machine.invA,
      invY: machine.invB,
      limitsOn: machine.limitsOn,
      minX: machine.limits.minA,
      maxX: machine.limits.maxA,
      minY: machine.limits.minB,
      maxY: machine.limits.maxB,
    };
  }

  /*
   * The servo rig. `dither` and the two lead terms are the ones that were missing
   * entirely: both are implemented in the firmware, both are exposed as config
   * keys, and neither was ever sent, so the dither checkbox changed the app's own
   * resolution estimate and nothing on the bench.
   */
  return {
    distMm: machine.throwMm,
    wallW: machine.fieldW,
    wallH: machine.fieldH,
    mountH: machine.mountHMm,
    servo: machine.servo,
    dither: machine.dither,
    leadPan: machine.leadPanMs,
    leadTilt: machine.leadTiltMs,
  };
}

/* -------------------------------------------------------------------- jobs -- */

export async function runJob(): Promise<void> {
  const { project, job, log, machine } = stores();
  if (!project.planned) return;
  job.begin(project.commandCount);
  log.sys(`plotting ${project.commandCount} points`);

  if (sim()) {
    /* Walk the simulated path so the operator sees the beam move, at a rate that
     * reflects the machine's own derated ceiling rather than as fast as the browser
     * can paint. */
    const pts = project.simulated;
    const p = machine.profile;
    const perTick = Math.max(1, Math.round(pts.length / 400));
    let i = 0;
    let lastTick = performance.now();

    const tick = () => {
      if (job.state !== "running") return;

      const now = performance.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;

      /*
       * A backgrounded tab throttles timers to about one tick a second. Rather than
       * let the clock jump and then fire a burst of stale frames at the rig, cut the
       * beam and pause.
       *
       * On real hardware this is a safety behavior rather than a cosmetic one: the
       * board holds a queue, every queued segment carries its own beam gate, and a
       * host that goes quiet and then floods is exactly the case that relights the
       * beam over geometry the operator has stopped watching. The stop ordering
       * matters too, flush and then gate, because gating first leaves the queue
       * standing and the board simply relights on the next segment.
       */
      if (dt > 0.4) {
        job.state = "paused";
        machine.beamOn = false;
        log.err("stream stalled, beam cut, plot paused");
        return;
      }

      for (let k = 0; k < perTick && i < pts.length; k++, i++) {
        const at = pts[i]!;
        machine.beamOn = at.on;
        if (p) machine.axis = p.quantise(p.inverse({ x: at.x, y: at.y }, machine.activeCal));
      }
      job.sent = i;
      if (i >= pts.length) {
        machine.beamOn = false;
        job.finish();
        log.sys("plot finished");
        return;
      }
      window.setTimeout(tick, 16 / job.speed);
    };
    tick();
    return;
  }

  /*
   * Send the PLAN, not the simulation.
   *
   * This used to hand the board `project.simulated`, which is the traced path the
   * error model predicts the machine will follow. Sending that back to the machine
   * asks it to reproduce its own error on top of itself, and it carries no
   * velocities at all, so the board's cubic degenerates to a straight chord between
   * every pair of points and every planned acceleration ramp becomes a lurch.
   */
  const segs = project.wire;
  if (!segs.length) {
    log.err("nothing to send: the plan produced no segments");
    job.finish();
    return;
  }
  const lineage = stores().link.lineage;
  const jobPayload =
    lineage === "step"
      ? { lineage: "step" as const, points: segs.map((s) => ({ x: s.a, y: s.b, laser: s.laser })) }
      : {
          lineage: "pulse" as const,
          segments: segs.map((s) => ({
            pan: s.a, tilt: s.b, laser: s.laser, durMs: s.durMs,
            velPan: s.velA, velTilt: s.velB,
          })),
        };
  log.sys(`sending ${segs.length} segments, worst playback error ${project.wireWorstMm.toFixed(3)} mm`);
  await call("run", jobPayload, { dry: job.dryRun });
  /* The SDK's run resolves only once the board has played the job out, so this is
   * the end of the plot and the run state has to say so. LOOP depends on it: it
   * waits for one frame to settle before it advances the tumble and plots the next. */
  machine.beamOn = false;
  job.finish();
  log.sys("plot finished");
}

export async function frameJob(): Promise<void> {
  const { job, log } = stores();
  job.framing = true;
  log.sys("framing the job with the beam off, so you can line the target up");
  await runJob();
}

export async function pauseJob(): Promise<void> {
  const { job, log } = stores();
  job.state = job.state === "paused" ? "running" : "paused";
  log.sys(job.state === "paused" ? "paused" : "resumed");
  if (!sim()) await call(job.state === "paused" ? "pause" : "resume");
}

export async function stopJob(): Promise<void> {
  const { job, machine, log, animate } = stores();
  job.state = "stopping";
  machine.beamOn = false;
  job.finish();
  /* Stop means stop. The original's stop button clears the loop flag too, because a
   * flipbook that starts the next frame after you asked it to stop is not stopped. */
  if (animate.looping) animate.endLoop();
  log.sys("stopped");
  if (!sim()) await call("stop");
}

/**
 * The kill.
 *
 * Flush first, then the gate, never the other way round: every queued segment
 * carries its own beam state, so cutting the gate while the queue still holds
 * geometry lets the board relight the beam and keep drawing.
 */
export async function emergencyStop(): Promise<void> {
  const { job, machine, log, animate } = stores();
  job.state = "stopping";
  machine.beamOn = false;
  job.finish();
  if (animate.looping) animate.endLoop();
  log.err("beam killed, queue dumped");
  if (!sim()) await call("stop");
}

/* -------------------------------------------------------------------- loop -- */

/**
 * Gap between plotted frames, from the detent tool.
 *
 * Long enough that the board's queue has actually drained and the head is standing
 * still before the next frame starts, short enough not to read as a stall.
 */
const LOOP_GAP_MS = 120;

/**
 * LOOP: plot frame after frame until told to stop.
 *
 * This is a flipbook, not animation, and the panel says so. A frame is a whole plot:
 * the tumble advances, the pipeline is rebuilt, the machine draws the entire figure,
 * and only then does the next frame begin. Advancing the pose while a frame is in
 * flight is the one thing this must never do, because the run streams the geometry
 * the last rebuild produced.
 *
 * Pressing it again stops it, which is why there is no separate stop: the loop exits
 * after the frame it is already drawing rather than abandoning geometry mid stroke.
 */
export async function loopFrames(): Promise<void> {
  const { animate, project, job, log } = stores();

  if (animate.looping) {
    animate.endLoop();
    log.sys("loop stops after this frame");
    return;
  }

  animate.beginLoop();
  log.sys("loop started. Frames plot one at a time, so this is a slow flipbook.");

  while (animate.looping) {
    /* Advance the tumble and replan against the new pose, between frames only. */
    animate.step(LOOP_STEP);

    if (!project.planned) {
      log.err("loop stopped: this pose planned to nothing");
      break;
    }

    await runJob();
    /* In simulator mode runJob returns as soon as the walk is scheduled, because the
     * walk is a timer chain rather than an await, so waiting on the run state is the
     * only thing that means the frame is really over on both paths. */
    while (job.running) await sleep(60);

    if (!animate.looping) break;
    await sleep(LOOP_GAP_MS);
  }

  animate.endLoop();
  log.sys("loop finished");
}

/* ------------------------------------------------------------------- other -- */

export async function pattern(kind: string): Promise<void> {
  const { project } = stores();
  project.source = kind as typeof project.source;
  project.rebuild();
}

export async function stallHunt(): Promise<void> {
  const { log } = stores();
  log.sys("stall hunt: the beam blinks at home before each pass. Mark that spot.");
  log.sys("the first rate whose blink comes back somewhere else is past pull-out.");
  if (!sim()) await call("hunt");
}

export async function sendRaw(line: string): Promise<void> {
  const { log } = stores();
  log.tx(line);
  if (sim()) return void log.sim("not sent, nothing is connected");
  await call("send", line);
}

/** Call a method on the connected Device, if there is one. */
async function call(method: string, ...args: unknown[]): Promise<unknown> {
  const { link, log } = stores();
  const dev = link.device as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined> | null;
  if (!dev) return undefined;
  const fn = dev[method];
  if (typeof fn !== "function") {
    log.err(`the SDK does not implement ${method} yet`);
    return undefined;
  }
  try {
    return await fn.call(dev, ...args);
  } catch (e) {
    log.err(e instanceof Error ? e.message : String(e));
    return undefined;
  }
}
