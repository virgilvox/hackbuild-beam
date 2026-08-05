# washer-servo hardware

The pan/tilt servo rig. Neither original PRD claimed these files: one reserved a
hardware folder for the stepper parts only, the other had no hardware folder at all.
They live here now.

## Parts

| File | What it is |
| --- | --- |
| `servo_base_lego.scad` | Source for the LEGO-footprint pan base. Prints flat, no supports, press fit servo, no fasteners |
| `servo_base_lego.stl` | Direct export of the above at default tuning |
| `servo_base.stl` | The non-LEGO pan base variant. No source in the tree |
| `galvobody.stl` | Bolts to the pan horn and carries the tilt servo in a 24 x 12 slot |
| `galvobrack.stl` | Bolts to the tilt horn and holds the laser module in its bore |

## All five files are this rig's

An earlier pass filed the two `galvo*` STLs under `../detent-28byj/` on the strength
of their names. They are this rig's, and three independent things say so:

* They ship inside `originals/laserriggg (1)/` next to `servo_base.stl`, in the
  folder of the servo app.
* `laser-rig.html` embeds all three and assembles them by name: base on the table
  with the pan servo inside, `galvobody` on the pan horn, `galvobrack` on the tilt
  horn.
* `galvobrack` is 17.58 mm tall and `MOUNT.brackBore` is 8.79, exactly half of it.
  The bore runs down the middle of the collar, which is only true of this part.

The stepper rig has no model in this tree at all. `galvo` in the filename is a
naming habit, not a lineage.

## The numbers that place them

Read off the STLs and confirmed against laser-rig.html's own scene graph with both
joints zeroed. That app puts the bore at world y = 0, and:

| Landmark | Height relative to the bore |
| --- | --- |
| Underside of `servo_base`, on the table | -47.7 mm |
| Top face of `servo_base` | -31.7 mm |
| Underside of `galvobody`, on the pan horn | -27.5 mm |
| The bore itself | 0 |

`tiltY` is 27.5 and is measured from the **galvobody's base**, not from the table.
The table is a further `panHornY` (20.2) down, so the stand is 47.7 mm tall. Reading
27.5 as a table height is the mistake this table exists to prevent; it leaves the
base floating one pan servo too high.

The pan axis and the tilt axis do not meet. The plate face is 11.5 mm to one side and
the bore is 8.79 mm back from it, so the beam pivots 2.71 mm **past** the pan axis.
Over a 152 mm throw that lever arm is worth about a degree, which is why the aiming
solves for the yaw instead of taking an arctangent.

## The numbers that are not preferences

The LEGO block at the top of the `.scad` is marked do not change, and one constant
in it is load bearing: `ROOF = 1.0` leaves a 2.2 mm underside cavity, which clears a
1.8 mm stud with 0.4 to spare. Change it and the part stops stacking.

`clutch = 0.05` is the per-surface clearance added to the stud grip, tuned for FDM.
Zero is nominal LEGO and tight on most printers; 0.10 is easy on and off.

`grip = 16.0` is the socket depth, and the SG90's mounting flange landing on the top
rim of the collar is the entire retention scheme. There are no screws.

The buttress angle offset exists so an even web count does not land a web on the
cable channel axis, and the hull root is anchored at the collar centre so the
buttress fuses to the socket wall at every rotation.

The cable channel is cut full depth from rim to baseplate on purpose, so the wire
drops in with the servo instead of jamming against the rim.

Envelope at default tuning: 47.8 x 47.8 x 18.2 mm, 20.0 mm over the studs.

## Servo

SG90 or MG90S, 22.8 x 12.2 mm body. Confirmed three ways: the `.scad` header, the
pocket dimensions, and the firmware's stored servo profile default.

A 9g micro servo is not a galvo. It takes a new position 50 times a second and no
faster, it has a few microseconds of deadband inside which a command produces no
movement at all, and it has gear slop. Those numbers live in `SERVO_PRESETS` in
`packages/beam-core/src/profiles/washer-servo.ts`, because they are what the planner
is actually constrained by.

## Installation geometry

The `.scad` carries none of it. Throw, target size and mount height live on the board
in NVS, because the board is the thing bolted to the wall. Defaults are a 152 mm
throw onto a 305 mm square target with the head 70 mm off the floor.

That mount height is not cosmetic. The target sits on the floor so its centre is at
half its height, while the head is at 70 mm, and the difference is what the tilt axis
has to cover. Getting that offset wrong once drew an entire design 159 mm from where
the beam was actually going.

## Wiring

| Signal | Pin |
| --- | --- |
| Pan servo | GPIO 26 |
| Tilt servo | GPIO 25 |
| Laser gate | GPIO 23 |

Servo V+ goes to an external 5V supply, grounds commoned. GPIO23 swings 3.3 V and
sources 20 to 40 mA, which is enough for a bare 5 mW pointer diode on a dropper
resistor and no more. Anything bigger gets a low-side FET through 220 ohm with a 10k
pulldown to ground so it stays off during boot, and the laser supply stays separate
with a common ground.
