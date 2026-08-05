/*
 * Device: one object that owns a link, a peer and the safety contract.
 *
 * The order of operations at connect is the whole design and it is not negotiable:
 *
 *   1. open the transport and listen
 *   2. send "?" and nothing else until the reply says what this is (INV-62a)
 *   3. speak that lineage's vocabulary, and only then
 *   4. pull the board's stored setup and adopt it, because the board is the thing
 *      bolted to the wall and it is the authority on how it is installed (INV-59)
 *
 * Step 2 is enforced rather than documented. Every write in this class goes through
 * one method, and that method throws if anything but the probe is offered before the
 * lineage is known. A caller cannot get it wrong by forgetting, only by catching the
 * error and trying again, which is a decision rather than an accident.
 *
 * Pushing config back is always explicit. So is persisting it. So is running a job.
 * Nothing in connect writes geometry, and nothing in connect moves the machine.
 */

import {
  JOB_NOMINAL_MS_DEFAULT,
  PROBE,
  WASHER_QUEUE_USABLE,
  createDetent28byj,
  createWasherServo,
  selectProfile,
  type MachineProfile,
} from "@virgilvox/beam-core";
import { classify, isHello, lineageOf, numericKv, parseKv, isLegacy, type Classification, type Lineage, type ProbeOptions } from "./classify.js";
import {
  detentConfigLines,
  detentProfileConfig,
  parseDetentConfig,
  parseWasherConfig,
  washerConfigLine,
  washerProfileConfig,
  type BoardConfig,
  type DetentBoardConfig,
  type WasherBoardConfig,
} from "./config.js";
import { Emitter } from "./emitter.js";
import type { DeviceEvents, DeviceState, Peer, Transport } from "./index.js";
import type { PulseSegment, StepPoint } from "./packet.js";
import {
  Keepalive,
  isBoardDeadman,
  isQueueFull,
  killBeam,
  stopSequence,
} from "./safety.js";
import {
  PulseCredit,
  StepCredit,
  drainQueue,
  sleep,
  streamPulseSegments,
  streamStepPoints,
  type StreamHooks,
  type StreamResult,
} from "./stream.js";

/**
 * A job, tagged with the lineage it was planned for.
 *
 * The tag is not bookkeeping. Handing a pulse job to a step board is exactly the
 * collision the probe exists to prevent, arriving by a different route, so `run`
 * refuses rather than translating.
 */
export type Job =
  | { lineage: "pulse"; segments: readonly PulseSegment[]; nominalMs?: number }
  | { lineage: "step"; points: readonly StepPoint[] };

export interface DeviceOptions {
  transport: Transport;
  probe?: ProbeOptions;
  /** Idle keepalive. On unless a caller has its own traffic and wants the wire quiet. */
  keepalive?: boolean;
  /** How long to wait for the config dump before deciding the board has none stored. */
  configTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_CONFIG_TIMEOUT_MS = 1200;

export class Device {
  readonly events = new Emitter<DeviceEvents>();
  readonly transport: Transport;
  readonly pulseCredit = new PulseCredit();
  readonly stepCredit = new StepCredit();

  private _state: DeviceState = "disconnected";
  private _peer: Peer | null = null;
  private _classification: Classification | null = null;
  private _config: Record<string, string> = {};
  private _board: BoardConfig | null = null;
  private _status: Record<string, number> = {};
  private _position = { a: 0, b: 0, laser: false, free: -1 };
  private _hello = "";
  private _adopted = false;
  private _lastDrops = -1;

  private keepalive: Keepalive | null = null;
  private stopFlag = false;
  /** Set while a deliberate disconnect is in progress, so the close is not a surprise. */
  private closing = false;
  private waiters = new Set<(line: string) => void>();
  private offLine: (() => void) | null = null;
  private offClose: (() => void) | null = null;
  private readonly now: () => number;
  private readonly napFor: (ms: number) => Promise<void>;

  constructor(private readonly opts: DeviceOptions) {
    this.transport = opts.transport;
    this.now = opts.now ?? Date.now;
    this.napFor = opts.sleep ?? sleep;
  }

  /* -------------------------------------------------------------- readers -- */

  get state(): DeviceState {
    return this._state;
  }

  get peer(): Peer | null {
    return this._peer;
  }

  /** Null until the probe has been answered. Nothing but the probe may go out before. */
  get lineage(): Lineage | null {
    return this._classification?.lineage ?? null;
  }

