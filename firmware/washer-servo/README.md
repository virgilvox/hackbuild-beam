# washer-servo firmware

Two hobby servos aim a laser at a wall. `washer-servo.ino`, formerly
`PanTiltLaser.ino`, is the hardware half of what is now `apps/studio`.

Board: **NULLLAB Maker-ESP32 (ESP32-WROOM-32E)**. Listens on USB serial and BLE at
the same time, no reflashing to swap between them.

## Pinout

| Signal | Pin | Notes |
| --- | --- | --- |
| Pan servo | GPIO 26 | Signal only. Servo V+ to an external 5 V rail |
| Tilt servo | GPIO 25 | Same rail |
| Laser gate | GPIO 23 | Logic level, 3.3 V, see below |

25 and 26 are DAC capable but drive servos fine through LEDC. 23 is a clean digital
output.

**Grounds must be commoned** between the ESP32, the servo supply and the laser
supply. This is the single most common bring-up failure on this rig.

### The laser gate does not power the laser

GPIO 23 goes HIGH while the beam is on and LOW when it is off. It swings 3.3 V and
sources 20 to 40 mA, which is enough for a bare 5 mW pointer diode on a dropper
resistor and nothing more. Anything with its own driver board gets a low side
switch:

```
GPIO23 --[220R]--+---- gate    (logic level N-FET, AO3400 or similar)
                 |
                [10k] to GND   (holds it off through boot)

laser (-) -> drain          laser (+) -> its own rated supply
source    -> common GND
```

All the laser current comes from that supply through the FET. If your module is
active low, send `POL 0`; the default is active high.

## Flashing

Arduino IDE, board **ESP32 Dev Module**. Needs the `ESP32Servo` library and the
ESP32 core's own BLE stack. Unplug the servo rail while flashing: a servo drawing
stall current off a shared USB supply will brown out the flash.

## Safety, as the firmware enforces it

The beam is forced off at boot, on BLE disconnect, by the dead man timer (`DM`,
1500 ms default, 0 disables), and by a starvation gate: if a job is armed and the
segment queue runs dry for 300 ms the gate closes rather than burning a dot into the
glow paint while it waits.

## What this firmware does that the app should be using

Both of these are implemented here, exposed as config keys, and were **not** being
set by the app. See `docs/audit-app.md`.

| Key | What it does |
| --- | --- |
| `dit` | Symmetric dither. Adds a plus and minus carrier at 3/4 of the deadband, flipping once per servo frame, applied to the live command at every write. Breaks the deadband's hysteresis so the mechanics average onto the true command |
| `ffp`, `fft` | Per axis lead, in milliseconds. Commands an axis a few ms into its own future, as position plus lead times velocity. The pan servo hauls the whole tilt assembly so it answers late, and a few ms on pan takes the hook out of diagonals |

Dither is off unless asked because it keeps both servos audibly hunting. That is a
real cost and the reason it is a choice, but on this rig it is the difference
between legible text and not: see the measured table in `docs/audit-app.md`.

## The interpolator, because it answers the obvious question

Segments are played as a **cubic Hermite on both axes over the same `T`**, so pan
and tilt are always moving together and a diagonal is a diagonal, not a staircase
of one axis then the other. The curve starts from the position and velocity the
board really has and ends on the endpoint and endpoint velocity the packet carries,
so every boundary is continuous and a lost packet gets spliced over by a smooth
reroute instead of a lurch.

Servos are written every **2 ms**, not on a 20 ms frame boundary. Two free running
20 ms clocks drift against each other, so a frame aligned write lands anywhere from
just before a boundary to a whole frame early and the latched value carries 0 to
20 ms of wander with it. Writing far faster than the frame costs nothing and means
whatever the servo latches is always the freshest value.

Tangents are capped at three chord slopes plus a few microseconds of headroom. A
healthy segment passes untouched; a splice across a big hole starts from a real
velocity that can dwarf the stretched chord, and a cubic handed a tangent several
times its chord swings far outside it.
