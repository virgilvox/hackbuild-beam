# detent-28byj hardware

The two mirror scanner. Two 28BYJ-48 steppers on ULN2003 driver boards, each turning
a mirror, plus a 405nm diode.

## Parts

**There are no models for this rig in the tree.**

The two `galvo*.stl` files that used to sit in this folder are the servo pan/tilt
head's, and they now live under `../washer-servo/` where the rest of that rig's parts
already were. Their names misled an earlier pass: they ship inside the servo app's own
folder, `laser-rig.html` embeds and assembles all three by name, and `galvobrack` is
17.58 mm tall against a `brackBore` of 8.79, exactly half, so its bore runs down the
middle of the collar. See `../washer-servo/README.md`.

`detent-plot.html` never had a mesh. It carries no three.js and no embedded geometry:
its rig view is a hand drawn projection of about thirty quads, which is what the app
still falls back to for this machine.

So the 3D view draws this rig from its geometry rather than from its hardware: two
mirrors on posts, at 45 degrees plus half the beam angle, a real `sepMm` apart. That
is dimensionally honest about the optics and says nothing about the housing.

To get the real parts in, drop the STLs here and add them to the `PARTS` table in
`tools/pack-mesh.mjs`; the packer, the decoder and the renderer are all generic. What
does not exist yet is the placement, which is the part that has to be measured rather
than guessed, exactly as `apps/studio/src/canvas/rig-assembly.ts` does for the servo
head.

BOM and the SPINDLE shield notes land here at M0 per the PRD.

## Resolution is fixed by the gearbox

The 28BYJ-48 gear train is 63.68395:1, not 64:1. Eight half steps per electrical
revolution times 63.68395 gives **4075.7728 half steps per output revolution**, so
one half step is 0.08832680761793199 degrees of mirror and 0.1766536 degrees of beam,
because a mirror deflects the beam by twice its own rotation.

Compute that constant, never paste the rounded 0.0883266 from the firmware comment.
The rounded value shifts every step count.

ULN2003 has no current control, so half step is the floor. There is no microstepping
to reach for, which is why this profile has no sub-quantum strategy where the servo
rig has dither.

## Pull-out

Above roughly 1000 half steps per second these motors start skipping, and a skipped
step is geometry that is silently gone with no way to detect it. Find the real
ceiling before trusting a fast rate.

The procedure is the stall hunt: walk the rate up while blinking the beam at home
before each pass, mark the spot, and the first rate whose blink comes back somewhere
else is past pull-out. Set the draw rate to about 70 percent of the last clean rate.

## Firmware

`../../firmware/detent-28byj/`. Flashing notes, the pull-out procedure and the step
engine are documented there.

## Wiring

| Signal | Pins |
| --- | --- |
| Motor X, ULN2003 A, IN1 to IN4 | GPIO 0, 1, 3, 4 |
| Motor Y, ULN2003 B, IN1 to IN4 | GPIO 5, 6, 7, 10 |
| Laser gate | GPIO 20, through 470R to a 2N2222 base |

Wire colours on the motor lead: IN1 blue, IN2 pink, IN3 yellow, IN4 orange.

GPIO 2, 8, 9 are strapping pins and GPIO 21 is the boot log. Avoid all four. **GPIO 8
and 9 sit between 7 and 10 on the header. Do not use them.**

GPIO 20 is U0RXD, chosen because it is quiet at boot, so the transistor is not
tickled by boot chatter.

All nine pins are below 32, so the whole machine state is one register write.

## Flashing

ESP32C3 Dev Module, **USB CDC On Boot must be Enabled**. Unplug the ULN boards while
flashing. The BOOT plus RST dance applies on the SuperMini.

If a motor does not turn, run `firmware/detent-28byj/motortest/` before touching anything else. It
isolates wiring and power from the real firmware: no BLE, no timer ISR, no queue, no
laser, just blocking half steps. If a motor turns there and not in the real firmware,
the problem is config. If it does not turn there either, the problem is wiring, power,
or the motor.

The pin walk is the decisive test: one pin at a time, named out loud. Eight LEDs
should light in sequence, four on board A then four on board B. A pin that never
lights its LED is a wrong header hole, a broken wire, or a dead driver channel, and
no amount of firmware will fix it.

## The case aperture

Beam deflection is 0.1766 degrees per step, so limits spanning N steps give a cone N
times 0.1766 degrees wide. A window at distance d mm from the Y mirror must be at
least `2 * d * tan(half angle)` wide, plus the beam diameter.