  get classification(): Classification | null {
    return this._classification;
  }

  /** The board's stored setup, in its own lineage's shape. Null if it had none. */
  get boardConfig(): BoardConfig | null {
    return this._board;
  }

  /** Every key the board reported, as text. This is what profile selection reads. */
  get config(): Readonly<Record<string, string>> {
    return this._config;
  }

  get status(): Readonly<Record<string, number>> {
    return this._status;
  }

  get position(): Readonly<{ a: number; b: number; laser: boolean; free: number }> {
    return this._position;
  }

  /**
   * True once the board's stored setup actually arrived and was adopted.
   *
   * INV-59: the board is the source of truth, so connect pulls its setup first and
   * adopts it, and the app only offers to push its own if the board had none.
   */
  get adopted(): boolean {
    return this._adopted;
  }

  /* ------------------------------------------------------------- lifecycle -- */

  async connect(): Promise<void> {
    if (this._state !== "disconnected") return;
    this.attach();
    await this.transport.connect();
    this.setState("classifying");

    const probeOpts: ProbeOptions = { ...(this.opts.probe ?? {}) };
    if (this._hello) probeOpts.hello = this._hello;
    const found = await classify(this.transport, probeOpts);
    this._classification = found;
    if (found.hello) this._hello = found.hello;

    if (!found.lineage) {
      /*
       * Nothing answered. Staying in simulator mode is the only safe move: guessing
       * the vocabulary is what releases a stepper's coils or slams it across its
       * travel, and a board that did not answer three probes is a board this host
       * cannot describe.
       */
      this.setState("unknown");
      this.log("warn", `no answer to ${found.probes} probes, staying in simulator mode`);
      return;
    }

    this.applyStatusLine(found.statusLine);
    this.setState("adopting");
    await this.prologue(found.lineage);
    await this.adopt();
    this.resolvePeer();
    this.startKeepalive();
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.keepalive?.stop();
    /*
     * INV-46: a BLE disconnect kills the beam and flushes the queue on the board's
     * own initiative. There is no USB CDC equivalent, so on serial the dead man is
     * the only backstop and a deliberate disconnect should not lean on it.
     */
    if (this._peer) await killBeam(this._peer.lineage, (line) => this.send(line));
    try {
      await this.transport.disconnect();
    } finally {
      this.teardown();
      this.closing = false;
    }
  }

  private attach(): void {
    this.offLine = this.transport.onLine((line) => this.handleLine(line));
    this.offClose = this.transport.onClose(() => {
      /* A link that drops on its own is news. One we are closing on purpose is not. */
      if (!this.closing) this.log("warn", "link dropped");
      this.teardown();
    });
  }

  private teardown(): void {
    this.keepalive?.stop();
    this.keepalive = null;
    this.offLine?.();
    this.offClose?.();
    this.offLine = null;
    this.offClose = null;
    this.waiters.clear();
    this._peer = null;
    this._classification = null;
    this._adopted = false;
    this._lastDrops = -1;
    this.pulseCredit.reset();
    this.stepCredit.reset();
    this.setState("disconnected");
  }

  /* ---------------------------------------------------------------- writes -- */

  /**
   * The one place anything is written.
   *
   * INV-62a lives here. `ECHO 0` to a step board releases both coil sets and
   * `M 1500 1500 0` is a full travel slam over there, so an unclassified peer gets
   * one byte and nothing else until it has said which parser is listening.
   */
  async send(line: string): Promise<void> {
    if (this.lineage === null && line !== PROBE) {
      throw new Error(
        `INV-62a: only the probe may be sent before the peer is classified, refused "${line}"`,
      );
    }
    this.events.emit("log", { level: "tx", text: line });
    await this.transport.sendLine(line);
  }

  /** Ask the board where it is. Safe at any time, in either vocabulary. */
  async probe(): Promise<void> {
    await this.send(PROBE);
  }

  /* ---------------------------------------------------------------- inbound -- */

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    for (const w of [...this.waiters]) w(line);

