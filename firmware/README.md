# firmware

One folder per machine. Each holds the sketch that machine runs, its pinout, and
what the board promises the app.

| Folder | Machine | Board | Sketch |
| --- | --- | --- | --- |
| `washer-servo/` | WASHER, servo pan and tilt head | ESP32-WROOM-32E | `washer-servo.ino` |
| `detent-28byj/` | DETENT, two mirror stepper scanner | ESP32-C3 | `detent-28byj.ino` |
| `detent-28byj/motortest/` | DETENT bring-up | ESP32-C3 | `motortest.ino` |

## One sketch per folder, and the folder is named after it

Both rules are the Arduino IDE's and neither is optional. It concatenates every
`.ino` in a sketch folder into one translation unit before compiling, so two
sketches sharing a folder collide on every symbol they both define, and it will not
open a sketch whose folder disagrees with its name.

That is why `motortest` sits in its own subfolder rather than beside the firmware it
helps debug. Filing them together is the obvious thing to do and it fails with a
wall of redefinition errors that say nothing about the actual cause. A subfolder is
safe: the IDE collects sketch files from the sketch folder itself and does not
recurse into it.

`pnpm check:sketches` enforces both, because neither shows up in a test, a lint or
any amount of reading the code. It is not about the code, it is about which files
the IDE decides belong together.

`detent-28byj/motortest/` is a bring-up sketch, not firmware. It walks the coil
pins one at a time with no BLE, no timer, no queue and no laser, so a motor that
will not turn can be blamed on wiring or on config but not on both at once.

## These are the sketches that have been on the bench

Both came out of the two original single file tools and both have driven real
hardware. They were living under `originals/` until now, which made them look like
reference material rather than the thing you flash. They are the thing you flash.

## The wire is one protocol with two domains

Both boards speak the same framing and are told apart by a magic byte, because the
consequence of guessing wrong is not a garbled line, it is hardware doing something
violent:

| Domain | Magic | Payload |
| --- | --- | --- |
| Pulse, WASHER | `A4` hermite, `A5` flat, `A6` delta | int16 microseconds, uint16 duration |
| Step, DETENT | `A3` formats 0, 1, 2 | int16 half steps, uint16 tick interval |

`ECHO 0` to a stepper board releases both coil sets, and `M 1500 1500 0` to a servo
board is an unclamped slam to the middle of its travel. So an unidentified board is
probed with `?` and nothing else until it has said what it is. See
`packages/beam-link/src/classify.ts`.

## The reference model rule

`CLAUDE.md` rule 5 says the firmware reference model in
`packages/beam-core/src/testing` is the executable spec for the board, and that any
firmware change updates the model in the same commit.

**That model is currently an empty scaffold.** It says so in its own header. The
rule therefore has nothing to enforce, which is worth knowing before you rely on
it: today the only executable check on firmware behaviour is
`packages/beam-core/src/planner/emit.test.ts`, which replays the wire through a
hand written copy of the washer interpolator. See `docs/audit-firmware.md`.
