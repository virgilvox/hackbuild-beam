# detent-28byj firmware

Two 28BYJ-48 steppers turn two mirrors and a 405 nm diode draws through them.
`detent-28byj.ino`, formerly `detent_firmware.ino`, is the hardware half of what is
now `apps/studio`.

Board: **ESP32-C3 SuperMini** (Arduino-ESP32 core 3.x, ESP-IDF 5.x). USB CDC serial
and BLE Nordic UART at the same time.

## Pinout

| Signal | Pins |
| --- | --- |
| Motor X, ULN2003 A, IN1 to IN4 | GPIO 0, 1, 3, 4 |
| Motor Y, ULN2003 B, IN1 to IN4 | GPIO 5, 6, 7, 10 |
| Laser gate | GPIO 20, through 470R to a 2N2222 base |

Motor lead colours: IN1 blue, IN2 pink, IN3 yellow, IN4 orange.

**Do not use GPIO 2, 8, 9 or 21.** 2, 8 and 9 are strapping pins and 21 is the boot
log. **GPIO 8 and 9 sit between 7 and 10 on the header**, so the Y motor's run of
four is not a run of four on the board and counting along the header is exactly how
this gets miswired.

All nine pins are below 32, which is why the whole machine state is one register
write and the step ISR can be as tight as it is.

## Flashing

ESP32C3 Dev Module, **USB CDC On Boot must be Enabled**. Unplug the ULN boards while
flashing. The BOOT plus RST dance applies on the SuperMini.

If a motor does not turn, run the sketch in `motortest/` before touching anything else. It has
no BLE, no timer ISR, no queue and no laser, just blocking half steps, so it splits
wiring and power from config. The pin walk is the decisive test: eight LEDs light in
sequence, four on board A then four on board B. A pin that never lights its LED is a
wrong header hole, a broken wire or a dead driver channel, and no amount of firmware
will fix it.

## Resolution is fixed by the gearbox

The 28BYJ-48 gear train is **63.68395:1, not 64:1**. Eight half steps per electrical
revolution times 63.68395 gives **4075.7728 half steps per output revolution**, so
one half step is 0.08832680761793199 degrees of mirror and 0.1766536 degrees of
beam, because a mirror deflects the beam by twice its own rotation.

Compute that constant, never paste the rounded 0.0883266 from the firmware comment.
The rounded value shifts every step count.

ULN2003 has no current control, so half step is the floor. There is no
microstepping to reach for, which is why this profile has no sub-quantum strategy
where the servo rig has dither.

## Pull-out

Above roughly 1000 half steps per second these motors start skipping, and **a
skipped step is geometry that is silently gone**: there is no encoder and no way to
detect it. Find the real ceiling before trusting a fast rate.

The procedure is the stall hunt: walk the rate up while blinking the beam at home
before each pass, mark the spot, and the first rate whose blink comes back somewhere
else is past pull-out. Set the draw rate to about 70 percent of the last clean rate.

## The step engine, because it answers the obvious question

Motion is **Bresenham** in a 20 kHz timer ISR: the dominant axis steps every
`interval` ticks and the error accumulator (`err = 2*minor - major`) carries the
subordinate axis along with it. Both axes advance along the same line, so a diagonal
is a diagonal rather than one axis then the other.

Two things ride on top of it, both paid for on the bench:

- **Ramp from standstill.** The mirrors are tiny but the gear train has slop, and a
  cold start straight into full rate is where these motors skip. The interval starts
  3x long and eases in linearly over `rampSteps`.
- **Reversal restarts the ramp.** Without it every corner is a full rate direction
  reversal, which is the other place they skip.

Planned segments (`laser & 2`) opt out of the ramp, because the planner has already
shaped the velocity and a second ramp on top of it just makes the corner slower than
asked.

## Coil release

Idle releases both coil sets to stop the motors cooking. Re-energising holds the last
phase for about 30 ms so the rotor pulls back into register before being asked to
move, which is why the first move after an idle is not a skipped one.

This is also why **`ECHO 0` must never be sent to an unidentified board**: on this
firmware it releases the coils, and a mirror that drops out of register has lost its
home with no way to know it.
