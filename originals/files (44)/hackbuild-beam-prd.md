# hackbuild-beam PRD

Repo: `github.com/virgilvox/hackbuild-beam`
Version: 0.1 draft, 2026-08-01
Owner: Moheeb Zara (virgilvox)

## Summary

Beam is laser scanner control software: a wire protocol, a motion planner, a browser SDK, and a control app for cheap two-mirror galvo rigs. It exists today as two files, `detent-plot.html` and `detent_firmware.ino`, that grew a protocol (v1.3), four-corner projective calibration, a trapezoidal speed planner with junction lookahead, backlash modeling, a firmware-accurate simulator, and importers for text, SVG, images, and live sketching. All of it is tested and working.

This PRD turns those two files into a monorepo with a published JavaScript library, a Vue app, and the hack.build design language extracted as a shared theme the whole repo draws from. The repo also becomes the home for the firmware.

## Naming

The repo is `hackbuild-beam`. The product is BEAM. The wordmark follows the hack.build family style.

DETENT does not disappear. It becomes the reference machine: the shipped machine profile is `detent-28byj` (2x 28BYJ-48, ULN2003, 405nm diode). Beam is the software, machine profiles describe hardware. Future rigs (TMC bipolar mod, RGB head) are new profiles, not new apps.

npm packages publish under the `@virgilvox` scope for now. Package names are chosen so a later move to a `@hackbuild` org is a scope swap, nothing structural. Firmware identifies as `beam 1.3` and the app accepts the older `detent` hello string, so already-flashed boards keep working.

## Goals

1. One repo containing library, app, firmware, and docs, with CI that proves all of it on every push.
2. A JavaScript SDK anyone can use to drive a Beam machine from their own page or script, without the studio app.
3. The hack.build theme as one central, reusable implementation: tokens, fonts, and components that live once in the repo and travel to other hack.build tools by copying a folder.
4. Feature and behavior parity with the current single file, verified by the existing test suites ported into the repo.
5. Keep the thing that makes these tools good: a single HTML file you can hand someone that runs from `file://` with no server and no install.

## Non-goals

- No cloud, no accounts, no telemetry, no server component.
- No TypeScript rewrite. Plain ESM JavaScript with JSDoc annotations.
- No CONDUYT integration in v1. Beam keeps its own plain-text protocol. A CONDUYT bridge is a possible later package, not this one.
- No TMC2209 step/dir firmware in v1. That lands with the SPINDLE v6 board under its own PRD. This repo is structured so it slots in as a firmware variant and a machine profile.
- No G-code. Beam's command stream is its own format, and importers translate into it.

## Users

- Moheeb, running and evolving the rig.
- Hackerspace folks building the published rig from the STLs and BOM, who need flash, calibrate, plot to be a twenty minute path.
- Developers embedding beam control in their own pages, who need the SDK without the app.
- Other hack.build tools (KERF, PLATEN, SPIGOT and friends), which vendor the theme folder only.

## Principles

These are constraints, not preferences.

1. The board is the source of truth. Connect adopts board config. Pushing config is always an explicit act. This rule came out of a field audit and it stays.
2. The single-file build is a first-class release artifact. Fonts and icons ship inside it. It must work offline from `file://`.
3. Pure logic never touches the DOM. Anything that needs `DOMParser` or a canvas takes injected primitives so it still runs headless under test.
4. Safety behaviors (dead-man, disconnect kill, keepalive, stall poke) live in the SDK, not the app, so every consumer of the SDK gets them.
5. House style applies to everything generated: no em dashes or en dashes anywhere including UI copy and code comments, no emoji, icons are inline SVG.

## Architecture

Three packages, one shared theme, one app, one firmware tree. The seams follow environment boundaries, not file size.

| Package | Contents | Environment | Depends on |
| --- | --- | --- | --- |
| `@virgilvox/beam-core` | Constants, protocol codec, kinematics, homography, planner, stroke ops, machine simulator | Pure JS, runs anywhere | nothing |
| `@virgilvox/beam-sources` | Stroke font, 3D wireframe models, SVG importer, image raster, calibration patterns, sketch model | JS with injected DOM primitives | beam-core |
| `@virgilvox/beam-link` | WebSerial, WebBluetooth, and mock transports, Device orchestration, streaming, safety behaviors | Browser (mock works in node) | beam-core |
| `theme/` (not a package) | hack.build tokens, fonts, grain, Vue components, icon set | Browser, Vue 3 | nothing beam-related |

Dependency rules are enforced in CI: core imports nothing, sources and link import only core, the theme imports no beam code, and the app imports the three packages plus the theme. If a change wants to violate this, the change is wrong.

### @virgilvox/beam-core

The heart. Everything here is deterministic and testable in node.

