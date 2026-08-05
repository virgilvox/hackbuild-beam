# Invariants

Every entry here was paid for on a bench. Each one is a behavior that looked wrong,
got debugged, and now has a reason. Each becomes a named test.

**A pull request that changes one of these behaviors changes its test and says why
in the body.** Do not relax a budget to make a suite green.

Tags: `[both]` holds on every machine, `[washer]` is the servo pan/tilt rig,
`[detent]` is the two mirror stepper rig. A `[washer]` or `[detent]` tag means the
behavior is profile specific, not that it is unimportant.

Status: `pinned` has a test in this repo. `porting` is carried from the original
tool and is scheduled for M1. `open` is a known defect or an unresolved question.

**Numbers are permanent.** Once assigned, an invariant keeps its number forever. To
retire one, mark it `retired` and leave it in place; do not reuse the number and do
not close the gap. Numbers are cited from source comments, and renumbering silently
repoints every one of those citations at a different behavior. That has happened
once already: the registry was reorganised into sections, nine citations kept their
old numbers, and every one of them still resolved, to the wrong entry. Run
`pnpm check:invariants` to verify citations.

---

## A. Geometry and calibration

**INV-01 `[both]` `pinned`** The forward map and the inverse map are exact inverses,
including the home referencing and including whatever calibration is active.
Round trip error across the field is below 1e-9 mm.
*Cost:* the washer app once inverted its ik alone and ignored the home referencing
applied on top, so every angle came back through a mapping offset by
`atan(vOff/D)`. At a 6 in throw with the rig 70 mm up a 305 mm target that is 28
degrees, and the sim drew the whole design 159 mm from where the beam was going.
*Test:* `geometry/gimbal.test.ts`, `profiles/profiles.test.ts`.

**INV-02 `[both]` `pinned`** The two rigs are one geometric model with two parameter
sets. A pan/tilt head is `sepMm = 0`; a two mirror scanner is `vOffMm = 0`. The
merged model reproduces both shipped implementations to floating point noise.
*Why it matters:* if this ever fails, the profiles have diverged into two models
again and the shared planner is no longer honest.
*Test:* `geometry/gimbal.test.ts`.

**INV-03 `[both]` `porting`** Everything that computes speed, error or aim goes
through the one mapping funnel, so the calibrated quad participates in the speed
limits and not only in the aiming.
*Cost:* the washer app calibrated the aiming path and not the preview path, so
capturing four corners made the sim draw through a different mapping than the beam
was aimed with, and the picture came out warped against the design.

**INV-04 `[detent]` `pinned`** The four corner homography lands all four corners of a
deliberately skewed rig within one step, and rejects a degenerate corner set
(pivot magnitude below 1e-14) rather than solving it.
*Why:* a degenerate solve produces a map that looks plausible and aims a live beam
somewhere else.
*Test:* `geometry/homography.test.ts`.

**INV-05 `[detent]` `pinned`** The adjugate inverse stays unnormalised. Scale is
irrelevant because the result is used projectively, and normalising by the last
entry works for a well conditioned H and blows up as that entry approaches zero.
*Test:* `geometry/homography.test.ts`.

**INV-06 `[detent]` `pinned`** mm to steps to mm worst round trip stays inside 1.0 mm
across the field. Measured 0.289 mm on the bench geometry.
*Test:* `geometry/homography.test.ts`.

**INV-07 `[detent]` `pinned`** The corner residual is reported in millimetres on the
target, with both sides pushed back through the same solved map, so it is a real
distance on the wall and it captures the step quantisation too. Under about 0.3 mm
is a clean capture.

**INV-08 `[detent]` `porting`** Limits derived from four corners add a 4 step margin
outward and set limits on as a side effect.

**INV-09 `[both]` `porting`** Inversion is a wiring correction. It changes what the
hardware does and never transforms the preview.
*Cost:* putting inversion in the kinematics only ever affected mm moves, which is
why jog would not invert. On the stepper it lives at the firmware phase table; on
the servo, which has no phase table, it lives at the axis encoder, which is still
after all the geometry and therefore still invisible to the preview.

