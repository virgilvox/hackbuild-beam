import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import {
  build3d,
  buildShape,
  bboxCentre,
  bboxOf,
  centerFit,
  lashGauge,
  rasterToStrokes,
  rateRamp,
  ruler,
  scaleToField,
  translateStrokes,
  squareWithDiagonals,
  svgToStrokes,
  textToStrokes,
  type GrayImage,
  type ModelKind,
  type ParseXml,
  type SourceResult,
  type Stroke,
} from "@virgilvox/beam-sources";
import {
  SERVO_PRESETS,
  emitSegments,
  planJob,
  servoResolution,
  simulate,
  type Point,
  type EmittedSegment,
  type SimResult,
  type Timeline,
} from "@virgilvox/beam-core";
import { useLink } from "./link";
import { useMachine } from "./machine";
import { useLog } from "./log";

export type SourceKind =
  | "text" | "svg" | "image" | "sketch"
  | "cube" | "tesseract" | "ico" | "knot" | "sphere" | "lissajous"
  | "circle" | "star" | "spiral" | "grid"
  | "lash" | "ruler" | "square" | "ramp";

const DEG = Math.PI / 180;

/**
 * Degrees of yaw and of pitch per unit of spin, straight off the detent tool.
 *
 * 34 and 21 rather than one rate on both axes: two near coprime rates keep the two
 * rotations from ever coming back into phase, which is what stops the tumble looking
 * like a turntable and hides the fact that the model is only ever eight vertices.
 */
const SPIN_YAW_DEG = 34;
const SPIN_PITCH_DEG = 21;

/**
 * What to draw, and what the machine will actually do with it.
 *
 * Two paths come out of here and they are not the same. `strokes` is what you asked
 * for, drawn as a ghost. `simulated` is what the machine will really produce once
 * the path has been quantised onto its axis grid and pushed through its error model.
 * The preview shows the second one solid, because a preview that shows the intent
 * rather than the result is worse than no preview: it hides exactly the problems it
 * exists to reveal.
 */
