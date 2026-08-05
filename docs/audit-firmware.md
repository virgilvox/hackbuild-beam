# Firmware audit

Both sketches, read line by line against what the app assumes of them. Date of
audit: the commit that added this file.

Short version: **both firmwares are in better shape than the app that drives them.**
Every defect found below is either a missing test or a gap between what the firmware
offers and what the app bothers to use. Neither board is doing anything wrong.

## The question that prompted this: does either rig move both axes at once

Yes, both, and by different mechanisms.

**WASHER** plays each segment as a cubic Hermite evaluated on **both axes over the
same `T`** (`serviceSegments`). Pan and tilt are always advancing together, so a
diagonal is a diagonal. The curve starts from the position and velocity the board
really has and lands on the endpoint and endpoint velocity the packet carries, so
position and velocity are both continuous across every boundary and a dropped
packet gets spliced over by a smooth reroute rather than a straight line lurch.

Servos are written every **2 ms**, not on a 20 ms frame boundary. The comment
explaining why is worth keeping: two free running 20 ms clocks drift against each
other, so a frame aligned write lands anywhere from just before a boundary to a
whole frame early and the latched value carries 0 to 20 ms of wander with it.

**DETENT** steps **Bresenham** in a 20 kHz timer ISR: the dominant axis steps every
`interval` ticks and the error accumulator carries the subordinate axis along the
same line. Both axes advance together by construction.

So staircasing on the washer is not a coordination failure. It is the servo
deadband, and the fix is in the app: see `docs/audit-app.md`.

## WASHER, firmware/washer-servo

### Correct and worth not breaking

- **Coordinated Hermite**, above.
- **Tangent clamp.** Endpoint tangents are capped at three chord slopes plus 24 us
  of headroom, per axis. A healthy segment passes untouched; a splice across a big
  hole starts from a real velocity that can dwarf the stretched chord, and a cubic
  handed a tangent several times its chord swings far outside it. The cap bounds the
  whole curve to about 1.4 chords, so the damage a bad splice can do stays
  proportional to the gap it covers.
- **Continuity is a claim, not a default.** `cont` requires the chain flag AND that
  less than 250 ms has passed since the last segment ended. Velocity is zeroed
  otherwise, because a velocity tracked before a gap describes a trajectory that no
  longer exists.
- **No drift.** A chained segment starts its clock at the previous segment's
  intended end, not at `now`, so a long job does not accumulate a millisecond per
  frame.
- **Starvation gate.** Job armed, beam lit, queue dry for 300 ms, gate closes.
  Without it a stalled sender burns a dot into the glow paint while the dead man
  runs down.
- **Dither is symmetric.** The header records that quantising onto a deadband sized
  grid was tried first and measured *worse than not dithering*, because it is not
  symmetric about the command and the average walks toward whichever grid line is
  nearer. The shipped version is a plain alternating carrier and leaves the command
  where the planner put it.
- **Dither rides the live command.** An earlier version froze a snapshot per frame,
  which silently dropped the interpolator to 50 Hz whenever dither was on: the one
  setting meant to make lines finer was making them steppier.

### Findings

| # | Severity | Finding |
| --- | --- | --- |
| FW-1 | medium | `LEAD`/dither are configurable and were never configured. Not a firmware defect; recorded here because the firmware is where the capability lives. Fixed app side |
| FW-2 | low | `persist` is implicit: the firmware commits to flash on every `CFG` assignment. The SDK's `persist()` says so and returns false. Harmless, but it means there is no way to try a setting without keeping it |
| FW-3 | low | Dead man default is 1500 ms and the app never sets `dm`. Fine, but it is a safety number nobody is choosing deliberately |

## DETENT, firmware/detent-28byj

### Correct and worth not breaking

- **Bresenham in a 20 kHz ISR**, above.
- **Ramp from standstill, and reversal restarts it.** The gear train has slop and a
  cold start straight into full rate is where these motors skip; so is a full rate
  direction reversal at a corner. Interval starts 3x long and eases in linearly.
- **Planned segments bypass the ramp.** `laser & 2` marks a segment the planner has
  already velocity shaped, and a second ramp on top of it just makes the corner
  slower than asked. This is INV-83's firmwareRampBypassed capability.
- **Coil release with a re-register hold.** Idle releases both coil sets; re-energise
  holds the last phase for about 30 ms so the rotor pulls back into register before
  being asked to move.
- **The gearbox constant is computed, not pasted.** 4075.7728 half steps per output
  revolution from 63.68395:1, not 64:1.

### Findings

| # | Severity | Finding |
| --- | --- | --- |
| FW-4 | medium | A skipped step is silent and unrecoverable. There is no encoder, so pull-out is found by the stall hunt and then trusted. The app does not warn when a configured rate is near the documented 1000 half steps per second ceiling |
| FW-5 | low | `settle` is a tick counter (`TICK_HZ / 33`), so the re-register hold is tied to the ISR rate. Changing `TICK_HZ` silently changes a mechanical dwell |

## The reference model rule is not being enforced

`CLAUDE.md` rule 5:

> The firmware reference model in `packages/beam-core/testing` is the executable
> spec for the board. Any firmware change updates the model in the same commit.

**`packages/beam-core/src/testing/index.ts` is `export {}`.** Its own header says
`PORT STATUS: scaffold`. So the rule currently binds nothing, and the sentence in
CLAUDE.md reads as though a spec exists when it does not.

This matters more than it looks. The one place firmware behaviour is executably
pinned today is `packages/beam-core/src/planner/emit.test.ts`, which replays the
wire through a **hand written copy** of the washer interpolator living in the test
file. That copy is exactly the "copied verbatim" drift the rule was written to
prevent, and it only covers the washer.

| # | Severity | Finding |
| --- | --- | --- |
| FW-6 | high | The reference model is a stub, so rule 5 is unenforceable and the emit test's private copy of the interpolator is free to drift from both firmwares |

Recommendation: port `serviceSegments` and the detent ISR into
`packages/beam-core/src/testing` as the model, and have `emit.test.ts` import it
rather than keeping its own copy. Until then, treat CLAUDE.md rule 5 as aspirational
and say so in the rule.
