# Adding a machine

BEAM drives more than one kind of rig, and adding a third should be a profile, not a
fork. This is what that costs.

## What a profile is

A `MachineProfile` is the only thing in the system that knows what kind of machine
is on the other end of the wire. Everything above it is unit blind:

- The **planner** works in generic axis units and time. It never learns whether a
  unit is a microsecond or a half step.
- The **sources** never knew in the first place. They emit polylines in target
  millimetres.
- The **link** only cares which packet formats the board negotiated.
- The **app** renders panels off capability flags.

So a new rig touches one file plus a test, and nothing else.

## The four things that differ

Everything else about a two axis aiming machine turned out to be shared. When you
write a profile you are answering these four questions and no others.

| Question | washer-servo | detent-28byj |
| --- | --- | --- |
| What does an axis count in? | pulse microseconds, 500..2500, unsigned | half steps, signed |
| Where are the pivots? | `sepMm = 0`, one pivot, plus a vertical mount offset | `sepMm = 22`, two mirrors, no vertical offset |
| How does it fail to follow? | deadband, frame latch, lag, gear slop | backlash, reversal ramp, coil settle, pull-out |
| How is it calibrated? | four corner bilinear | four corner projective homography |

## The geometry is probably already there

Before writing a new geometry, check whether the shared one fits. It covers more
than it looks like it does.

`GimbalGeometry` is one yaw about a first axis, then one lift of the already swung
ray onto a plane, with the `cos` slant correction that couples the second axis to the
first:

```
u = tan(theta1) = x / (throwMm + sepMm)
v = tan(theta2) = (y + vOffMm) * cos(theta1) / throwMm
```

A servo pan/tilt head is this with `sepMm = 0`. A two mirror scanner is this with
`vOffMm = 0`. `geometry/gimbal.test.ts` proves both against the original shipped
implementations rather than against each other, which is the check that matters.

If your rig is two rotations aimed at a flat plane, you almost certainly need
parameters and not a new model. If it is genuinely something else, a galvo pair with
a true telecentric lens or a three axis head, then it needs its own geometry module
and this document is understating the work.

Below the geometry there is one number: `beamAnglePerAxisAngle`. A mirror deflects
the beam by twice its own rotation, so it is 2. A servo horn carries the whole head,
so it is 1.

## Writing one

```ts
export function createMyRig(cfg: Partial<MyConfig> = {}): MachineProfile {
  const c = { ...MY_DEFAULTS, ...cfg };

  return {
    id: "my-rig",
    label: "MY RIG: what it is",

    geometry: { throwMm: c.throwMm, sepMm: c.sepMm, vOffMm: 0 },
    beamAnglePerAxisAngle: 2,

    axis: {
      a: { name: "myunit", quantum: 1, min: c.minA, max: c.maxA, subQuantum: "none" },
      b: { /* ... */ },
    },

    limits: {
      maxRate: /* axis units per second */,
      maxAccel: /* axis units per second squared */,
      overrun: "destroys",   // or "degrades"
      derate: 0.7,           // 1.0 where overrun degrades
    },

    caps: { /* what the app is allowed to show */ },

    forward(pair, cal) { /* axis units to mm */ },
    inverse(p, cal)    { /* mm to axis units, UNROUNDED */ },
    sensitivity(a, b, cal) { /* axis units per mm, busier axis */ },
    arcLength(from, to)    { /* Linf */ },
    sampleStepMm(near, cal) { /* how finely to sample here */ },
    quantise(pair)          { /* snap to the quantum */ },
    actuator()              { /* the error model */ },
    matches(hello, config)  { /* pick yourself from the board's own words */ },
  };
}
```

Then register it in `PROFILES` in `packages/beam-core/src/index.ts` and add it to the
`describe.each` list in `profiles/profiles.test.ts`. The contract tests run against it
automatically and they are the definition of "this profile works".

## The rules that are easy to get wrong

**`inverse` must not round.** Velocities need the map's slope, not its nearest step.
Quantisation is a separate, named stage that happens once, at a boundary the planner
controls. A profile that rounds inside `inverse` silently destroys the planner's
ability to compute an accurate gain.

**`sensitivity` is a secant, not a Jacobian and not a constant.** Evaluate at both
endpoints, through whatever calibration is active. Both maps are non-linear on both
legs, so a single global figure is wrong everywhere except where it was sampled. This
is also how the measured corner quad participates in the speed limits rather than
only in the aiming.

**`arcLength` is Linf, and that is not an approximation.** On a stepper it is exactly
the Bresenham dominant axis count, which is the segment's real cost in ticks. On a
servo it is the busier axis, which is the one whose limit binds. The planner's
distance term and the hardware's are the same number.

**`overrun` is not cosmetic.** A servo asked for too much lags and catches up: the
drawing goes soft but it is still the drawing. A stepper asked for too much loses
sync, and every step after that is in the wrong place with no way to know. Declare
`"destroys"` and a derate, or the planner will happily run your rig past the cliff.

**Inversion never transforms the preview.** It is a wiring correction: it changes
what the hardware does and it must be invisible in millimetre space. On a stepper it
belongs in the firmware phase table, so jog inverts too. On a machine with no phase
table, put it at the very last step of the axis encoding, after all the geometry.

**`matches` reads the board's own words.** Profile selection happens on connect from
the hello line plus the config dump, never from a dropdown, because a wrong profile
aims a live beam through the wrong map. Exactly one profile must claim any given
board; the contract test checks that. If none claims it, or two do, the app connects
read only and asks.

## Firmware

A per-rig sketch is a pin map, a driver implementing `BeamDriver`, and a profile id.
The queue, the escaped framer, CRC8, the dead man, the NVS block and the parser live
in `firmware/lib` and are shared.

The header set deliberately does not abstract the step generator. A 20 kHz Bresenham
ISR and a 2 ms servo write throttle are not the same thing, and pretending otherwise
would be the abstraction that costs more than it earns.

## The wire

You probably do not need a new packet format. Two domains exist and the magic byte
keys them:

- **pulse** (`0xA4`, `0xA5`, `0xA6`): unsigned position, whole millisecond duration,
  for a machine that interpolates across a span on its own clock.
- **step** (`0xA3`): signed position, tick interval, for a machine that paces a
  discrete step clock.

Pick the one that matches how your board actually executes. Only invent a format if
your machine is genuinely neither, and if it is both, read the note in
`protocol/spec.ts` about the reserved sub-format before doing anything.

## What a new profile does not get to change

The invariants in [invariants.md](invariants.md) are shared. A profile may declare
that an invariant does not apply to it (a machine with no backlash has nothing to
take up) but it may not weaken one that does. If a new rig makes an invariant
impossible to satisfy, that is a finding about the invariant and it gets discussed in
a pull request body, not worked around in a profile.