export const useProject = defineStore("project", () => {
  const machine = useMachine();
  const log = useLog();

  const source = ref<SourceKind>("text");
  const text = ref("HACK.BUILD");
  const capMm = ref(40);
  /*
   * Which face the text is cut from.
   *
   * "servo" is condensed and defaults on, because on a machine whose error is a
   * fixed number of millimetres the narrower face is simply better: the same line
   * of text fits at about 38 percent more cap height, and the error as a fraction
   * of a letter falls by about a quarter. It is a legibility setting wearing a
   * typography setting's clothes. See packages/beam-sources/src/font-servo.ts.
   */
  const face = ref<"default" | "servo">("servo");
  const tracking = ref(1);
  const scalePct = ref(72);
  const toleranceMm = ref(0.2);

  const rotateDeg = ref(0);
  const offX = ref(0);
  const offY = ref(0);
  const mirrorX = ref(false);
  const mirrorY = ref(false);

  const reorder = ref(true);
  const unidirectional = ref(false);
  const showIdeal = ref(true);
  const showLattice = ref(true);

  /* 3D controls, live only for the wireframe sources. */
  const yaw = ref(35);
  const pitch = ref(28);
  const detail = ref(3);
  /**
   * The tumble phase, in the detent tool's own arbitrary units.
   *
   * The animate store owns the clock and writes this; the project store only reads
   * it, which is what keeps the two stores acyclic. Zero means not animating, so
   * turning ANIMATE off snaps back to whatever the yaw and pitch sliders say rather
   * than freezing the model at whatever angle the last frame happened to land on.
   */
  const spin = ref(0);

  const svgText = ref<string | null>(null);
  const image = shallowRef<GrayImage | null>(null);
  const imgThreshold = ref(128);
  const imgPitchSteps = ref(2);
  const imgInvert = ref(false);

  const sketch = ref<Stroke[]>([]);
  let sketchLive: Point[] | null = null;
  /**
   * Whether the stroke being drawn is already the last entry in `sketch`.
   *
   * The preview has to follow the pointer, so the live stroke goes into the list on
   * its first accepted point and is replaced in place after that. The flag is what
   * says which of those two it is. Without it the replace has to assume the last
   * entry is always the live one, which deletes the previous stroke the moment a new
   * one starts, and the pointer-up then has to append to compensate, which leaves
   * every finished stroke in the list twice and burns it twice.
   */
  let sketchOpen = false;

  const strokes = ref<Point[][]>([]);
  const simulated = ref<{ x: number; y: number; on: boolean }[]>([]);
  const planned = ref(false);
  const clipped = ref(false);
  const commandCount = ref(0);
  const estimate = ref("");
  const health = ref("");
  /* The plan itself, kept so the run does not replan and drift from the preview. */
  const timeline = shallowRef<Timeline | null>(null);
  const sim = shallowRef<SimResult | null>(null);
  /*
   * What actually goes on the wire.
   *
   * Not the simulated path: that is the machine's PREDICTED error, and sending it
   * back to the machine would apply the error twice. The board wants the plan, as
   * segments carrying endpoint velocities, and it plays each one from where it
   * really is to where it is told with both position and velocity continuous.
   */
  const wire = shallowRef<EmittedSegment[]>([]);
  const wireWorstMm = ref(0);
  const wireMerged = ref(0);
  const spreadMm = ref(0);

  /**
   * What this machine can actually resolve, and whether the content asks for more.
   *
   * This exists because the app used to draw an illegible scribble and say nothing.
   * The servo rig's deadband is angular, so on a 120 mm field it is about 1.9 mm,
   * which is 63 resolvable steps across the whole field. Ten characters of text get
   * six steps of width each, and six steps is not a letter. No amount of planning
   * fixes that: it is the hardware, and the only real answers are fewer characters,
   * a bigger drawing, or dither.
   */
  const resolutionMm = ref(0);
  const stepsAcross = ref(0);
  const detailWarning = ref<string | null>(null);

  /**
   * The largest cap height whose line still fits the field.
   *
   * Text width scales linearly with cap height, so one probe at a reference size
   * fixes the ratio for every size. Both axes are checked because a short string at
   * a big cap is limited by its height and a long one by its width, and which of
   * the two binds is not something the operator should have to work out: a line of
   * text is several times as wide as it is tall, so the answer is usually width and
   * is never obviously so.
   */
  const capToFitMm = computed(() => {
    if (source.value !== "text") return 0;
    const probe = textToStrokes(text.value, {
      capMm: 100,
      tracking: tracking.value,
      /* Coarse on purpose: this measures an envelope, and flattening it finely is
       * work thrown away on every keystroke. */
      toleranceMm: 2,
      face: face.value,
    });
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const st of probe.strokes) {
      for (const q of st) {
        if (q.x < minX) minX = q.x;
        if (q.x > maxX) maxX = q.x;
        if (q.y < minY) minY = q.y;
        if (q.y > maxY) maxY = q.y;
      }
    }
    if (!(maxX > minX) && !(maxY > minY)) return 0;
    const perCapW = (maxX - minX) / 100;
    const perCapH = (maxY - minY) / 100;
    /* Eight percent back from the edge. The corners are where a four corner map is
     * least trustworthy and where a servo is nearest the end of its travel. */
    const fit = Math.min(
      perCapW > 1e-6 ? (machine.fieldW * 0.92) / perCapW : Infinity,
      perCapH > 1e-6 ? (machine.fieldH * 0.92) / perCapH : Infinity,
    );
    return Number.isFinite(fit) ? Math.max(2, Math.round(fit)) : 0;
  });

  /** Set the text as large as the field will take. */
  function fitTextToField(): void {
    if (capToFitMm.value > 0) capMm.value = capToFitMm.value;
  }

  const noReorder = ref(false);

  /** The DOM primitive the SVG importer needs, injected rather than reached for. */
  const parseXml: ParseXml = (t: string) =>
    new DOMParser().parseFromString(t, "image/svg+xml") as unknown as ReturnType<ParseXml>;

  function generate(): SourceResult {
    const field = { widthMm: machine.fieldW, heightMm: machine.fieldH };
    const min = Math.min(machine.fieldW, machine.fieldH);

    switch (source.value) {
      case "text":
        return textToStrokes(text.value, {
          capMm: capMm.value,
          tracking: tracking.value,
          toleranceMm: toleranceMm.value,
          face: face.value,
        });
      case "svg":
        if (!svgText.value) return { strokes: [], bbox: { minX: 0, minY: 0, maxX: -1, maxY: -1 } };
        return svgToStrokes(svgText.value, parseXml, { toleranceMm: toleranceMm.value });
      case "image":
        if (!image.value) return { strokes: [], bbox: { minX: 0, minY: 0, maxX: -1, maxY: -1 } };
        return rasterToStrokes(image.value, {
          threshold: imgThreshold.value,
          invert: imgInvert.value,
          resolutionMm: stepMm(),
          pitchMm: stepMm() * imgPitchSteps.value,
          widthMm: min * (scalePct.value / 100),
          heightMm: min * (scalePct.value / 100),
        });
      case "sketch":
        return { strokes: sketch.value.map((s) => s.slice()), bbox: { minX: 0, minY: 0, maxX: -1, maxY: -1 } };
      case "lash": return lashGauge(field);
      case "ruler": return ruler(field, stepMm());
      case "square": return squareWithDiagonals(field);
      case "ramp": return rateRamp(field);
      case "circle": case "star": case "spiral": case "grid":
        return buildShape(source.value, { detail: detail.value, sizeMm: min });
      default: {
        /*
         * The tumble, ported from the detent tool.
         *
         * Yaw gains 34 degrees per unit of spin and pitch 21. The two rates are near
         * coprime, so the two axes never come back into phase and the figure does not
         * visibly loop the way a single axis spin does after one turn.
         *
         * The DEG conversion is not decoration. `rot3` takes radians, the sliders are
         * degrees over 0..360, and feeding degrees straight in wraps the model about
         * fifty seven times across the slider and makes the spin rates meaningless.
         */
        const kind: ModelKind = source.value === "lissajous" ? "lissa" : (source.value as ModelKind);
        return build3d(kind, {
          yaw: (yaw.value + spin.value * SPIN_YAW_DEG) * DEG,
          pitch: (pitch.value + spin.value * SPIN_PITCH_DEG) * DEG,
          detail: detail.value,
          sizeMm: min,
          /* The 4D rotation phase. Only the tesseract reads it. */
          spin: spin.value,
        });
      }
    }
  }

  /** What the connected board negotiated, if anything is connected. */
  function wireCaps(): { herm: boolean } | null {
    const dev = useLink().device as { peer?: { wire?: { herm?: boolean } } } | null;
    const w = dev?.peer?.wire;
    return w ? { herm: w.herm === true } : null;
  }

  /** One axis quantum in millimetres, at the field centre. */
  function stepMm(): number {
    return machine.profile ? machine.profile.sampleStepMm({ x: 0, y: 0 }, machine.activeCal) : 0.5;
  }

  function place(input: Stroke[]): Point[][] {
    /* Patterns and sketches are already in target millimetres, so centring and
     * scaling them would move a calibration pattern off the thing it is measuring. */
    const isPattern = ["lash", "ruler", "square", "ramp", "sketch"].includes(source.value);
    let out = input.map((s) => s.map((p) => ({ x: p.x, y: p.y })));

    /*
     * Text already has a real size, so it is centred and NOT rescaled.
     *
     * `centerFit` normalises to a unit box by dividing through the bbox span, and
     * `scaleToField` then multiplies by the field and a percentage. Run text through
     * that pair and the cap height is erased on the way: cap 10, 40 and 80 all came
     * out at exactly the same 86.4 x 12.9 mm, because the only two numbers left in
     * the result were the field and the slider. A control labelled in millimetres on
     * the target has to mean millimetres on the target.
     *
     * Fitting to the field is still the only sensible control for a source with no
     * intrinsic size, so SVG and images keep it. The panel shows one size control
     * per source for that reason.
     */
    if (source.value === "text") {
      const b = bboxOf(out);
      const c = bboxCentre(b);
      out = translateStrokes(out, -c.x, -c.y);
    } else if (!isPattern) {
      out = scaleToField(centerFit(out), Math.min(machine.fieldW, machine.fieldH), scalePct.value);
    }

    const c = Math.cos((rotateDeg.value * Math.PI) / 180);
    const s = Math.sin((rotateDeg.value * Math.PI) / 180);
    const mx = mirrorX.value ? -1 : 1;
    const my = mirrorY.value ? -1 : 1;

    return out.map((stroke) =>
      stroke.map((p) => {
        /* Mirror about the design's own centre before rotating, so the two controls
         * compose the way you would expect rather than fighting each other. */
        const x = p.x * mx;
        const y = p.y * my;
        return { x: x * c - y * s + offX.value, y: x * s + y * c + offY.value };
      }),
    );
  }

  /**
   * Regenerate content, place it, plan it, and simulate what the machine will really
   * do with it.
   *
   * The plan comes from the shared planner rather than from anything app side, which
   * is the point of the whole exercise: the same code plans for both rigs and never
   * learns which one it is planning for. The trace comes from the simulator running
   * that plan through this profile's own error model, so the preview shows the
   * result and not the intent.
   */
  function rebuild() {
    try {
      const res = generate();
      noReorder.value = res.noReorder === true;

      const placed = place(res.strokes);
      strokes.value = placed;

      const p = machine.profile;
      if (!p || placed.length === 0) {
        timeline.value = null;
        sim.value = null;
        simulated.value = [];
        planned.value = false;
        commandCount.value = 0;
        return;
      }

      const cal = machine.activeCal;
      const tl = planJob(placed, p, {
        cal,
        /*
         * Drawing feed, when the installation asks for one.
         *
         * Only the servo rig sets this, and it is half of a pair: a servo deadband
         * is hysteresis rather than quantisation, so slowing down on its own buys
         * nothing measurable. What it buys is TIME for dither's carrier to average
         * out, and dither is what actually breaks the hysteresis. Together they take
         * the ninetieth percentile error on a 40 mm cap from 5.1 mm to 1.5 mm; alone,
         * either one is worth a few tenths. See docs/audit-app.md.
         */
        ...(machine.feedMmS > 0 ? { feedMmS: machine.feedMmS } : {}),
        optimise: reorder.value && !noReorder.value,
        /* Unidirectional means never reverse a stroke while ordering, which trades
         * speed for repeatability by never asking the gear train to turn round mid
         * drawing. A raster sets it for a different reason: reversing shows. */
        allowReverse: !unidirectional.value && !noReorder.value,
        tolMm: toleranceMm.value,
      });
      timeline.value = tl;

      const result = simulate(tl, p, { cal });
      sim.value = result;
      spreadMm.value = result.spreadMm;

      simulated.value = result.samples.map((sm) => ({ x: sm.at.x, y: sm.at.y, on: sm.laser }));
      commandCount.value = result.samples.length;
      planned.value = tl.dur > 0;

      /* Clipping is a real answer from the profile's own axis range, not a guess. */
      let clip = false;
      for (const sm of result.samples) {
        if (sm.cmd.a <= p.axis.a.min || sm.cmd.a >= p.axis.a.max) { clip = true; break; }
        if (sm.cmd.b <= p.axis.b.min || sm.cmd.b >= p.axis.b.max) { clip = true; break; }
      }
      clipped.value = clip;

      /* The resolution budget, and an honest warning when the content outruns it. */
      const gain = p.sensitivity({ x: 0, y: 0 }, { x: 1, y: 0 }, cal);
      const stepMmHere = gain > 1e-9 ? 1 / gain : 0;
      const preset = SERVO_PRESETS[machine.config["sv"] ?? "micro9g"] ?? SERVO_PRESETS["micro9g"]!;
      const hasDeadband = p.caps.dither;
      const budget = hasDeadband
        ? servoResolution(p, Math.min(machine.fieldW, machine.fieldH), preset, machine.dither)
        : { deadbandMm: stepMmHere, quantumMm: stepMmHere, effectiveMm: stepMmHere,
            stepsAcrossField: Math.min(machine.fieldW, machine.fieldH) / Math.max(1e-9, stepMmHere) };

      resolutionMm.value = budget.effectiveMm;
      stepsAcross.value = budget.stepsAcrossField;

      /*
       * Judge legibility against the drawing itself, not the field.
       *
       * The first version measured the narrowest stroke bounding box, which finds a
       * vertical line and reports it as one step wide. A vertical line has no width;
       * that is not a legibility problem. What matters is how many resolvable steps
       * fit across the smallest thing that has to read as a shape: a glyph for text,
       * and the short side of the drawing otherwise.
       */
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const st of placed) {
        for (const q of st) {
          if (q.x < minX) minX = q.x;
          if (q.x > maxX) maxX = q.x;
          if (q.y < minY) minY = q.y;
          if (q.y > maxY) maxY = q.y;
        }
      }
      const drawnW = Math.max(0, maxX - minX);
      const drawnH = Math.max(0, maxY - minY);
      /* Text knows its own glyph count, which is the honest denominator. Everything
       * else is judged on its short side. */
      const glyphs = source.value === "text"
        ? Math.max(1, text.value.replace(/\s/g, "").length)
        : 1;
      const featureMm = source.value === "text"
        ? Math.min(drawnW / glyphs, drawnH)
        : Math.min(drawnW, drawnH);
      const featureSteps = featureMm / Math.max(1e-9, budget.effectiveMm);

      /*
       * Overflow first, because it outranks everything else.
       *
       * Cap height is millimetres on the target and is now honoured literally, so
       * asking for letters bigger than the field is a thing you can do. The beam
       * then runs to the edge of its travel where the geometry goes nonlinear and
       * the drawing is ruined in a way no other warning describes. Say so, and say
       * what would fit, because the arithmetic is not obvious: a line of text is
       * several times as wide as it is tall.
       */
      const overW = drawnW / Math.max(1e-9, machine.fieldW);
      const overH = drawnH / Math.max(1e-9, machine.fieldH);
      const over = Math.max(overW, overH);
      if (over > 1.001) {
        const fits = capMm.value / over;
        detailWarning.value =
          `Too big for the field. This is ${drawnW.toFixed(0)} by ${drawnH.toFixed(0)} mm ` +
          `on a ${machine.fieldW.toFixed(0)} by ${machine.fieldH.toFixed(0)} mm target, so the ` +
          `beam runs past the edge of its travel and the drawing will not survive it. ` +
          (source.value === "text"
            ? `A cap height of about ${fits.toFixed(0)} mm fits, or use fewer characters.`
            : `Scale it to about ${(100 / over).toFixed(0)} percent.`);
      } else
      /* Eight is the rough floor for a shape to read at all. Below it no amount of
       * planning helps, because the machine cannot place the ink. */
      detailWarning.value =
        featureSteps < 8
          ? `Too fine for this machine. ${source.value === "text" ? "Each character" : "The drawing"} is about ` +
            `${featureSteps.toFixed(0)} resolvable steps across, and it takes roughly 8 to read as a shape. ` +
            `One step is ${budget.effectiveMm.toFixed(2)} mm on your target. ` +
            `Draw it larger, use fewer characters${p.caps.dither && !machine.dither ? ", or turn dither on" : ""}.`
          : null;

      /* Emit the wire stream from the plan. Hermite when the board negotiated it,
       * which is what lets one segment carry a whole acceleration phase. */
      const em = emitSegments(tl, p, {
        cal,
        /* Hermite is a WIRE capability, negotiated per board, not a property of the
         * machine kind. A board that never reported it gets chord tangents and the
         * cubic collapses to the straight line an old sender expects. Simulator mode
         * assumes the good path so the preview shows what a modern board will do. */
        hermite: wireCaps()?.herm ?? true,
        tolMm: Math.min(toleranceMm.value, 0.08),
      });
      wire.value = em.segments;
      wireWorstMm.value = em.worstMm;
      wireMerged.value = em.merged;

      estimate.value = tl.dur < 90 ? `${tl.dur.toFixed(1)} s` : `${(tl.dur / 60).toFixed(1)} min`;
      health.value =
        `${placed.length} strokes, ${tl.drawLen.toFixed(0)} mm drawn, ` +
        `peak ${tl.peak.toFixed(0)} mm/s, spread ${result.spreadMm.toFixed(3)} mm`;
    } catch (e) {
      log.err(e instanceof Error ? e.message : String(e));
      planned.value = false;
    }
  }

  /* Sketching straight onto the target. A new point only when it has moved far
   * enough to be a real one, so a shaky hand does not produce a thousand points. */
  function onAim(p: Point) {
    if (source.value !== "sketch") return;
    /* A press with no drag is not a stroke, so nothing is committed until the
     * pointer has actually travelled. */
    sketchLive = [p];
    sketchOpen = false;
  }
  function onDraw(p: Point) {
    if (source.value !== "sketch" || !sketchLive) return;
    const last = sketchLive[sketchLive.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) > 1.2) {
      sketchLive.push(p);
      /* Replaced wholesale, never mutated: the canvas watches the stroke list by
       * identity, because deep watching thousands of points is what made the preview
       * crawl. A mutation in place would never repaint. */
      const live = sketchLive.slice();
      sketch.value = sketchOpen ? [...sketch.value.slice(0, -1), live] : [...sketch.value, live];
      sketchOpen = true;
      rebuild();
    }
  }
  function onDrawEnd() {
    /* Nothing to commit. The stroke has been in the list since its first accepted
     * point and the last onDraw already replanned against it. */
    sketchLive = null;
    sketchOpen = false;
  }
  function clearSketch() {
    sketch.value = [];
    sketchLive = null;
    sketchOpen = false;
    rebuild();
  }

  const isPatternSource = computed(() => ["lash", "ruler", "square", "ramp"].includes(source.value));
  const is3d = computed(() =>
    ["cube", "tesseract", "ico", "knot", "sphere", "lissajous"].includes(source.value),
  );

  return {
    source, text, capMm, face, tracking, scalePct, toleranceMm,
    capToFitMm, fitTextToField,
    rotateDeg, offX, offY, mirrorX, mirrorY,
    reorder, unidirectional, showIdeal, showLattice,
    yaw, pitch, detail, spin,
    svgText, image, imgThreshold, imgPitchSteps, imgInvert,
    sketch, strokes, simulated, planned, clipped, commandCount, estimate, health,
    timeline, sim, spreadMm, resolutionMm, stepsAcross, detailWarning,
    wire, wireWorstMm, wireMerged,
    isPatternSource, is3d,
    rebuild, onAim, onDraw, onDrawEnd, clearSketch, stepMm,
  };
});
