# PRD: hackbuild-laser-rig

Monorepo `hackbuild-laser-rig`. One JavaScript library that owns motion, protocol, and transport. One Vue app that owns everything visual, including a clean hack.build theme layer built for reuse but not packaged. The firmware does not change, the wire protocol does not change, and every hard-won behavior from the bench sessions carries over as a named invariant with a test on it.

This supersedes the earlier draft (washer-split-prd.md). Names are settled: plain, descriptive, published under the `virgilvox` npm account.

## 1. Packages

```
hackbuild-laser-rig/
  firmware/PanTiltLaser.ino          source of truth, unchanged
  packages/laser-rig-core/           @virgilvox/laser-rig-core
  apps/rig/                          private, builds dist/laser-rig.html
    src/ui/                          hack.build tokens and presentational components
    src/stores/  src/session/        Pinia stores and the core adapter
  docs/PROTOCOL.md                   wire contract, extracted from the ino doc header
  docs/INVARIANTS.md                 section 7, kept current
```

@virgilvox/laser-rig-core is the engine: geometry, planner, hermite emitter, three-format protocol, credit flow control, servo sim, session facade. Authored in TypeScript, shipped as standard ESM JavaScript with type declarations, zero runtime dependencies. It must be consumable two ways: from the monorepo through the workspace, and from a plain single-file HTML page through `<script type="module">` and esm.sh with no build step, the same way conduyt-js gets used. Entry points: the root (runtime-agnostic core), `/web` (WebSerialTransport, WebBluetoothTransport), and `/testing` (the firmware reference model and golden fixtures, published so downstream consumers can run conformance tests too).

apps/rig is the app, and the only published package is the engine. The hack.build design system lives inside the app at `src/ui`: a token stylesheet plus presentational Vue components, kept strictly separate from stores and session code so it stays reusable in shape without being a package in fact. If a second tool ever wants it, extraction is a folder move, not a rewrite. The app builds with Vite plus vite-plugin-singlefile to one HTML file that opens from disk and works, exactly like today's tool.

## 2. Goals

1. Extract everything that is not UI into laser-rig-core, testable headless in node.
2. Build the app's ui layer in the hack.build language, presentational and props-only, structured so it could be lifted out later without surgery.
3. Rebuild the UI in Vue 3 with feature parity, where components contain zero protocol, planner, or transport logic.
4. Keep the shipped artifact a single HTML file that runs from file:// with no server.
5. Turn the invariants registry into an executable suite so the rewrite cannot silently regress five sessions of bench debugging.
6. Leave the firmware untouched, inlined into the app at build time with `?raw` instead of the hand-maintained embed block.

## 3. Non-goals

- No firmware rewrite, no protocol changes, no new packet formats.
- No server, no backend, no accounts, no telemetry.
- No CLASP dependency in v1. A relay bridge is a stretch goal.
- No framework code in laser-rig-core. If a line mentions Vue, the DOM, or `window` outside the `/web` entry, it is in the wrong package.

## 4. The hack.build theme layer

`apps/rig/src/ui` encodes the brand as it actually is, not as older skill files remember it. The favicon values are canonical.

Tokens. Pink `#FE0386` as the single accent. Cream paper `#f5f0e6`. Ink `#1a1a1a`. Dark `#0a0a0a`. Paper grain texture at heavier opacity than the LumenCanvas system. Hard block shadows, `4px 4px 0 0`, never blur. Thick 3px accent borders on headers and interactive containers. Font Awesome or inline SVG icons, never emojis.

Typography has distinct roles and nothing sets everything in one face: IBM Plex Mono for the wordmark and all utility text, which in an instrument UI is most of the text; Permanent Marker for display headlines only, used sparingly; Special Elite for typewriter prose, the hints and folded explainers; Libre Baskerville italic for the tagline if it appears. VT323 is permitted for the console readout as the one terminal surface. Fonts load from Google Fonts over https, which works from file://; every face declares an honest system fallback so an offline bench degrades to legible, not broken.

Wordmark treatment: "hack" in ink, then the dot and "build" both in pink. The logo is the two-path favicon SVG, broken arc in ink and wrench in pink, scaled only through the calibrated viewBox `117 103 800 800`. The mark is retrieved from the canonical asset, never redrawn.

