# App audit

`apps/studio` and the packages under it, read against what the two boards actually
accept. Every number below is measured, not estimated; the harness is described at
the bottom so the figures can be reproduced or disputed.

## The headline: pushing config did nothing on the washer

`session.ts collectConfig()` built its patch from the app's own vocabulary and
handed it to `device.push()`, which expects the SDK's board config field names. The
two share almost nothing:

| App said | Servo board wants | Stepper board wants |
| --- | --- | --- |
| `throwMm` | `distMm` | `throwMm` |
| `fieldW` / `fieldH` | `wallW` / `wallH` | `fieldW` / `fieldH` |
| `mountHMm` | `mountH` | not applicable |
| `invA` / `invB` | not applicable | `invX` / `invY` |
| `minA` / `maxA` | not applicable | `minX` / `maxX` |

The serialiser skips undefined fields, which is correct for a partial patch, so
nothing errored. What actually went on the wire:

```
WASHER   "CFG "                                       <- the entire push
DETENT   ["G 200 22 400 400", "U 1"]                  <- geometry and the limits FLAG
                                                         but not the inversions or
                                                         the limit VALUES
```

So on the servo rig "send to board" was a complete no-op, and on the stepper rig it
was half of one. After the fix:

```
WASHER   "CFG ww=400.0 wh=400.0 ds=200.0 mh=70.0 dit=1 ffp=3.0 fft=1.5"
DETENT   ["G 200 22 400 400", "I 1 0", "N -100 100 -50 50", "U 1"]
```

This bug hid itself. Connect adopts the board's stored config, so a lost write did
not present as an error at the time; it presented as the app reverting to the old
value on the next reconnect, which reads as the app forgetting rather than as the
push failing.

`packages/beam-link/src/config.contract.test.ts` now pins the contract: a patch that
means to set something must produce a line that sets it, and a patch of the other
board's vocabulary must not quietly look like success.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| APP-1 | high | Washer config push sent an empty `CFG ` line | fixed |
| APP-2 | high | Detent config push dropped inversions and limit values | fixed |

## Superseded: backlash compensation beats all of this

The table below was measured before the planner cancelled the servo's directional
bias, and it is left in place because the reasoning still holds and the numbers are
still what those settings do. But dither is no longer the answer.

A servo deadband is hysteresis, not a grid: the inner loop cuts the motor once the
error falls inside the band, so an axis stops a whole deadband short of a target it
approaches from below and a deadband past one it approaches from above. Which of the
two happens depends only on the direction of travel. That makes the miss a known,
signed quantity, and a known signed quantity can be subtracted instead of averaged
away. Machine tools have called this backlash compensation for a century.

Measured through the emitter and the firmware's own interpolator, ninetieth
percentile geometric error, dither off:

| drawing | none | compensated | |
| --- | --- | --- | --- |
| text, cap 23 | 2.47 mm | 0.29 mm | 8.6x |
| text, cap 58 | 6.56 mm | 0.52 mm | 12.7x |
| circle r45 | 2.11 mm | 0.19 mm | 11.2x |
| zigzag | 1.60 mm | 0.16 mm | 10.1x |

In the app, which measures through `simulate` rather than through the wire and is
therefore conservative: 1.96 mm with nothing, 1.35 with dither and feed, **0.60 with
compensation and feed**, and 1.47 with all three. The last figure is the important
one: compensation and dither do not stack. Compensation leaves the command already
correct and dither then adds noise around a good answer.

Dither also costs a servo that hunts continuously, drawing more current and audible
across a room. Compensation costs nothing to run.

### It moves the limit rather than removing it

Compensation is best on every preset, but it also flattens the difference between
them, and that is worth understanding rather than being surprised by:

| preset | deadband | none | dither | compensated |
| --- | --- | --- | --- | --- |
| 9g micro | 1.91 mm | 6.56 | 1.70 | 0.52 |
| 9g metal | 1.43 mm | 4.54 | 0.73 | 0.48 |
| standard | 0.96 mm | 3.14 | 0.94 | 0.34 |
| digital | 0.48 mm | 1.40 | 1.35 | 0.52 |

A digital servo with four times less deadband than the 9g scores the same once both
are compensated. The floor sits at 0.35 to 0.5 mm for every preset at every feed
from 5 to 80 mm/s, and the axis quantum is 0.239 mm, so the residual is about two
command steps.

Two other explanations were tested and rejected. Shorter wire segments do not move
it: 0.47 mm at a 0.30 mm emitter tolerance and 0.45 at 0.005, across a tenfold
change in segment count. Nor is it the lead term, which is helping rather than
hurting, since removing it doubles the error.

So with compensation on **the machine is quantisation limited, not deadband
limited**. That is why a better servo stops paying, and it is the reason the
resolution model now floors every strategy at two quanta rather than letting the
dither factor through: unfloored it claimed 0.18 mm for a digital servo where
measurement puts the error at 1.35 mm, which would have recommended an upgrade that
cannot deliver.

Getting below it needs sub-microsecond commands. Neither the wire format, which
carries whole microseconds, nor the firmware's `writeMicroseconds` can express that
today, though the ESP32's LEDC timer could. That is the next real lever on this rig
and it is not a planner change.