**INV-10 `[detent]` `pinned`** `DEG_PER_STEP` is computed from `360 / 4075.7728`, never
pasted as the rounded `0.0883266` from the firmware comment. The real value is
`0.08832680761793199` and the comment's figure shifts every step count.
*Test:* `profiles/profiles.test.ts`.

**INV-11 `[detent]` `pinned`** On the bench geometry, 60 mm right is 109 half steps and
60 mm up is 123. The difference is the mirror separation showing up: the X mirror's
lever arm is `throw + sep` while the Y mirror's is `throw`.
*Note:* `fwtest.cpp` T6 prints these and asserts nothing. That gap is closed here.
*Test:* `profiles/profiles.test.ts`.

---

## B. Wire format

**INV-12 `[both]` `porting`** Escape asymmetry: hermite packets escape `0xA4` through
`0xA7`, legacy flat and delta packets escape only `0xA5` through `0xA7`, because
firmware predating the hermite magic would mistranslate `A7 04`. Byte 0 is never
escaped.

**INV-13 `[both]` `pinned`** A magic byte restarts the framer only when no frame is
currently open.
*Cost:* the shipped sender does not escape a payload `0xA4` inside a legacy flat or
delta packet, and the shipped receiver restarts on any magic byte at any time. So an
ordinary pulse low byte of 164, a 164 ms duration, or a delta of -92 mis-frames a
perfectly good packet. Self limiting, since the restart consumes the tail and the
frame then times out or fails CRC while the sequence stays primed, but it costs the
packet. This is the one place sender and receiver disagree today.
*Compatible in both directions:* a genuinely lost opener still leaves a stale frame
to be abandoned by the 250 ms idle check, which was already the mechanism covering
that case.
*Test:* `protocol/spec.test.ts`.

**INV-13a `[both]` `pinned`** The magic byte is the only domain discriminator. A
pulse position is `uint16` and a step position is `int16`; no format carries both a
duration and an interval; no magic serves two domains.
*Why:* one mechanism with two meanings keyed by a version guess is exactly how the
escape asymmetry got in.
*Test:* `protocol/spec.test.ts`.

**INV-14 `[both]` `porting`** CRC8 is polynomial `0x07`, init 0, no reflection, no
final xor, over the unescaped bytes from the magic through the last payload byte.
A CRC failure keeps the sequence primed.
*Cost:* unpriming on CRC failure meant every corrupted packet silently deleted its
time from the drawing and the board ran ahead of the plan.

**INV-15 `[both]` `porting`** Packet counts are 8 hermite and 10 legacy, matching the
firmware framer's count validation exactly.

**INV-16 `[both]` `porting`** Escaping can grow a packet past one BLE write. Oversized
packets are never dropped: the fit loop hands segments back until the escaped packet
fits the 176 byte budget, and they ride the next packet with the sequence intact.

**INV-17 `[both]` `pinned`** The flags byte is bits, not booleans. Bit 0 is the beam
gate, bit 1 is planned. A planned travel move has bit 1 set and bit 0 clear, and the
serialiser and the ISR must agree on that in one byte.
*Test:* `protocol/spec.ts` constants; behavior test at M1.

**INV-18 `[detent]` `porting`** The text point format is `x,y,l` with an optional
fourth `iv` field, space joined, `S ` prefixed. A trailing comma for a missing `iv`
breaks the board parser.

**INV-19 `[both]` `pinned`** Duration in whole milliseconds is the universal timing
currency. A machine that paces in ticks derives its interval from the duration and
the segment's dominant axis delta. The conversion is too coarse for a single step at
a high rate, which is why the stall hunt diagnostic stays on the text path.
*Test:* `protocol/spec.ts` `durationToInterval`; range test at M1.

---

## C. Flow control and transport

**INV-20 `[both]` `porting`** BLE writes go with response through one serialised
writer. Without-response writes vanish silently the moment the radio queue
congests, and a vanished packet is dropped geometry under a lit laser.
*Cost:* the bench log that forced this rework showed `lost` jumping by 29 in one beat.

**INV-21 `[washer]` `porting`** Adaptive chunking: start at 180 bytes, drop to 20
stickily the first time a write is refused, resend what the refusal bounced, reset
to 180 on a new connection. The retry does not advance the cursor.