Schemes. One token set derives two schemes: paper (cream ground, ink text) and ink (dark ground, paper text). A laser bench in a dark room needs the ink scheme, so the rig app defaults to ink with a toggle; documentation pages and future daylight tools default to paper. Both schemes keep pink as the only accent and must hold contrast on every control.

Component inventory, v1: Panel, GroupHead, Fold (the closed-by-default disclosure), Slider (label, value, unit), NumberField, Toggle, Btn (primary, secondary, danger, block), StatusChip, Console (log levels, raw protocol echo), RunDock (the pinned action strip with progress and inline slider), Hint, KeyValue readout, and a Wordmark/Logo component. Each supports both schemes with a props-only API and no business logic: nothing in `src/ui` imports a store, the session, or laser-rig-core, enforced by lint. A dev-only showcase route renders every component in both schemes and doubles as the visual regression surface.

## 5. Architecture

### 5.1 Layers and dependency rules

Dependencies point downward only. A layer never imports from the layer above it.

```
apps/rig (Vue, Pinia)
  ├─ src/ui: hack.build tokens + presentational components, imports nothing below
  └─ session facade (@virgilvox/laser-rig-core)
       ├─ streamer: emitter, credit flow, backpressure, drain
       ├─ protocol: framing, packers, parsers, negotiation, config sync
       ├─ motion:   geometry, sources, planner, timeline, playback error
       ├─ sim:      servo physics model, digital twin follower
       └─ transport interface  ←  /web implements; node serialport later
```

The motion layer is pure functions over plain data. Geometry in, timeline out, segments out. It runs under vitest in node with no shims.

The protocol layer owns bytes and lines: packers, unpackers, CRC8, escape ranges, the STAT, CFG, and `@` parsers, and the capability negotiation state machine (`seg`, `bin`, `herm`). It never sends anything; it produces frames and consumes lines.

The streamer owns time: the emit cursor, hermite chain state, credit accounting, the backpressure gate, hold-offs, and the drain at job end. It talks to a Transport and consumes a Timeline.

The session facade is the only thing an app touches. `createSession(transport)` returns imperative methods (connect, jog, setConfig, calibrate, plan, run, pause, resume, stop, estop, dryRun) and a typed event emitter (state, position, twin, stats, config, log, error). Pinia subscribes to events; it never reaches deeper.

### 5.2 Key interfaces, sketch

```js
// import { createSession } from '@virgilvox/laser-rig-core'
// import { WebBluetoothTransport } from '@virgilvox/laser-rig-core/web'

interface Transport {
  readonly kind: 'serial' | 'ble' | 'mock';
  readonly pending: number;              // writes in flight, the backpressure signal
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendLine(text: string): Promise<void>;
  sendFrame(bytes: Uint8Array): Promise<void>;
  onLine(cb: (line: string) => void): Unsub;
  onClose(cb: () => void): Unsub;
}

interface Timeline { moves: ChainMove[]; dur: number; gates: number[]; }
interface WireSegment { pu: number; tu: number; on: boolean; dur: number; vp: number; vt: number; }

interface Session extends Emitter<SessionEvents> {
  readonly caps: { seg: boolean; bin: boolean; delta: boolean; herm: boolean };
  readonly machine: MachineConfig;       // geometry, trims, lead, dither, range
  plan(source: Source, tuning: PlanTuning): PlanResult;   // pure, previewable
  run(plan: PlanResult, opts?: { dry?: boolean }): void;
}
```

MockTransport wraps the firmware reference model from `/testing`, so the whole stack runs headless: session, streamer, protocol, simulated board, back to `@` reports. The app uses it for its disconnected demo state; CI uses it for soak tests.

### 5.3 The Vue app

Vue 3, `<script setup>`, Pinia, Vite. One store per concern: `useLink`, `useMachine`, `useJob`, `useConsole`. One composable, `useSession`, owns the core session and pipes events into the stores. Screens are `src/ui` pieces arranged into today's regions: the Machine column (jog and calibrate, Pan / Tilt group, Geometry), the Job column (sources, plan tuning, preview), the pinned run dock, and the console. No component imports core internals, only the session facade and plain data.

### 5.4 The file:// constraint

Standing requirement: the built HTML opens directly from disk. No module workers from file://; if one is ever wanted, use a classic script exposing an API on globalThis with an inline fallback. Web Serial and Web Bluetooth both work from file:// in Chromium and the current tool proves it daily. Remote font and CDN fetches over https also work from file:// and are permitted with fallbacks.