    if (lineageOf(line)) {
      this.applyStatusLine(line);
      return;
    }
    if (line.startsWith("@")) {
      this.applyPositionReport(line);
      return;
    }
    if (isHello(line)) {
      this._hello = line;
      this.log("info", line);
      return;
    }
    if (isBoardDeadman(line)) {
      this.onBoardDeadman(line);
      return;
    }
    if (isQueueFull(line)) {
      /* Stand off and let it drain rather than piling writes onto a full queue. */
      this.pulseCredit.hold(this.now());
      this.log("warn", "board queue full, backing off");
      return;
    }
    this.events.emit("log", { level: "rx", text: line });
  }

  private onBoardDeadman(line: string): void {
    /*
     * INV-41: the board cut the beam and dumped its queue because nothing reached it
     * in time. Streaming on regardless would draw from the wrong place, so stop here
     * and let the operator resume from where the beam actually stopped.
     */
    this.stopFlag = true;
    this.pulseCredit.reset();
    this.stepCredit.reset();
    this.events.emit("flush", { reason: "board dead man" });
    if (this._state === "running") this.setState("paused");
    this.log("error", `board dead man: ${line}`);
  }

  private applyStatusLine(line: string): void {
    if (!line) return;
    const kv = parseKv(line);
    const n = numericKv(kv);
    this._status = n;

    if (lineageOf(line) === "pulse") {
      const free = n["q"];
      if (free !== undefined) this.pulseCredit.report(free);
      this._position = {
        a: n["pan"] ?? this._position.a,
        b: n["tilt"] ?? this._position.b,
        laser: (n["laser"] ?? 0) !== 0,
        free: free ?? this._position.free,
      };
      this.noteDrops(n["qd"]);
    } else {
      const free = n["free"];
      if (free !== undefined) {
        this.stepCredit.report(free, n["q"] ?? 0, (n["run"] ?? 0) !== 0);
      }
      /* lx/ly is where the beam points; px/py is the raw shaft count including the
       * slack take-up. Prefer the logical pair, which is what the host commanded. */
      this._position = {
        a: n["lx"] ?? n["px"] ?? this._position.a,
        b: n["ly"] ?? n["py"] ?? this._position.b,
        laser: this._position.laser,
        free: free ?? this._position.free,
      };
      this.noteDrops(n["drop"]);
    }

    if (this.keepalive) this.keepalive.beamOn = this._position.laser;
    this.events.emit("status", this._status);
    this.events.emit("position", this._position);
  }

  /** "@ pan tilt laser [qfree]": the pulse rig's live position report. */
  private applyPositionReport(line: string): void {
    const p = line.split(/\s+/);
    if (p.length < 4) return;
    const a = Number.parseFloat(p[1] ?? "");
    const b = Number.parseFloat(p[2] ?? "");
    const laser = p[3] === "1";
    let free = this._position.free;
    if (p.length >= 5) {
      const f = Number.parseInt(p[4] ?? "", 10);
      if (Number.isFinite(f)) {
        free = f;
        /* Fresh credit. Everything launched since the last report is accounted for. */
        this.pulseCredit.report(f);
      }
    }
    this._position = {
      a: Number.isFinite(a) ? a : this._position.a,
      b: Number.isFinite(b) ? b : this._position.b,
      laser,
      free,
    };
    if (this.keepalive) this.keepalive.beamOn = laser;
    this.events.emit("position", this._position);
  }

  /**
   * INV-25: dropped segments are erased geometry and are never silent. A rising drop
   * counter is surfaced loudly, because nothing else in the system can tell that the
   * drawing on the wall is missing a piece.
   */
  private noteDrops(total: number | undefined): void {
    if (total === undefined) return;
    if (this._lastDrops >= 0 && total > this._lastDrops) {
      const delta = total - this._lastDrops;
      this.events.emit("drops", { total, delta });
      this.log("error", `board dropped ${delta} segments at a full queue: that geometry is gone`);
    }
    this._lastDrops = total;
  }