The two models disagree on the size of the win, 8.6x against 3.1x on the same input,
and the difference is real rather than noise: the emitter bakes the correction into
segment endpoints and the board's cubic carries it smoothly, where the simulator
applies a hard step at each reversal. The wire is what ships, so the wire figure is
the one to expect on the wall, and the preview under-promises. That is the right way
round for a preview, but it is a divergence and it is written down here so it is not
mistaken for a measurement error later.

## Why washer text plotted badly

Measured end to end: text to strokes, `planJob`, `emitSegments`, the firmware's own
Hermite playback at 2 ms, then the profile's servo model. Geometric error only,
because lag along a stroke is invisible and only departure from it shows. Text
"HACK.BUILD" at a 40 mm cap height, 9g micro preset, 152 mm throw.

The wire is not the problem. Played into a perfect actuator the whole chain lands
within **0.10 mm mean, 0.61 mm worst**. Everything below is the servo.

| Feed | Deadbands per frame | Dither | Lead | worst | p90 | mean | Job |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default | 1.31 | off | 0 | 7.43 | 5.13 | 2.55 | 6.9 s |
| 60 | 0.55 | off | 0 | 7.67 | 5.65 | 2.77 | 16.3 s |
| 40 | 0.38 | off | 0 | 7.56 | 5.58 | 2.78 | 23.4 s |
| 12 | 0.12 | off | 0 | 7.76 | 5.74 | 2.77 | 73.7 s |
| default | 1.31 | **on** | 3 | 6.81 | 3.53 | 1.78 | 6.9 s |
| 60 | 0.55 | **on** | 3 | 6.89 | 1.69 | 1.02 | 16.3 s |
| **40** | **0.38** | **on** | **3** | 7.09 | **1.47** | **0.78** | 23.4 s |
| 20 | 0.20 | on | 3 | 6.58 | 1.18 | 0.72 | 45.0 s |

Read the second block against the first. **Slowing down on its own is worth
nothing** (2.55 to 2.78 mean, i.e. slightly worse). That is the counterintuitive
result and it is the one that matters: a servo deadband is hysteresis, not a grid.
Below some error the motor is off, so it stops wherever it got to, and giving it
more time to do that changes nothing.

Dither breaks the hysteresis by keeping the motor always driven. But the mechanics
average the carrier over several servo frames, so dither only pays once the beam is
crossing well under one deadband per frame. **Each half is useless without the
other**, which is why they are now presented as one step in the guidance rather than
two independent knobs.

One deadband is 8 us, which is 1.91 mm on the target at this throw. The rig was
running at 1.31 deadbands per frame with dither off, which is the worst available
place to be.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| APP-3 | high | The dither checkbox fed only the local resolution estimate. It never reached the board, so it changed the app's prediction and nothing on the bench | fixed |
| APP-4 | high | No feed control existed, so there was no way to reach the regime where dither works | fixed, `machine.feedMmS` |
| APP-5 | medium | `caps.lead` rendered a number input with **no `v-model`**. A dead control that looked live | fixed |
| APP-6 | medium | Guidance told the operator to aim at or above 2.5 deadbands per frame. Measured, that direction is worse at every step: 2.62 db/frame gives 2.85 mm mean against 2.55 at 1.31. Reaching the fast smooth regime needs more slew than this rig has | fixed |

### What is left on the table

`worst` barely moves across the whole table, holding around 6.5 to 7.5 mm while p90
falls by a factor of 3.5. That is a small number of outlier samples, almost
certainly reversal overshoot at stroke corners, and it is not addressed by anything
above. p90 and mean are the honest "what you see" figures; the worst case is a
separate, unfinished piece of work.

## Both machines

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| APP-7 | medium | The speed slider is simulator pacing only: `setTimeout(tick, 16 / job.speed)` in `session.ts`. It never reaches the wire. Reasonable, but it reads as a machine speed control and is labelled as one | open |
| APP-8 | low | `caps.backlash` and `caps.coilRelease` render controls with no `v-model`, the same defect as APP-5, on the stepper rig | open |
| APP-9 | low | The dead man interval is never sent, so it is whatever the board defaults to. A safety timeout nobody is choosing | open |
| APP-10 | medium | Simulator mode bypasses `Device` rather than driving `MockTransport`, so the sim exercises a different path from real hardware and cannot catch wire level regressions like APP-1 | open |

## Reproducing the numbers

The harness is not committed; it is thirty lines against the built packages:

1. `textToStrokes("HACK.BUILD", { capMm: 40, tracking: 1, toleranceMm: 0.2 })`
2. `planJob(strokes, profile, { tolMm: 0.2, feedMmS })`
3. `emitSegments(tl, profile, { hermite: true, tolMm: 0.08 })`
4. Replay each segment as the firmware does: cubic Hermite on both axes over the
   same `T`, stepped at 2 ms, commanding `position + lead * velocity`
5. Feed each command through `profile.actuator().step(0.002, cmdA, cmdB)`
6. `profile.forward()` the ACTUAL axis pair and measure the shortest distance from
   each lit sample to the intended strokes

Step 4 is a hand copy of the firmware interpolator, which is the same drift risk
FW-6 describes. When the reference model in `packages/beam-core/src/testing` stops
being a stub, this harness should import it and become a committed test.