**INV-22 `[both]` `porting`** The emitter halts while more than 3 writes are in flight.
The write chain is serialised, so its depth is the transport's honest word on how
far behind the radio is running.
*Cost:* emitting into a lagging chain is how the board hears silence for a second
and then a burst: the dead man fires into a healthy plot and the late burst lands on
a queue nobody measured.

**INV-23 `[washer]` `porting`** The emit gate requires at least 6 free slots on the
projected credit `boardFree - sentSinceReport - pending.length`. Everything pooled
locally is also spending slots.

**INV-24 `[detent]` `porting`** The credit window requires `free >= batchMax + 8 = 14`
before sending a batch of 6 points, polls every 40 ms while blocked, and re-queries
with `?` after 25 consecutive blocked polls, which is one second of no progress.

**INV-25 `[both]` `porting`** Dropped segments are erased geometry and are never
silent. A rising drop counter is surfaced loudly.

**INV-26 `[both]` `porting`** Segments are flushed every tick rather than pooled until
more than a packet's worth has built up. A part filled packet is a small
inefficiency; a starved queue is a visible stutter.

**INV-27 `[washer]` `porting`** The buffer target is the maximum of the user's slider
and a transport floor: 240 ms on BLE, 140 ms on serial. The slider sets a
preference, the transport sets a floor.

**INV-28 `[detent]` `porting`** The board is never silent: it reports every 150 ms while
running or with a non-empty queue, and every 700 ms while fully idle, so a lost
notify cannot wedge the host waiting for a credit update that never comes.

---

## D. Playback and timing

**INV-29 `[both]` `porting`** Durations carry a residual across segments so millisecond
rounding never accumulates.
*Cost:* rounding each one independently lost up to half a millisecond a time, and
across several hundred segments that random walk put the beam gate as much as 15 ms
from where the plan wanted it.

**INV-30 `[both]` `porting`** A segment may never straddle a gate change, and the gate a
segment carries is the one at its start, held for the segment's whole duration.

**INV-31 `[both]` `porting`** Gate transitions come from an exact table, never from
sampling the pen state at segment ends.
*Cost:* a stroke shorter than the segment it sits inside reads the same at both
ends, off before and off after, with the whole stroke invisible in between. The full
stop in a line of text is exactly that stroke.

**INV-32 `[washer]` `porting`** Hermite tangent clamp: 3 chord slopes plus 24 us of
headroom over duration, per axis, applied to both departure and arrival tangents.
*Cost:* a corner splice went from 11.25 mm off path to 1.60 mm. Provably inert on
healthy segments, whose tangents sit near their chord slope and pass untouched.

**INV-33 `[washer]` `porting`** Legacy segments get chord tangents at both ends, so the
cubic collapses to exactly the straight line old senders expect.

**INV-34 `[washer]` `porting`** Loss stretch scales arrival velocity by
`originalDur / stretchedDur`. The hermite tangent term scales with duration, so
playing a stretched segment with the unscaled velocity bulges the splice off its
chord, beam on.

**INV-35 `[both]` `porting`** Sequence gaps stretch the survivor by
`gap * EMA(arriving wire durations)`, alpha one eighth, seeded from the job nominal,
capped at 60 s.
*Cost:* a single neighbour standing in for the lost segments was fine at two
segments per packet; at eight to a packet one bad sample got multiplied by eight and
the bench measured the plot running a tenth of a second off tempo from one drop.

**INV-36 `[detent]` `porting`** A planned segment executes the host's timing verbatim:
the firmware stacks no standstill ramp on top. First gap and max gap both stay at the
commanded interval rather than at the roughly 3x ramped value.

**INV-37 `[detent]` `porting`** Direction reversal on either axis restarts the ramp, so
the post-turn step gap is strictly wider than the cruise gap. Without it every corner
is a full rate reversal, which is where these motors skip.

**INV-38 `[detent]` `porting`** The backlash take-up is its own segment, beam off, at
the slower of the two rates, with the planned bit clear so it always gets the
firmware ramp. It happens at a reversal, which is exactly where speed costs steps.

**INV-39 `[detent]` `porting`** Long moves split so no segment exceeds 2000 steps on
the dominant axis. That split is what makes the int16 delta cast lossless, so the
split and the cast must ship together.