  /** Collect lines until `done` matches or the budget runs out. */
  private collect(match: RegExp, done: RegExp, timeoutMs: number): Promise<string[]> {
    return new Promise((resolve) => {
      const got: string[] = [];
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(watcher);
        resolve(got);
      };
      const watcher = (line: string) => {
        if (match.test(line)) got.push(line);
        if (done.test(line)) finish();
      };
      const timer: ReturnType<typeof setTimeout> = setTimeout(finish, timeoutMs);
      this.waiters.add(watcher);
    });
  }

  /* ----------------------------------------------------------- adoption -- */

  /**
   * The first lines that are safe to send, now that the parser on the other end is
   * known.
   *
   * `ECHO 0` stops the per command OK flood, which stalls BLE streaming. `REPORT 50`
   * asks for 20 Hz position so a viewport can follow the servos. On the step rig `V`
   * is asked for one reason: it carries the tick rate, and the tick rate is negotiated
   * rather than compiled in, because a stale comment in the firmware is exactly how a
   * host ends up off by a factor of two on every interval it sends.
   */
  private async prologue(lineage: Lineage): Promise<void> {
    if (lineage === "pulse") {
      await this.send("ECHO 0");
      await this.send("REPORT 50");
      return;
    }
    const waitVersion = this.collect(/^detent\b/, /^detent\b/, 400);
    await this.send("V");
    const [version] = await waitVersion;
    if (version && this._classification) {
      const tick = Number.parseInt(parseKv(version)["tick"] ?? "", 10);
      if (Number.isFinite(tick) && tick > 0) this._classification.wire.tick = tick;
    }
  }

  /**
   * Pull the board's stored setup and adopt it.
   *
   * INV-59: the board is the source of truth. This never pushes. A board with nothing
   * stored simply answers nothing, `adopted` stays false, and it is the app's decision
   * whether to offer to push what it has.
   */
  async adopt(): Promise<BoardConfig | null> {
    const lineage = this.lineage;
    if (!lineage) return null;
    const timeout = this.opts.configTimeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS;

    if (lineage === "pulse") {
      const waitCfg = this.collect(/^CFG\b/, /^CFG\b/, timeout);
      await this.send("CFG");
      const [line] = await waitCfg;
      if (!line) {
        this.log("warn", "board has no stored setup");
        return null;
      }
      const cfg = parseWasherConfig(line);
      if (!cfg) return null;
      this._board = cfg;
      this._config = { ...this._classification?.kv, ...parseKv(line) };
      this._adopted = true;
      this.events.emit("board", cfg);
      this.events.emit("config", this._config);
      this.log(
        "info",
        `adopted the board's stored setup: ${Math.round(cfg.wallW)} x ${Math.round(cfg.wallH)} mm ` +
          `at ${Math.round(cfg.distMm)} mm` +
          (cfg.cornerCount ? `, ${cfg.cornerCount} corners` : "") +
          (cfg.calibrationOn ? ", calibration on" : ""),
      );
      return cfg;
    }

    const waitDump = this.collect(/^qc/, /^qc4\b/, timeout);
    await this.send("Q");
    const lines = await waitDump;
    const cfg = parseDetentConfig(lines);
    if (!cfg) {
      this.log("warn", "board has no stored setup");
      return null;
    }
    if (!cfg.complete) this.log("warn", "config dump was cut short, adopting what arrived");
    this._board = cfg;
    const merged: Record<string, string> = { ...this._classification?.kv };
    for (const line of lines) Object.assign(merged, parseKv(line));
    this._config = merged;
    this._adopted = true;
    this.events.emit("board", cfg);
    this.events.emit("config", this._config);
    this.log(
      "info",
      `adopted the board's stored setup: ${Math.round(cfg.fieldW)} x ${Math.round(cfg.fieldH)} mm ` +
        `at ${Math.round(cfg.throwMm)} mm` +
        (cfg.mapValid ? ", measured mapping" : ", ideal model"),
    );
    return cfg;
  }

  /**
   * INV-62: selection comes from the hello line plus the config dump, never from a
   * dropdown, because a wrong profile aims a live beam through the wrong map. An
   * ambiguous or unclaimed board connects read only and asks.
   */
  private resolvePeer(): void {
    const found = this._classification;
    if (!found?.lineage) return;
    const match = selectProfile(this._hello, this._config);
    if (!match.ok) {
      this.setState("unknown");
      this.log(
        "error",
        match.reason === "ambiguous"
          ? `more than one profile claims this board (${match.candidates.join(", ")}). Connected read only.`
          : `no profile claims this board. Hello line was "${this._hello || "(none)"}". Connected read only.`,
      );
      return;
    }
    this.adoptProfile(this.withBoardNumbers(match.profile));
  }

  /** The profile, rebuilt with whatever the board actually said it is. */
  private withBoardNumbers(profile: MachineProfile): MachineProfile {
    const board = this._board;
    if (board?.kind === "washer" && profile.id === "washer-servo") {
      return createWasherServo(washerProfileConfig(board));
    }
    if (board?.kind === "detent" && profile.id === "detent-28byj") {
      return createDetent28byj(detentProfileConfig(board));
    }
    return profile;
  }

  /**
   * Accept a profile for a board that did not claim exactly one.
   *
   * This is the operator answering the question INV-62 says to ask, and it is
   * deliberately a separate call: a dropdown that picks silently at connect is the
   * thing the invariant forbids.
   */
  adoptProfile(profile: MachineProfile): void {
    const found = this._classification;
    if (!found?.lineage) throw new Error("classify the peer before adopting a profile");
    this._peer = {
      lineage: found.lineage,
      legacy: isLegacy(found.wire),
      profile,
      wire: found.wire,
      hello: this._hello,
    };
    this.events.emit("peer", this._peer);
    this.setState("idle");
  }

  private startKeepalive(): void {
    const lineage = this.lineage;
    if (!lineage || this.opts.keepalive === false) return;
    this.keepalive = new Keepalive(lineage);
    this.keepalive.beamOn = this._position.laser;
    this.keepalive.start(() => {
      void this.send(PROBE).catch(() => {});
    }, this.now);
  }

  /* ------------------------------------------------------------- commands -- */

  private requirePeer(): Peer {
    if (!this._peer) {
      throw new Error("no peer: the board is unclassified or unclaimed, so it is read only");
    }
    return this._peer;
  }

  /** Move by a relative axis pair, beam untouched. */
  async jog(da: number, db: number): Promise<void> {
    const peer = this.requirePeer();
    if (peer.lineage === "pulse") {
      await this.send(
        `P ${Math.round(this._position.a + da)} ${Math.round(this._position.b + db)}`,
      );
    } else {
      await this.send(`J ${Math.round(da)} ${Math.round(db)}`);
    }
  }

  /** Move to an absolute axis pair. The beam gate travels with it where it can. */
  async moveTo(a: number, b: number, laser?: boolean): Promise<void> {
    const peer = this.requirePeer();
    if (peer.lineage === "pulse") {
      if (laser === undefined) await this.send(`P ${Math.round(a)} ${Math.round(b)}`);
      else await this.send(`M ${Math.round(a)} ${Math.round(b)} ${laser ? 1 : 0}`);
      return;
    }
    await this.send(`S ${Math.round(a)},${Math.round(b)},${laser ? 1 : 0}`);
  }

  /**
   * The beam gate on its own.
   *
   * `L 0` and `L 1` are identical in name, arity and meaning on both boards, and they
   * are the one free command: the only line that means the same thing whichever parser
   * turns out to be listening.
   */
  async setLaser(on: boolean): Promise<void> {
    this.requirePeer();
    await this.send(`L ${on ? 1 : 0}`);
    this._position = { ...this._position, laser: on };
    if (this.keepalive) this.keepalive.beamOn = on;
  }

  async home(): Promise<void> {
    const peer = this.requirePeer();
    await this.send(peer.lineage === "pulse" ? "HOME" : "H");
  }

  /**
   * Push a setup to the board. Always explicit, never part of connect.
   *
   * INV-61: a pulse push carrying all four corners runs close to 200 characters and
   * goes as ONE line, because the board applies a CFG line key by key and a line split
   * in half applies half a config.
   */
  async push(patch: Partial<WasherBoardConfig> | Partial<DetentBoardConfig>): Promise<void> {
    const peer = this.requirePeer();
    if (peer.lineage === "pulse") {
      await this.send(washerConfigLine(patch as Partial<WasherBoardConfig>));
      return;
    }
    for (const line of detentConfigLines(patch as Partial<DetentBoardConfig>)) {
      await this.send(line);
    }
  }

  /**
   * Commit the board's current setup to flash.
   *
   * INV-60: persisting is an explicit act. On the step rig that is `W`. On the pulse
   * rig the shipped firmware commits on every CFG assignment, so a push has already
   * persisted and there is nothing left to send; that implicit write is what moves
   * behind this call when the firmware catches up.
   */
  async persist(): Promise<boolean> {
    const peer = this.requirePeer();
    if (peer.lineage === "step") {
      await this.send("W");
      return true;
    }
    this.log("info", "this board commits config to flash on every CFG assignment");
    return false;
  }

  /* ------------------------------------------------------------------ jobs -- */

  private hooks(): StreamHooks {
    return {
      sleep: this.napFor,
      now: this.now,
      shouldStop: () => this.stopFlag,
      onProgress: (sent, total) => this.events.emit("progress", { sent, total }),
      onLog: (level, text) => this.log(level, text),
    };
  }

  /**
   * Stream a job and wait for the board to finish playing it.
   *
   * The beam is not cut when the host's timeline ends. A board that stretched segments
   * to cover lost packets is still playing a tail, and cutting there lands the cut in
   * the middle of the last stroke (INV-82).
   */
  async run(job: Job): Promise<StreamResult> {
    const peer = this.requirePeer();
    if (job.lineage !== peer.lineage) {
      throw new Error(
        `job was planned for the ${job.lineage} lineage and this board is ${peer.lineage}`,
      );
    }
    if (this._state !== "idle" && this._state !== "paused") {
      throw new Error(`cannot start a job while ${this._state}`);
    }

    this.stopFlag = false;
    this.setState("running");
    if (this.keepalive) this.keepalive.running = true;

    try {
      let result: StreamResult;
      if (job.lineage === "pulse") {
        /* JOB resets the board's sequence and its loss estimator, and clears the
         * queue, so the credit the host was holding is stale from this moment. */
        await this.send(`JOB ${Math.max(1, Math.round(job.nominalMs ?? JOB_NOMINAL_MS_DEFAULT))}`);
        this.pulseCredit.reset();
        this.events.emit("flush", { reason: "job start" });
        await this.send(PROBE);
        result = await streamPulseSegments({
          transport: this.transport,
          hooks: this.hooks(),
          segments: job.segments,
          wire: peer.wire,
          credit: this.pulseCredit,
        });
      } else {
        result = await streamStepPoints({
          transport: this.transport,
          hooks: this.hooks(),
          points: job.points,
          credit: this.stepCredit,
          ...(peer.wire.ivb >= 1 ? { wire: peer.wire } : {}),
        });
      }

      if (!result.stopped) {
        await this.drain();
        await this.setLaser(false);
      }
      return result;
    } finally {
      if (this.keepalive) this.keepalive.running = false;
      this.settleAfterRun();
    }
  }

  /** Leave "running" without leaving "paused", which the dead man may have set. */
  private settleAfterRun(): void {
    if (this._state === "running") this.setState("idle");
  }

  /**
   * INV-45 and INV-43 together: raise the stop flag first so nothing more is emitted
   * inside the tick that is running, then flush, then cut the beam. Sending only the
   * gate and leaving the queue standing means every queued segment relights it.
   */
  async stop(): Promise<void> {
    this.stopFlag = true;
    const peer = this._peer;
    if (peer) {
      for (const line of stopSequence(peer.lineage)) await this.send(line);
    }
    /* INV-44: any flush is paired with resetting what the host assumed about the
     * board's state, because the board's own clear zeroes its velocity too. */
    this.pulseCredit.reset();
    this.stepCredit.reset();
    this._position = { ...this._position, laser: false };
    if (this.keepalive) this.keepalive.beamOn = false;
    this.events.emit("flush", { reason: "stop" });
    if (this._state === "running") this.setState("idle");
  }

  /** Wait for the board to finish what it already holds. Bounded, and never silent. */
  async drain(timeoutMs = 2000): Promise<boolean> {
    const peer = this._peer;
    if (!peer) return true;
    const isDrained =
      peer.lineage === "pulse"
        ? /* The queue is empty when the board reports its free count back at the top.
           * One slot of slack, because the segment being played has already left it. */
          () =>
            this.pulseCredit.boardFree < 0 ||
            this.pulseCredit.boardFree >= WASHER_QUEUE_USABLE - 1
        : () => this.stepCredit.free < 0 || (this.stepCredit.queued === 0 && !this.stepCredit.running);

    const ok = await drainQueue({
      isDrained,
      poke: () => this.send(PROBE),
      hooks: this.hooks(),
      timeoutMs,
    });
    if (!ok) this.log("warn", "board never reported its queue drained, cutting the beam anyway");
    return ok;
  }

  /* ------------------------------------------------------------------ misc -- */

  private setState(next: DeviceState): void {
    if (this._state === next) return;
    this._state = next;
    this.events.emit("state", next);
  }

  private log(level: "info" | "warn" | "error", text: string): void {
    this.events.emit("log", { level, text });
  }
}