- `constants.js`: `TICK_HZ`, steps per rev, degrees per step, protocol limits.
- `protocol.js`: command builders (`cmdMove`, `cmdBatch`, `cmdLimits`, `cmdMapping`, and so on) and a line parser that turns `st`, `qc1..qc4`, `ok`, `err`, `warn` lines into typed events. One place defines the wire format; firmware comments point here.
- `kinematics.js`: the two-mirror model in (u, v) tangent space, mm to steps and back, the ideal model and the measured homography, `solveHomography` (8x8 Gauss-Jordan) and its adjugate inverse, quad aspect.
- `planner.js`: quantise to step commands, trapezoidal profile with junction lookahead, per-point intervals, runtime estimate.
- `strokes.js`: centerFit, scaleToField, travel reordering, unidirectional approach.
- `sim.js`: the virtual machine. Executes a command stream the way the firmware does: queue, ramp behavior, planned interval passthrough, backlash hysteresis, coil settle. Produces beam traces for preview and for tests.

The simulator is the load-bearing piece. The current g++ harness proved firmware behaviors (reversal ramp gap widening, planned intervals executed verbatim, lash return positions, exact endpoints). Those assertions port into vitest against `sim.js`, so the behaviors that took an audit to get right are pinned forever.

```js
import { solveHomography, mmToSteps, planSpeeds, quantise, Sim } from "@virgilvox/beam-core";
```

### @virgilvox/beam-sources

Content in, strokes out. Every source returns the same shape: an array of polylines in mm, plus flags like `noReorder` for raster.

- `font.js`: the stroke font, A to Z, digits, punctuation, adaptive curve flattening.
- `models3d.js`: cube, tesseract, icosahedron, torus knot, sphere, lissajous, with projection.
- `svg.js`: the importer. Full path grammar (M L H V C S Q T A Z, relative and absolute), shapes, nested groups, transforms, y-flip. Takes a `parseXml` function as an argument; the app passes `DOMParser`, tests pass a shim.
- `raster.js`: image to serpentine dashes at step resolution, threshold, pitch, invert. Takes a grayscale buffer, not a canvas; the app does the canvas sampling.
- `patterns.js`: lash gauge, ruler, square, rate ramp, and the stall hunt leg builder with its accel profiles.

### @virgilvox/beam-link

The SDK. This is what someone installs to drive a machine from their own code.

- `transports/`: `WebSerialTransport`, `WebBleTransport` (NUS, accepts BEAM and DETENT device names), `MockTransport` wrapping a `Sim` so the full stack runs headless.
- `device.js`: connect, adopt board config on connect, explicit `push()` and `persist()`, typed events for status, config, warnings.
- `stream.js`: credit-window streaming against the board's `free=` reports, batch building with per-point intervals, the stall poke, progress events.
- `safety.js`: keepalive while the beam is manually held on, laser-off on disconnect, the client half of the dead-man contract.
- `hunt.js`: the stall hunt runner.

```js
import { Device, WebSerialTransport } from "@virgilvox/beam-link";

const dev = new Device(new WebSerialTransport());
await dev.connect();          // adopts board config, never clobbers it
dev.on("status", s => render(s));
await dev.stream(cmds);       // planned intervals, flow control, progress
```

### theme/

The hack.build punk zine language, deliberately not a package. It lives once at the repo root and everything in the repo draws from it. Other hack.build tools adopt it by copying the folder, which is how these tools already travel.

- `tokens.css`: paper `#f5f0e6`, ink, pink `#FE0386`, paper-dark, spacing, the block shadow, zero border radius.
- `fonts/`: subset woff2 of Permanent Marker, Special Elite, VT323, IBM Plex Mono, Libre Baskerville, self-hosted, all OFL or Apache licensed. No Google Fonts requests at runtime.
- `grain.css`: the noise overlay.
- `components/`: `HbHeaderBar`, `HbPanel` (collapsible group), `HbButton` (default, primary, danger, active), `HbField`, `HbRange`, `HbToggle`, `HbKv`, `HbNote`, `HbConsole`, `HbOverlay`, `HbBadge`, `HbIcon`.
- `HbIcon` is a curated inline SVG set covering the thirty or so glyphs the tools use, sourced from Font Awesome Free with CC BY 4.0 attribution in `theme/README.md`. Inline SVG keeps the single-file build small and offline.

Apps import it through a Vite alias, so nothing in an app changes if it ever does become a package:

```js
import "@theme/tokens.css";
import { HbPanel, HbButton, HbKv } from "@theme/components";
```

`theme.html` ships as a second Vite entry in the studio build: a page that renders every component and doubles as the visual regression fixture.

### apps/studio

The Vue 3 replacement for `detent-plot.html`. Vite, Pinia, no router.

Stores: `device` (connection, adopted config, status), `project` (source, content parameters, strokes, planned commands), `calibration` (corners, mapping, residual, aspect), `log`.

Panels map one to one from the current app: rig geometry, motion, limits, four corners, test patterns, content, path, run, console. The target plane and scanner canvases stay hand-rolled 2D, ported as components that read from stores. The manual overlay renders `docs/manual.md` imported raw at build, so the docs and the in-app manual are one source.

Two build outputs from one codebase:

1. Static site deployed to GitHub Pages, with the mock transport wired to a demo button so the whole app is usable with no hardware.
2. `beam.html`, a single file via `vite-plugin-singlefile` with fonts and icons inlined, committed to releases. Works from `file://`. Chrome treats `file://` as a secure context, so WebSerial and WebBluetooth work there.