**INV-40 `[washer]` `porting`** The servo write cadence is 2 ms, not the 20 ms servo
frame.
*Cost:* two free running 20 ms clocks drift, so a matching write cadence lands a
write anywhere from just before a frame boundary to a whole frame early and the
latched value carries 0 to 20 ms of wander. Writing far faster than the frame costs
nothing and means whatever the servo latches is always the freshest value.

---

## E. Safety

**INV-41 `[both]` `porting`** Queued playback counts as life. The dead man fires only
on a lit beam, an empty queue and a silent link, and dumps the queue when it does.
*Why:* a board with half a second of trajectory in hand is executing recent
instructions, and dumping that queue because the link went quiet destroys geometry it
already held.

**INV-42 `[washer]` `porting`** The starvation gate cuts the beam within 300 ms when an
armed job runs dry, and zeroes tracked velocity.
*Why:* holding the beam lit at a dead stop burns a dot into the glow paint until the
dead man notices. The next segment relights it, because every segment carries its own
gate.

**INV-43 `[both]` `porting`** Stop ordering is flush then beam off, never the reverse.
*Cost:* sending only the gate and leaving the board's queue standing meant every
queued segment relit the beam and the board kept drawing an entire buffer of stale
frames while the app believed it was paused.

**INV-44 `[both]` `porting`** Any flush is paired with zeroing the client's assumed
arrival velocity and resetting the twin, because the board's own clear zeroes its
velocity. Every reset site must pair them: job start, pause, stall, dead man, dry
run, e-stop, flush.

**INV-45 `[both]` `porting`** The stop flag is checked before emission within a tick,
not after.
*Cost:* with the check at the bottom of the tick, an e-stop's flush could be followed
by one more burst of segments in the same tick, each carrying its own gate, and the
beam blinked back on after the kill.

**INV-46 `[both]` `porting`** A BLE disconnect kills the beam, flushes the queue and
re-advertises. There is no USB CDC equivalent, so the dead man is the only backstop
on a dead serial host.

**INV-47 `[detent]` `porting`** Keepalive polls every 2 s while the beam is manually
held on, inside the board's 5 s dead man, so a deliberate alignment hold is not cut.

**INV-48 `[washer]` `porting`** Idle keepalive polls once a second whenever connected;
the in-plot poll is every 1.2 s, inside the 1.5 s dead man. An operator jogging
corners sends no traffic for long stretches.

**INV-49 `[detent]` `porting`** Coils release after an idle timeout, because these
motors cook if a phase is left energised. Re-energising holds the last phase for
about 30 ms so the rotor pulls back into register before being asked to move.

**INV-50 `[both]` `porting`** The beam is driven off before anything moves at boot, and
before the actuators are enabled.

---

## F. Motion quality

**INV-51 `[washer]` `porting`** The emission error metric is time aware: plan versus
played at matched instants, through the full calibrated map, scoring the quantised
tangents that actually ship.
*Cost:* the old metric was purely spatial, so a segment lying along a straight stroke
measured zero error no matter how the speed varied inside it. The whole acceleration
ramp got flattened to one constant velocity and the lurch at every stroke start was
approved by the very check meant to prevent it.

**INV-52 `[washer]` `porting`** Steps per frame is a ceiling defaulting to 4.0. The
axis-alternating band, roughly 0.4 to 2.5 deadband steps per frame, is where two
independent hysteresis quantisers pop one axis at a time.
*Cost:* the first version held this at 1.0 on the theory that slower is smoother, and
the bench proved the opposite: a diagonal came out as pan-pop, tilt-pop, pan-pop, the
worst possible look, and slow with it.

**INV-53 `[washer]` `porting`** Dither is a symmetric alternating offset about the true
command, amplitude `round(deadband * 0.75)`, phase flipping once per servo frame,
applied to the live command at every write.
*Cost:* quantising onto a deadband sized grid is not symmetric about the command, so
the average walked toward the closer grid line and it was measurably worse than not
dithering at all. Freezing a snapshot of the command for the whole frame quietly
dropped the interpolator to 50 Hz, so the one setting meant to make lines finer was
making them steppier.

**INV-54 `[both]` `porting`** Everything geometric derives from one path tolerance in
target millimetres, not from its own hardcoded step. A fixed sample rate spends
detail evenly, which is exactly wrong: a straight run needs almost none and a tight
curve needs a great deal.

