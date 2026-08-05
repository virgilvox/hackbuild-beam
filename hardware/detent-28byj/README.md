# detent-28byj hardware

The two mirror scanner. Two 28BYJ-48 steppers on ULN2003 driver boards, each turning
a mirror, plus a 405nm diode.

## Parts

| File | What it is | Volume |
| --- | --- | --- |
| `chassis.stl` | The one piece body. Holds both steppers, the module and the mirrors | 31.0 cm3 |
| `cage.stl` | The snap cage that closes over it. No screws | 36.8 cm3 |
| `hood.stl` | The lid | 17.8 cm3 |
| `hub.stl` | Mirror carrier, pressed on a motor shaft. **Print two** | 2.6 cm3 |

Bought, not printed: two 28BYJ-48 steppers on ULN2003 boards, two 20 x 3 mm front
surface mirrors, a 405 nm module, four M4 screws.

### Where these came from

They were exported from `originals/detent-sim/detent.html`, which carries every
part as an indexed mesh quantised to sixteen bits over its own bounding box. There
was no `.scad` and no STL in the tree before this; the geometry had been here since
the sim page arrived and was only ever being drawn, never written out.

`node tools/export-stl.mjs` regenerates them. It is not a one time paste: the sim
page stays the source, so a part cannot be edited here and silently disagree with
what the app draws.

Quantisation costs nothing at this scale, and the working is worth showing rather
than asserting: the largest part spans 71 mm, so sixteen bits over its own box is
71 / 65535, about a micrometre. Two orders of magnitude finer than a printer
resolves and three finer than a 0.4 mm nozzle.

### They are checked, not assumed

The sim page shades with `abs(dot(n, light))`, so it renders a triangle identically
whichever way it faces and could never have noticed a winding problem. A slicer
very much can. So the exporter checks each part and reports rather than hoping:

* **watertight**, every edge used by exactly two triangles, so there is no hole for
  a slicer to guess the inside of
* **consistently wound**, those two uses running opposite ways, so no two triangles
  disagree about which side is out
* **positively oriented**, signed volume positive, so the surface faces out of the
  solid rather than into it

All four pass on all three. An inside out part would otherwise be watertight and
consistent and still print as the negative of itself.

## Printing

Chassis floor down, hub bore up, cage open end up, hood face down. **Not one of them
needs support**, and nothing overhangs past 45 degrees with no material under it.

Slicer hole compensation must be **off**. The allowance is already in the model, and
compensating twice is how the bearing bores come out too tight to press a shaft
into.

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
