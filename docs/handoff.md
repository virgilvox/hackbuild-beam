# Handoff

Where this is, what was learned, and what the next person should pick up. Written
at `165d78a`.

Everything below that claims a number was measured. Where a claim is a judgement or
a guess it says so, because the difference is the whole value of this document.

## State

`main` is green on CI and deploys itself to
<https://virgilvox.github.io/hackbuild-beam/> on every push. 458 tests, 196 files.
The single file build is 716 KB and opens from `file://` offline.

The hosted copy is the same artifact you would download, so there is no second web
build to keep in step. HTTPS matters beyond the padlock: Web Serial and Web
Bluetooth do not exist outside a secure context, so the hosted app drives real
hardware exactly as a local file does.

**Nothing here has touched a real rig.** Every figure comes from the profile's
actuator model. The models have been made to agree with each other and with the
firmware's own arithmetic, which is not the same as agreeing with a servo. First
contact with hardware is the most valuable thing anyone can do next, and the
section at the bottom says what to measure.

## The one thing to understand first

The washer rig's error is a fixed number of millimetres, not a fraction of the
drawing. So legibility is a ratio with a fixed numerator, and everything that
improved it did so by attacking the numerator or the denominator:

| lever | what it did | measured |
| --- | --- | --- |
| backlash compensation | cancels the deadband's directional bias | 6.56 mm to 0.52 mm |
| condensed face | narrower letters fit at a bigger cap height | 38 percent more cap |
| cap height honoured | the control had been doing nothing at all | it now sets the size |

The deadband is hysteresis, not a grid. The inner loop cuts the motor once the
error is inside the band, so an axis stops a whole deadband short of a target it
comes up to and a deadband past one it comes down to. Which of the two happens
depends only on direction of travel, so the miss is a known signed quantity and can
be subtracted rather than averaged away. That is `planner/backlash.ts`.

Dither, which was the previous answer, is superseded. It attacks the same bias
statistically and costs a servo that hunts continuously. The two do not stack:
together they measure worse than compensation alone.

## What changed the answer, and what did not

Worth reading before repeating an experiment. Each of these looked obviously right:

* **Point density does not matter.** Denser flattening cannot help, because the
  wire already describes the path far below the error: into a perfect actuator the
  whole chain lands inside 0.10 mm. Coarser does not help either, it just pays for
  its own chord error. Tested both directions.
* **Lifting the beam is not the cost.** The same zigzag cut into 1, 2, 7 and 14
  strokes measures 0.31 mm every time, once stroke rejoining is disabled so the
  split is real. The first attempt at this test was invalid because `joinTolMm`
  silently glued the pieces back together.
* **Corners are already the best part of the drawing**, 1.26 mm against 1.31 mm
  mid stroke, so the ILDA trick of inserting dwell points at corners buys nothing
  here.
* **Junction floor is worth nothing**, 0.78 against 0.81.
* **Slowing down alone is worth nothing** without dither, 2.55 against 2.78. This
  is the counterintuitive one and it is the first thing everybody tries.

## The current limit

With compensation on, the rig is **quantisation limited, not deadband limited**.
The floor is 0.35 to 0.5 mm on every servo preset at every feed from 5 to 80 mm/s,
and the axis quantum is 0.239 mm, so the residual is about two command steps.

That is why a digital servo with four times less deadband now scores the same as a
cheap one. The limit moved; it did not go away.

Getting under it needs sub-microsecond pulse commands. Neither the wire format,
which carries whole microseconds, nor the firmware's `writeMicroseconds` can
express that today. The ESP32's LEDC timer can, at roughly 0.06 us on a 50 Hz
frame. **That is the next real lever on this rig and it is a firmware and protocol
change, not a planner one.** It is scoped nowhere yet.

## Open, by how much it matters

### FW-6, high: the reference model is a stub

`packages/beam-core/src/testing/index.ts` is `export {}`. CLAUDE.md rule 5 calls it
the executable spec for the board and says any firmware change updates it in the
same commit, so the rule currently enforces nothing while reading as though it
does.

The one place firmware behaviour is executably pinned is `planner/emit.test.ts`,
which replays the wire through a **hand written copy** of the washer interpolator
living in the test file. That copy is exactly the drift the rule exists to prevent,
and it only covers the washer.

Port `serviceSegments` and the detent ISR into `testing/`, have `emit.test.ts`
import it, and the scratch harnesses described below can become committed tests.

### The two models disagree by design, and it is written down

`simulate()` and the emitter both apply compensation and they do not agree on how
much it buys: 3.1x against 8.6x on the same input. The emitter bakes the offset
into segment endpoints and the board's cubic carries it smoothly; the simulator
steps it at reversals. **The wire is what ships, so the preview under promises**,
which is the right way round. `docs/audit-app.md` has the detail. Do not treat the
gap as a bug to be closed without deciding which side is right first.