Target for the single file is under 900 KB. Font subsetting is what makes that possible.

### firmware/

- `firmware/beam/beam.ino`: the current firmware renamed, protocol continues at 1.3, BLE advertises BEAM. Arduino IDE remains the canonical build for the audience; a `platformio.ini` sits alongside for CI and for anyone who prefers it.
- `firmware/motortest/motortest.ino`: the bare-metal pin walk sketch, unchanged.
- `firmware/README.md`: flashing (ESP32-C3 SuperMini BOOT plus RST dance, USB CDC On Boot must be Enabled, ULN boards unplugged while flashing), pin map, protocol reference generated from the same table as `protocol.js` docs.

### hardware/

STLs, cut files, BOM, and the SPINDLE shield notes move in under `hardware/detent-28byj/`, or link out to their current home if moving them is churn. Decision at M0; the layout reserves the folder either way.

## Repo layout

```
hackbuild-beam/
  package.json              private, pnpm workspaces
  pnpm-workspace.yaml
  packages/
    beam-core/
    beam-sources/
    beam-link/
  theme/
    tokens.css
    grain.css
    fonts/
    components/
  apps/
    studio/
  firmware/
    beam/
    motortest/
  hardware/
    detent-28byj/
  docs/
    protocol.md
    calibration.md
    speed.md
    manual.md
  .github/workflows/
    ci.yml                  vitest, playwright, lint, dependency rules
    firmware.yml            arduino-cli compile for esp32c3
    pages.yml               studio static deploy
    release.yml             changesets publish with npm provenance
```

## Tooling

- pnpm workspaces. No turbo until the build is slow enough to need it.
- Packages ship untranspiled ESM with `exports` maps. No build step for the library, which also makes them consumable from esm.sh the way conduyt-js is.
- vitest for packages, Playwright for the app.
- eslint flat config plus prettier. A custom lint rule bans em dashes, en dashes, and emoji in source and UI strings, because house style is a build failure, not a review comment.
- changesets. The three `beam-*` packages version in lockstep. The theme has no version; it travels with the repo.
- MIT license across the repo.

## Testing

Port, do not rewrite. The current suites encode audit findings.

From the g++ harness into `beam-core` sim tests: endpoint exactness with and without lash, lash return positions, diagonal deviation under one step, reversal ramp gap widening (cruise 23 ticks, post-turn 41 in the current build), planned intervals executed verbatim with no auto ramp stacked, limit clamping, segment splitting.

From the kinematics harness: homography lands all four corners of a deliberately skewed rig exactly, worst round trip under 0.3 mm across the field, degenerate corner sets rejected.

From the Playwright suites into app e2e: adopt-on-connect populates every control from a `qc` dump, invert changes hardware and never the preview, corner capture and solve and limits-from-corners flow, planner slows into corners and strips intervals when off, SVG and raster and sketch produce plottable strokes, clip banner appears when limits cut content, no horizontal scroll at 1100, 1400, and 1920 wide.

Firmware CI compiles for `esp32:esp32:esp32c3` on every push. It cannot run motion, but it can never ship a firmware that does not build.

## Milestones

| Milestone | Deliverable | Acceptance |
| --- | --- | --- |
| M0 scaffold | Workspaces, CI green, theme extracted with its demo entry | Lint, dep rules, and an empty test pass on all packages |
| M1 parity | Studio replaces detent-plot.html, firmware renamed, tests ported | Every behavior in the Testing section passes; `beam.html` single file works offline from `file://` against real hardware |
| M2 publish | 0.1.0 on npm, READMEs, Pages demo with mock transport | `npm i @virgilvox/beam-link` and the SDK snippet above drives a board |
| M3 projects | `.beam.json` project export and import, example gallery | A saved project round-trips through export, reload, plot |
| M4 hardware track | Step/dir firmware variant flag, SPINDLE v6 hooks | Separate PRD; this repo only reserves the profile seam |

M1 is the gate that matters. Nothing publishes until the single file and the SDK both drive the physical rig through a full calibrate-and-plot session.

## Risks

- Single-file weight. Mitigation: font subsetting, inline SVG icons, no runtime CDN.
- WebBluetooth notify drops already bit us once. The dead-man, heartbeat, and stall poke contract is pinned by tests on both sides of the wire.
- Two firmware build paths drifting. Mitigation: the `.ino` is the single source; PlatformIO builds the same file.
- Scope migration to a future `@hackbuild` org. Mitigation: no deep imports in docs or examples, package names identical across scopes.
- Theme folder tempted into app-specific components. Mitigation: the no-beam-imports rule in CI and the demo entry that renders every component in isolation.

## Open questions

1. Do the STLs and shield files move into `hardware/` at M0, or stay put and link? Moving them makes the repo the one true home; staying avoids breaking existing links.
2. Generated `.d.ts` from JSDoc at publish time, or ship untyped for 0.x?
3. Does the Pages demo autoload the mock transport, or hide it behind a button so nobody mistakes the sim for a connection?