## 6. What the library must express

The engine is not a port of functions, it is a port of decisions. The invariants below are the spec; the architecture above says where each one lives.

## 7. Invariants registry

Every item was paid for on the bench. Each becomes a named test in laser-rig-core. A PR that changes a behavior changes its test and says why.

Transport

1. BLE writes go with response through one serialized writer. Without-response writes vanish silently under congestion; the bench log showed `lost` jumping 29 in one beat before this change.
2. Adaptive chunking: start at 180 bytes, drop to 20 stickily the first time a write is refused, resend what the refusal bounced, reset to 180 on a new connection.
3. Oversized frames are never dropped: the fit loop hands segments back until the escaped packet fits the 176-byte budget.
4. Backpressure: the emitter halts while more than 3 writes are in flight.

Flow control

5. Credit accounting: free slots arrive in `@` reports and STAT `q=`; every sent segment spends one; the emit gate requires `room() >= 6`.
6. The firmware self-arms `@` reports at 150 ms whenever a job is armed; the app re-sends `REPORT 50` at every plot start anyway.
7. `qd` deltas are surfaced loudly. Dropped segments are erased geometry and are never silent.
8. Packet sizes: 8 hermite segments per packet, 10 legacy, matching the firmware framer caps exactly.

Wire format

9. Three formats: A5 flat, A6 delta, A4 hermite (8 bytes per segment, endpoint velocity as int8 in sixteenths of a us per ms), negotiated from STAT tokens; hermite requires bin.
10. Escape asymmetry: hermite packets escape 0xA4 through 0xA7; legacy packets escape only 0xA5 through 0xA7, because old firmware would mistranslate `A7 04`. Deliberate and load-bearing.
11. CRC8 over unescaped bytes. A CRC failure keeps `seqPrimed` so the lost time still stretches.

Hermite playback

12. The board plays each segment from its actual position and actual velocity to the endpoint pair; boundaries are continuous and loss splices are curved reroutes, not lurches.
13. Legacy segments get chord tangents at both ends, collapsing the cubic to the exact straight line old senders expect.
14. Tangent clamp: 3 chord slopes plus 24 us of headroom over duration, per axis. Corner splice went from 11.25 mm off path to 1.60 mm; provably inert on healthy segments.
15. Loss stretch scales arrival velocity by originalDur over stretchedDur.
16. A resync (queue gap of 250 ms or more) zeroes tracked velocity; the starvation gate only zeroes it when the beam was lit.
17. App-side velocity chain state resets at every point the board's does: job start, pause, stall, deadman, dry run, e-stop, flush.

Loss and timing

18. Sequence gaps stretch the survivor by gap times a running average of arriving wire durations (EMA, alpha one eighth, seeded from the JOB nominal), capped at 60 s. Held tempo error to 9 ms across a dropped 8-segment packet where a one-neighbor estimate drifted 113 ms.
19. Durations carry a residual so millisecond rounding never accumulates.

Safety semantics

20. Deadman counts queued or active playback as life; it fires only on a lit beam, empty queue, silent link, and dumps the queue when it does. The app auto-pauses only when a plot is running.
21. The starvation gate cuts the beam within 300 ms when an armed job runs dry, and zeroes velocity.
22. Idle keepalive polls once a second whenever connected; in-plot poll every 1.2 s, inside the 1.5 s deadman.
23. Stop ordering is FLUSH then `L 0`, and the e-stop flag is checked before emission.

Motion quality

24. The emission error metric is time-aware: plan versus played at matched instants, through the full calibrated map, scoring the quantized tangents that ship. The old spatial-only metric approved the exact lurch it existed to prevent.
25. Hermite spans cap at 150 ms and 25 mm; minimum 8 ms; dwells merge only when both tangents are zero, to 200 ms.
26. Steps per frame is a ceiling defaulting to 4.0. The axis-alternating band, roughly 0.4 to 2.5 deadband steps per frame, is where two independent hysteresis quantizers pop one axis at a time; the readout names the band and warns inside it; defaults land at or above 2.5.
27. Integer-microsecond endpoints are the physical floor; dither exists for exactly that; the sim models deadband, frame latching, and backlash so the preview tells the truth.

## 8. Testing

Four tiers, all vitest, all headless.