### APP-7 to APP-10 and FW-1 to FW-5

Listed with severities in `docs/audit-app.md` and `docs/audit-firmware.md`. The two
worth doing next are APP-10, simulator mode bypasses `Device` so the sim cannot
catch wire level regressions, and APP-7, the speed slider is simulator pacing only
but reads as a machine control.

### Not a finding, but owed

The single file build fetches Google Fonts at runtime. That breaks CLAUDE.md rule
4's offline promise and leaks visitor IPs. It works on Pages over HTTPS, which is
precisely why it would never get noticed there. Self hosting the five faces as
woff2 adds roughly 200 KB.

## Things that were broken and were not visible

Each of these passed every check in the repo while being wrong. They are listed
because the pattern is the lesson, not the individual bugs.

* **CI had never passed a single run.** `pnpm/action-setup` refuses a version given
  both in the workflow and in `packageManager`, and both were set, so every run
  since the initial commit died at step two. The red read as "new repo".
* **Config push was a no-op on the servo rig.** The patch was built from the app's
  field names and the serialiser is keyed on the board's; they barely overlap, so
  every field was undefined, every field was skipped, and the push went out as the
  bare string `CFG `. It hid itself, because connect adopts the board's config, so
  a lost write looked like the app forgetting rather than a failed write.
* **Cap height did nothing.** Text was normalised to a unit box and rescaled, so
  caps of 10, 40 and 80 mm all produced an identical drawing.
* **The dither checkbox never reached the board**, so it moved the app's estimate
  and nothing on the bench.
* **The profile was only rebuilt on connect**, so every installation control edited
  the app's opinion and not the model.
* **Two sketches shared a folder**, which the Arduino IDE compiles as one file. Only
  discoverable by trying to compile.

Guards now exist for the last one (`pnpm check:sketches`) and for the config
contract (`config.contract.test.ts`). The others are covered by tests. The general
lesson: this codebase's failures are overwhelmingly **controls that are not
connected to anything**, not logic that computes the wrong answer.

## Layout worth knowing

```
firmware/<machine>/       the sketch that machine runs, with its pinout
hardware/<machine>/       STLs, wiring, print settings, assembly order
packages/beam-core        geometry, planner, emitter, protocol, sim. Imports nothing
packages/beam-sources     content in, strokes out. Two faces: default and condensed
packages/beam-link        transports, device, safety
apps/studio               the Vue app
tools/pack-mesh.mjs       STLs and sim geometry into the packed meshes the app draws
tools/export-stl.mjs      the detent sim's geometry back out to printable STLs
```

Both rigs' 3D views draw the real parts. The washer's placement is pinned to
landmarks measured off laser-rig.html's own scene graph; the detent's is pinned
against its sim page's matrix code. See `rig-assembly.test.ts` and
`detent-assembly.test.ts`.

## Reproducing the measurements

The harnesses behind every number here were scratch files, not commits, which is
the honest state. They are about thirty lines each against the built packages:

1. `textToStrokes(...)` for content
2. `planJob(strokes, profile, { tolMm, feedMmS })`
3. `emitSegments(tl, profile, { hermite: true, backlash })`
4. replay each segment as the firmware does, cubic Hermite on both axes over the
   same `T`, stepped at 2 ms, commanding `position + lead * velocity`
5. `profile.actuator().step(0.002, cmdA, cmdB)`
6. `profile.forward()` the ACTUAL pair, then shortest distance to the intended
   strokes, ninetieth percentile

Step 4 is a hand copy of the firmware interpolator, which is the same drift risk as
FW-6. When the reference model stops being a stub these should import it and become
committed tests.

## First contact with hardware

The models have only ever been checked against each other. What to measure, in
order of how much it would tell us:

1. **Is the deadband 8 us?** Everything scales off it. Jog one axis in single
   microsecond steps and find how many it takes before the beam visibly moves,
   from each direction. The gap between those two answers is the deadband.
2. **Does compensation deliver?** It predicts roughly a tenfold improvement, which
   is a big enough claim to deserve a photograph. Draw the same text with
   `backlash comp` at 0 and at 100 percent and compare.
3. **Is the 0.24 mm quantisation floor real?** If it is, a digital servo will
   measurably fail to beat a 9g one once both are compensated, which is a strange
   enough prediction to be worth falsifying.
4. **Does the condensed face read better at the same line width?** It should, by
   about 38 percent more cap height.

If any of these disagrees with the model, the model is wrong and the number in the
profile should move, not the measurement.
