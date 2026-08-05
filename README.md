# BEAM

Laser scanner control software: a wire protocol, a motion planner, a browser SDK,
and one control app that drives more than one kind of rig.

Two machines ship as profiles of one product, not as two applications.

| Profile | Rig | Board | Axis unit |
| --- | --- | --- | --- |
| `washer-servo` | 2 servo pan/tilt head, 405nm diode | ESP32-WROOM-32E | servo pulse microseconds |
| `detent-28byj` | 2 mirror scanner, 2x 28BYJ-48 on ULN2003, 405nm diode | ESP32-C3 SuperMini | half steps |

They are the same machine. Both are two degrees of angular aim plus a one bit beam
gate, pointed at a flat target some distance away, driven from a browser over USB
CDC or BLE. The geometry is one model with two parameter sets, which
`packages/beam-core/src/geometry/gimbal.ts` derives and
`gimbal.test.ts` proves against both original implementations.

Read [PRD.md](PRD.md) first. It is the governing document and it supersedes the two
earlier PRDs preserved under `originals/`.

## Status

Both machines work end to end in the app: content, planning, simulation, the wire,
and a 3D view that draws the real printed parts. Neither has been driven against
real hardware yet, so every accuracy figure in the docs comes from the profile's
actuator model rather than from a wall. `docs/handoff.md` says what to measure
first and what would falsify it.

Hosted, and it is the same self contained file you would download:
<https://virgilvox.github.io/hackbuild-beam/>. Web Serial and Web Bluetooth only
exist in a secure context, so the hosted copy drives hardware exactly as a local
file does.

```
pnpm install
pnpm check          # lint, house style, sketch layout, typecheck, invariants, tests
pnpm dev            # the app, http://localhost:5173
pnpm bench          # the engine bench and both original tools, http://localhost:8173
```

`pnpm bench` serves the **engine bench**: the merged engine running in a browser,
checked live against the two shipped implementations, with the geometry lattice, a
calibration solver you can paste captured corners into, and the wire format byte
for byte. It is a bench, not the app, and nothing in it drives a beam. The same
server hosts both original single file tools at their own URLs.

### Start here

| | |
| --- | --- |
| `docs/handoff.md` | state, what was learned, what is open, what to measure on real hardware |
| `docs/audit-app.md` | every app defect found, with measurements |
| `docs/audit-firmware.md` | both firmwares read against what the app assumes of them |
| `docs/invariants.md` | behaviours paid for on the bench, each with a named test |
| `PRD.md` | the governing document, superseding both original PRDs |

## Layout

```
packages/beam-core      profiles, geometry, calibration, planner, protocol, sim. Depends on nothing.
packages/beam-sources   content in, strokes out. Injected DOM primitives.
packages/beam-link      transports, device orchestration, streaming, safety.
theme/                  hack.build tokens, fonts, components. Imports no beam code.
apps/studio             the Vue 3 app. Builds a single HTML file that runs from file://
firmware/               shared headers plus one sketch per rig
hardware/               STLs, cut files, BOM
docs/                   invariants, parity, profiles (protocol, calibration and manual land with the port)
originals/              the two shipped tools, preserved as evidence
```

Dependencies point one way only and it is enforced in CI, not in review.

## Using the SDK

The library is framework agnostic and consumable from a plain page with no build
step. Vue appears only in `theme/` and in the app.

```js
import { Device } from "@virgilvox/beam-link";
import { WebSerialTransport } from "@virgilvox/beam-link/web";

const dev = new Device(new WebSerialTransport());
await dev.connect();          // classifies the board, picks the profile, adopts its config
dev.on("status", s => render(s));
await dev.run(plan);
```

Connecting never clobbers the board's stored setup. The board is the thing bolted to
the wall, so on connect it is the authority on how it is installed.

## Working on this

[docs/parity.md](docs/parity.md) is the M2 acceptance list: everything both shipped
tools do, so the merged app is checked against the record rather than against memory.
[docs/profiles.md](docs/profiles.md) is what adding a third rig costs.

[CLAUDE.md](CLAUDE.md) carries the working rules: authorship, house style, the
architecture boundaries, and the rule that a change to a behavior in
[docs/invariants.md](docs/invariants.md) changes its test and says why.

Two of those are worth repeating here because they surprise people:

- **No em dashes, no en dashes, no emoji, anywhere**, including UI copy and
  comments. This is a lint rule with teeth, not a style note.
- **The app sends nothing but a `?` probe until it has classified the board.** The
  two text vocabularies collide destructively: `ECHO 0` on a stepper board parses as
  `E` with an argument of zero and releases both coil sets.

## Safety

This drives a laser. The dead man, disconnect kill, keepalive, stall poke and
starvation gate live in the SDK rather than the app, so every consumer inherits
them. Do not move them up a layer.

## Licence

MIT. Icons are inline SVG derived from Font Awesome Free under CC BY 4.0; see
`theme/README.md`.