Golden vectors. Before porting, a capture script lifts the shipped functions from the current HTML (the brace-matching trick the existing harness uses) and records fixtures: packed bytes for known segment lists in all three formats including NUL and escape-heavy payloads, parser outputs for recorded STAT, CFG, and `@` lines, planner timelines for reference jobs. Ported code reproduces fixtures byte for byte before any refactor improves anything.

Firmware reference model. The board model (framer, sequence and stretch with EMA, hermite eval with clamp, starvation, deadman) lives in `/testing` as the executable spec, with a documented sync duty: any firmware change updates the model in the same commit.

Fidelity budgets, gates from measured baselines:

| metric | budget |
|---|---|
| worst boundary velocity step, hermite | <= 0.08 us/ms per ms |
| rms tracking error, float endpoints | <= 1.1 x path tolerance |
| hermite segment count vs legacy | <= 0.45 x |
| loss splice, one dropped 8-segment packet | tempo error <= 30 ms, per-ms step < 8 us |
| corner splice with stretch | <= 2.0 mm off path |
| resync into a dwell | 0.00 mm excursion |
| laser gate timing | exact to +-4 ms |
| oversized packets after fit loop | 0 |

Soak. MockTransport with 1 percent injected drop and 50 ms latency jitter runs a ten-minute text job: `qd` stays 0, no deadman fires, beam-on error inside budget. The same scenario on real hardware is the manual acceptance for phase 3.

UI. Component smoke tests against the showcase route, and one Playwright pass over the built single file opened from file://: mock transport, plan text, run, pause, resume, stop, verify console output.

## 9. Tooling and style

pnpm workspaces. TypeScript strict in source; the published artifact is plain ESM JavaScript plus `.d.ts`, importable from esm.sh in a bare HTML file. ESLint rules enforce the boundaries: no DOM globals in core outside `/web`, no core internals in app components, and nothing in `src/ui` importing stores, session code, or laser-rig-core.

House style applies to code, comments, and UI copy: no em dashes or en dashes anywhere, no emojis, icons are Font Awesome or inline SVG. The comment culture ports with the code: the current source explains why at every decision that cost something, and the split moves those paragraphs with the logic they explain.

Zero runtime dependencies in laser-rig-core.

## 10. Phases

Phase 0, scaffold and capture. Monorepo, packages, CI, npm publish dry runs under `virgilvox`, the capture script, golden fixtures recorded from the current file. Acceptance: fixtures exist, trivial builds pass CI.

Phase 1, protocol and motion port. Packers, parsers, negotiation, geometry, planner, sampler, emitter, pure and against fixtures plus the reference model. Acceptance: golden vectors byte-identical, fidelity table green.

Phase 2, session and transports. Streamer, credit, backpressure, keepalive, deadman handling, WebSerial, WebBluetooth, MockTransport. Acceptance: soak green in CI, then the bench soak with `lost=0`, `qd=0` over ten minutes.

Phase 3, the theme layer. Tokens, both schemes, the component inventory, the showcase route. Acceptance: the showcase renders every component in both schemes, contrast checks pass, and the lint boundary proves `src/ui` imports nothing from below.

Phase 4, the app. Stores, composable, assembly, single-file build. Acceptance: the parity checklist fully checked against the built file opened from disk, side by side with today's tool: connect over serial and BLE, adopt board config both directions, jog, set origin, capture four corners, geometry and servo settings, Pan / Tilt trims, invert, pulse range, lead pan and tilt, dither toggle with folded explainer, text source with weight passes, SVG source, live draw, plan tuning fold, run dock with speed slider, frame the job, pause, resume, stop, e-stop, dry run, digital twin viewport, sim servo model, bounds warning, smooth-regime readout, console with raw protocol log, embedded firmware view and copy, and every log message the current tool produces.

Phase 5, stretch. Node CLI with a serialport transport, a web flasher via esp-web-tools, the WASHER round-LCD app reusing the engine, extraction of `src/ui` into its own package if and when that second app wants it, and a CLASP relay bridge exploration. None block release.

## 11. Open questions

1. Font delivery in the single file: remote Google Fonts with fallbacks (default), or base64 woff2 embedding for a fully offline bench at the cost of file size.
2. VT323 for the console: keep, or standardize the console on IBM Plex Mono.
3. Whether docs/PROTOCOL.md is generated from the ino header by a script (preferred, cannot drift) or maintained by hand.