**INV-55 `[both]` `porting`** A corner where the beam switches state stays a real
vertex and is never filleted, or the beam lights part way round the arc and leaves a
hook on the wall.

**INV-56 `[both]` `porting`** The flatness test during simplification measures against
the last point actually kept, not the input neighbour.
*Cost:* on a gently curving run every vertex is nearly straight relative to the one
before it, so they were dropped one after another and a refined letter D collapsed
from 106 points to 11, turning the bowl into a chord straight through the letter.

**INV-57 `[detent]` `porting`** Diagonal interpolation keeps both axes moving together:
the Bresenham deviation in `2y - x` stays at or below 3 over a 200 by 100 move.

**INV-58 `[detent]` `porting`** Endpoint positions land exactly, with and without
backlash comp. After a reversal the physical position lags the logical by exactly one
lash, and returning restores it exactly.

---

## G. Config and identity

**INV-59 `[both]` `porting`** The board is the source of truth. Connect pulls the
board's stored setup first and adopts it; the app only pushes its own if the board
has none. The board is the thing bolted to the wall.

**INV-60 `[both]` `porting`** Persisting to flash is an explicit act. The washer rig's
implicit flash write on every config assignment moves behind an explicit persist at
M3, to match the stepper rig and to stop surprising the operator.

**INV-61 `[washer]` `porting`** The serial line buffer is at least 300 characters.
*Cost:* a config push with all four corners runs close to 200 characters and the old
120 cap was silently destroying exactly that line, which is why corner calibration
never seemed to stick on the board.

**INV-62 `[both]` `pinned`** Profile selection comes from the hello line plus the config
dump, never from a dropdown, and exactly one profile claims any given board. An
ambiguous or unclaimed board connects read only and asks.
*Test:* `profiles/profiles.test.ts`.

**INV-62a `[both]` `pinned`** **The app sends nothing but the probe `?` until the peer
is classified.** Not a config pull, not a report request, not a banner. This is a
safety rule, not tidiness.
*Cost:* the step firmware dispatches on the first character of the line and treats
the rest as arguments, so the two vocabularies collide destructively. Verified
against the shipped firmware: `ECHO 0` becomes `E` with rest `CHO 0`, which parses
as 0 and **releases both coil sets**. `M 1500 1500 0` becomes a millimetre move, a
full travel slam, unclamped because soft limits default off. In the other direction
`M 10 20 1` on a pulse board clamps to the corner **with the beam lit**.
*Not every collision is dangerous:* `PING` lands on `P` with an unparseable argument
and falls to the read-only corner dump rather than capturing a corner, and `FLUSH`
is simply unknown. `L 0` and `L 1` are identical in name, arity and meaning on both,
and are the one free command.
*The probe is `?`*, one byte, the status command in both protocols, and it can never
open a binary frame because `0x3F` is outside `0xA0..0xAF`. Never send `STATUS`: on
a step parser that is `S` plus `TATUS`, which enters the batch move path.
*Test:* `protocol/spec.test.ts`.

**INV-62b `[both]` `porting`** Lineage is read from the case of the status prefix:
uppercase `STAT ` is the pulse lineage, lowercase `st ` is the step lineage. Both
shipped apps already match case sensitively, so this costs nothing. Retries are
spaced 400 ms, chosen against the 250 ms framer idle abandon so a board that was
mid-packet when the probe arrived has cleared it.

**INV-62c `[both]` `porting`** BLE discovery filters on the Nordic UART **service
UUID**, never on the device name, and the advertised name is for display only.
*Cost:* the step app filters on a `DETENT` name prefix today, which cannot see a
`LASER RIG` board at all. Both firmwares advertise the service UUID.

**INV-63 `[both]` `porting`** Already flashed boards keep working. Both legacy hello
strings and all three BLE device names are accepted.

---

## H. Porting hazards

These are invariants because a naive port dies on them, silently.

**INV-64 `[detent]` `pinned`** Integer division in the motion core truncates toward
zero. `Math.trunc`, never `Math.floor`: the segment splitter divides negative
numerators, and `Math.floor(-7000 * 2000 / 9000)` is -1556 where C gives -1555. That
single step propagates through the remainder loop.
*Test:* `profiles/profiles.test.ts` covers `intervalFor`; splitter test at M1.

