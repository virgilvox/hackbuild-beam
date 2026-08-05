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

* All five shipped inside `originals/laserriggg (1)/`, the servo app's own folder,
  next to `servo_base.stl`. They were moved here and deleted from there once they
  were confirmed byte identical, so this folder is now the only copy.
* `laser-rig.html` embeds all three and assembles them by name: base on the table
  with the pan servo inside, `galvobody` on the pan horn, `galvobrack` on the tilt
  horn.
* `galvobrack` is 17.58 mm tall and `MOUNT.brackBore` is 8.79, exactly half of it.
  The bore runs down the middle of the collar, which is only true of this part.

`galvo` in those filenames is a naming habit, not a lineage. The stepper rig's own
parts are under `../detent-28byj/`, exported from its sim page rather than from a
`.scad`, and they are a completely separate set.

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

## Wiring

The board is a **NULLLAB Maker-ESP32 (ESP32-WROOM-32E)**. Firmware, and the longer
version of this table, is in `../../firmware/washer-servo/`.

| Signal | Pin | Notes |
| --- | --- | --- |
| Pan servo | GPIO 26 | Signal only. Servo V+ to an external 5 V rail |
| Tilt servo | GPIO 25 | Same rail |
| Laser gate | GPIO 23 | Logic level, 3.3 V, 20 to 40 mA |

**Ground the ESP32, the servo supply and the laser supply together.** This is the
most common bring-up failure on this rig, and it presents as servos twitching or the
board resetting when the beam gates, not as an obvious wiring fault.

GPIO 23 switches the laser, it does not power it. A bare 5 mW pointer diode on a
dropper resistor is the most it will drive directly. Anything with its own driver
board gets a low side FET and its own supply; the wiring diagram is in the firmware
README. If the module is active low, send `POL 0`.

## Printing and assembly

Print the base flat, no supports, and the collar with its bore vertical. Slicer hole
compensation must be off: the allowance is already in the model.

Assembly order, which is also the order the 3D view draws them in:

1. Pan servo drops into the base pocket from the top, tabs resting on the ledge at
   z = 14. It is a press fit, there are no fasteners.
2. `galvobody` bolts to the pan horn. Its horn boss is 1.5 mm off the part's own
   centre so the boss, not the outline, lands on the pan axis.
3. Tilt servo goes through the 24 x 12 slot in the 3 mm plate **from the outboard
   side**, so its horn ends up on the inboard face.
4. `galvobrack` bolts to that horn and the laser module slides into its bore.

The pan axis and the tilt axis do not intersect, and that is not a build error. The
plate face is 11.5 mm to one side of the pan axis and the bore is 8.79 mm back from
it, so the beam pivots **2.71 mm past** the pan axis. Over a 152 mm throw that lever
arm is worth about a degree, which is why the app solves for the yaw rather than
taking an arctangent.

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
