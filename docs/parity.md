# Parity checklist

Both original tools work. This is the list of what they do, so the merged app can be
checked against it rather than against memory. It is the acceptance criteria for M2.

An item is done when the merged app does it on the physical rig, not when a module
exists.

Items marked **decide** have no obvious answer and are called out in the PRD's open
questions. Items marked **safety** change what a live beam does and are not optional.

---

## Both rigs

- [ ] Connect over USB serial and over BLE
- [ ] Classify the board from a `?` probe before emitting anything else **safety**
- [ ] Adopt board config on connect, both directions, without clobbering it
- [ ] Explicit push and explicit persist
- [ ] Honour a stored calibration flag only if at least one corner arrived (INV-84)
- [ ] Jog, set origin, go to origin
- [ ] Capture four corners, solve, report residual in millimetres, clear
- [ ] Stroke font text with size and tracking
- [ ] SVG import
- [ ] Image raster with threshold, pitch and invert, rows staying serpentine
- [ ] Live sketch on the target canvas
- [ ] Calibration patterns
- [ ] Plan tuning, preview, run, pause, resume, stop
- [ ] E-stop that flushes before cutting the beam **safety**
- [ ] Console with the raw protocol trace, and a `[sim]` marker when disconnected
- [ ] Clip warning when limits cut content
- [ ] No horizontal scroll at 1100, 1400 and 1920 wide
- [ ] Runs from `file://` with no server and no network

## washer-servo

- [ ] Pulse range, per-axis invert
- [ ] Per-axis trim that actually moves the beam (INV-86: it does not today, and the merged profile deliberately changes this)
- [ ] Per-axis lead in milliseconds, with the explainer that says give pan 2 to 4 ms
- [ ] Servo preset selection, which also sets the stream rate to match the frame
- [ ] Dither toggle with the folded explainer and its measured claim
- [ ] Throw, target size and mount height, with the sweep readout and its warning
- [ ] Steps-per-frame readout naming the axis-alternating band
- [ ] Bounds warning with a "fit it" action
- [ ] **Frame the job** pass, which restores the real preview when it finishes
- [ ] **Dry run** toggle, including its mid-plot reset behavior
- [ ] End-of-job drain before the beam is cut (INV-82) **safety**
- [ ] Frame fallback drops for backpressure only when the gate is unchanged (INV-83) **safety**
- [ ] Live speed override, scaling timeline spans and not wire duration (INV-85)
- [ ] Live paint surface with its own beam-safe-on-leave wiring **safety**
- [ ] Keyboard: space pauses, escape stops, both ignored while typing **safety**
- [ ] Raw command entry in the console
- [ ] Digital twin viewport driven by shipped segments, reports demoted to drift trim
- [ ] Report-following easing while not plotting (the non-twin path)
- [ ] Embedded firmware view with copy and download
- [ ] 3D stage with the offset-pivot yaw solve and orbit camera **decide**

## detent-28byj

- [ ] Rig geometry: throw, mirror separation, field size
- [ ] Motion: draw rate, travel rate, accel, backlash comp, measured slack
- [ ] Axis inversion that changes hardware and never the preview (INV-09)
- [ ] Soft limits, enforce toggle, derive from corners with a 4 step margin
- [ ] Beam cone readout, and the case-aperture arithmetic in the docs **safety**
- [ ] Coil release and idle-release timeout
- [ ] Stall hunt, with one derating figure rather than two **decide**
- [ ] Lash gauge, ruler and square patterns
- [ ] 3D wireframe sources: cube, tesseract, icosahedron, torus knot, sphere, lissajous
- [ ] 2D sources: circle, star, spiral, grid
- [ ] ANIMATE and LOOP, including the whole-pipeline-per-frame budget **decide**
- [ ] Explicit re-pull of board config mid-session
- [ ] Queue drain poll that knows a plot finished on the wall, not in the host **safety**
- [ ] Scanner canvas with the breathing camera and the 420-point trace decimation
- [ ] Step lattice overlay, shown only when it would be legible
- [ ] Zoom about the cursor, pan, double-click reset
- [ ] Backlash spread readout, hot above 1.5 steps of spread
- [ ] Tooltip inventory
- [ ] Manual overlay

---

## Things with no home yet, and what to do about them

These came out of an adversarial completeness review. Each is real, and none is
resolved by writing a module.

**The beam arming gesture.** The two apps have incompatible models. One arms the beam
with a button and tracks three separate armed flags that the e-stop all clears. The
other fires on shift-drag, and deliberately keeps the beam on if you release shift
before the pointer, which its own manual flags with "so watch your hand". These
cannot both be true of one pad. This is a safety surface and it needs a decision, not
a merge. **decide**

**The 3D stage.** It is the largest single thing in the servo app and it depends on
three.js, three embedded STL meshes, a mount-geometry table and an offset-pivot yaw
solve worth about a degree at short throw. Keeping it fights the offline size budget;
dropping it loses the only view that shows where the rig is actually pointing. The
PRD's position is to vendor it and lazy-load it behind a capability, so the plot never
depends on it. **decide**

**Fifteen pieces of explainer prose.** The lead hint, the dithering explainer with its
measured 0.94 mm to 0.35 mm claim, the mirror hint, the short-throw hint and the
resolution, sweep and smoothness readouts are all measured, paid-for copy that lives
in one app's HTML and in no docs file. They need a home before that app is deleted.

**Project save and load.** Neither app has it, so it is not a regression, but the
merge makes it worse: with two profiles you now retype two sets of app-only settings,
and the measured gearbox slack has no wire field at all, so a board moved to another
machine loses the only record of it. This should not be a stretch item.

**SVG import capability.** The servo app samples the browser's own path geometry via
`getTotalLength`, which handles anything a browser can render. The stepper app has a
hand-written path parser. Picking the parser as the single implementation is
defensible for headless testability, but it is a capability regression and it should
be a stated decision rather than a side effect. **decide**

**Two firmware persistence models.** One board commits to flash on every config
assignment; the other only on an explicit command. The PRD moves both to explicit,
which is right, but it means an old app driving a new board silently stops persisting.
The console's raw command entry becomes the only workaround, which is an argument for
keeping it.