**INV-65 `[detent]` `open`** `lroundf` rounds half away from zero; `Math.round` rounds
half toward positive infinity. They disagree at negative half integers, and the
firmware and the browser app already disagree today because of it. A port that must
match the firmware needs `Math.sign(v) * Math.round(Math.abs(v))`.

**INV-66 `[detent]` `open`** The firmware is 32 bit float throughout and JS is double.
For the one step and 1.0 mm budgets there is headroom, but no assertion may be
tightened to exact equality across that boundary without wrapping intermediates in
`Math.fround`.

**INV-67 `[both]` `open`** The firmware uses the literal `57.2957795` for radians to
degrees while the browser uses `180 / Math.PI`. They differ at the ninth significant
digit, far below one step, but forward and inverse must not mix the two within one
round trip or the residual picks up an asymmetric bias.

**INV-68 `[detent]` `pinned`** `TICK_HZ` is one exported constant. It exists as three
literals across the original codebase: 20000 in the firmware, 20000 in the browser
with a comment saying it must match, and 10000 in the g++ harness.
*Test:* `constants.ts`, `profiles/profiles.test.ts`.

**INV-69 `[detent]` `porting`** Fixed width wraparound is load bearing. The tick,
interval, queue indices and drop counter are `uint16`; axis deltas are `int16`. A
faithful port masks rather than assuming JS number range.

**INV-70 `[both]` `porting`** The reference model must remain a deterministic fixed
rate loop. Every gap assertion counts ticks, not milliseconds, so a port to
`setInterval` or `requestAnimationFrame` cannot reproduce them.

---

## H2. Planner constraints, pinned before the planner exists

These came out of an adversarial review of the merged design and were verified against
the shipped code. They are written down now, before M1, because each one is a defect
the merged planner would otherwise ship on its first stroke.

**INV-79 `[both]` `porting`** Quantisation dedupes on **integer axis equality**, after
rounding, and it happens before the velocity profile sees the path.
*Cost:* the shipped stepper tool does exactly this
(`if (last && last.x === cx && last.y === cy && last.l === 1) continue;`). Without it,
a path densified at one quantum produces consecutive samples that round to the same
axis pair, giving a zero length axis segment. Then the speed cap computes
`rate * ds / |dq|` as `0 / 0`, and because `Math.min(400, NaN)` is `NaN`, that one
segment poisons the entire velocity profile: every cap, both sweeps, and the timing
integration all become `NaN` and the job never advances.
*The dedupe is on integer axis equality, not on millimetre proximity.* A millimetre
dedupe at 0.02 mm does not catch it, because the stepper quantum is 0.55 mm.

**INV-80 `[both]` `porting`** A zero length axis segment contributes no constraint,
never a `NaN`. Where the gain is below an epsilon the limit is `Infinity`, which is
what the shipped servo tool does: `const k = degPerMm(a,b); return k < 1e-9 ? Infinity : ...`.
Both guards, INV-79 and this one, must ship; either alone leaves a hole.

**INV-81 `[detent]` `porting`** The feed cap is expressed in the unit the machine was
tuned in. The stepper paces its dominant axis, so a diagonal runs at up to root two
the linear feed in millimetres per second, deliberately, with no cross axis
normalisation.
*Cost of getting it wrong:* expressing the cap as `feed_mm * gain` makes every
diagonal about 1.42 times slower than the shipped tool, for no safety benefit,
because pull-out is a **step** rate and the dominant axis is already at it. The
user's rate setting is in steps per second and the conversion to millimetres per
second is not axis independent, so a round trip through millimetres silently loses
the bench tuning. Where both a millimetre feed and a step rate apply, take the
minimum, and keep the profile's native unit as the one the operator sets.

**INV-82 `[washer]` `porting`** End of job drain. The beam is not cut until the board
has actually finished: local lead at or below 5 ms **and** the board's queue drained,
bounded by a 2000 ms wait polled at 40 ms.
*Cost:* a board that stretched segments to cover lost packets is still playing a
tail, so cutting the beam when the host's timeline ends lands the cut in the middle
of the last stroke. The stepper equivalent is a drain poll that returns as soon as
the queue is empty and nothing is running.

**INV-83 `[washer]` `porting`** In the frame fallback path a frame is dropped for
backpressure **only if it does not change the beam gate**. Gate changes always go
out. This is a safety property, not an optimisation.

**INV-84 `[both]` `porting`** Adopting board config honours a stored "calibration on"
flag only if at least one corner actually arrived.
*Cost:* a board that stores the flag with a truncated config line would otherwise
enable a calibration that has no corners behind it.

**INV-85 `[washer]` `porting`** The live speed override scales **timeline** spans while
the wire duration stays in real milliseconds:
`exactMs = (nextT - emitT) * 1000 / speed + residual`. Getting the division the wrong
way round turns the speed slider into a tempo bug.

---

## I. Known stale fixtures and open defects

**INV-71 `[detent]` `open`** `fwtest.cpp` claims to be copied verbatim from the
firmware and has drifted on four counts: tick rate 10000 against the shipped 20000,
an older limits struct, a `writeLaser` that no longer matches, and a `stepAxis`
without inversion. Its reference tick gaps of 23 and 41 are rate dependent and are
not directly comparable to anything the shipped board does.
*This is exactly what the same-commit sync duty exists to prevent.* Resolution at M1:
re-derive at 20 kHz, or freeze it explicitly as a record of an earlier revision.

**INV-72 `[detent]` `pinned`** The `h.txt` fixture that `fwtest2.cpp` requires is
missing from the tree. Recovered from `audit_test.py` and committed as the bench
homography in `geometry/homography.test.ts`.

**INV-73 `[detent]` `open`** Coil re-energise settle is untested: the harness
initialises the coils live where the firmware ships them released, so the path never
executes under test.

**INV-74 `[detent]` `open`** Queue-full behavior is untested. The drop counter is
incremented but no harness ever fills the queue or asserts on it.

**INV-75 `[detent]` `open`** The backlash simulator and its spread metric are the
highest value untested unit in the original app: they are read by the preview on every
rebuild and asserted on by nothing.

**INV-76 `[detent]` `open`** Soft limit clamping is silent. There is no warning line
when a move is clipped, so the host can only detect clipping by comparing its
intended target against the reported position.

**INV-77 `[detent]` `open`** The logical position is advanced to the full target before
the split loop, so a queue-full part way through a split leaves logical position ahead
of reality until the next home or stop.

**INV-78 `[both]` `open`** The pull-out derating factor is documented as 70 percent in
one place and 60 percent in another. The profile carries one number and it is 70, the
figure the working tool prints. To be settled on the bench.

**INV-86 `[washer]` `open`** **Trim pan and trim tilt currently do nothing.** Two UI
controls with no effect on where the beam goes.

They appear in exactly two places in the shipped app, `ik` and `fk`, and both consume
them as a difference that cancels them exactly:

```
wallToAngles: pan = homePan + (ik(wx,wy).pan - ik(0,0).pan)
              ik(wx,wy).pan = 90 + ps*atan2(wx,D)*RAD + trimPan
              ik(0,0).pan   = 90 + 0              + trimPan
              difference    = ps*atan2(wx,D)*RAD          <- no trim
```

`fk` cancels them the same way, by adding `a0.pan` (which contains the trim) and then
subtracting the trim again. `sweepDeg` is also a difference of two `ik` calls, so it
cancels there too.

Verified numerically against the shipped functions: with `trimPan = 5` and
`trimTilt = -3`, the aim is identical to trim of zero at every probe including a
`(150, -150)` corner, to ten decimal places.

The only path by which trim can affect anything is the `clamp(p, 0, 180)` inside `ik`
biting asymmetrically at extreme angles, which is a clipping artifact rather than a
calibration offset and is certainly not the intent.

**What the merged profile does:** applies trim absolutely, at the axis encoding step,
which is what the control obviously means. **This is a deliberate deviation from the
shipped behavior and it is the one place the port does not reproduce the original.**
Flagged here rather than silently, because "port, do not rewrite" is a stated
principle and this is the exception.

**Open question:** the bench may have been compensating for a real mounting error some
other way, in which case turning trim on will move an already-calibrated rig. First
plot after the port should be run with trim at zero.
