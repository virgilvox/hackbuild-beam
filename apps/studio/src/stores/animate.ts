import { defineStore } from "pinia";
import { ref } from "vue";
import { useJob } from "./job";
import { useProject } from "./project";

/**
 * Spin advance per animation frame for the live preview.
 *
 * Straight from the detent tool. It is a phase step per frame rather than per second
 * because the whole pipeline is rebuilt inside the frame: on a machine that cannot
 * keep up, a per second rate would speed the tumble up to compensate and make the
 * preview both slow and jerky, where a per frame step just runs slower.
 */
export const PREVIEW_STEP = 0.012;

/**
 * Spin advance per plotted frame for LOOP, ten times the preview step.
 *
 * A plotted frame takes seconds, not sixteen milliseconds, so the same step would
 * produce a flipbook whose pages are indistinguishable from each other.
 */
export const LOOP_STEP = 0.12;

/**
 * The tumble clock.
 *
 * The detent tool shipped this and the first port of the app dropped it. It is one
 * number, `animT`, advanced on a frame driver, and the whole pipeline is rebuilt
 * against it every time it moves. Rebuilding everything per frame sounds expensive
 * and is not: a wireframe is tens of edges, and the honest preview of what the
 * machine will really draw only exists downstream of the planner and the simulator,
 * so there is nothing useful to cache in between.
 *
 * This store owns the clock and the project store only reads the phase. The
 * dependency deliberately points one way, so neither store has to construct the
 * other during its own setup.
 */
export const useAnimate = defineStore("animate", () => {
  const project = useProject();
  const job = useJob();

  const animOn = ref(false);
  /** True while LOOP is plotting frame after frame. Driven from the session facade. */
  const looping = ref(false);
  const animT = ref(0);
  /** Multiplier on the per frame advance. 1 is the detent tool's own tempo. */
  const rate = ref(1);

  /** The pending frame request, 0 when the driver is not running. */
  let raf = 0;

  /**
   * One writer for the phase the sources see.
   *
   * Zero unless something is actually animating, which is what makes ANIMATE off
   * snap back to the yaw and pitch sliders. The original gated this on the animate
   * flag alone, which left LOOP replotting one identical frame forever whenever
   * ANIMATE happened to be off; a flipbook of one page is not what the button says
   * it does, so looping counts as animating here.
   */
  function publish() {
    project.spin = animOn.value || looping.value ? animT.value : 0;
  }

  /** Advance the phase and rebuild the whole pipeline against the new pose. */
  function step(d: number) {
    animT.value += d;
    publish();
    project.rebuild();
  }

  function frame() {
    raf = 0;
    if (!animOn.value) return;
    /*
     * Never repave the road mid drive.
     *
     * A run streams the points the last rebuild produced. Rebuilding under it swaps
     * the geometry out from beneath a live beam, so what gets drawn is half of one
     * pose and half of another and neither of them is what the preview showed. LOOP
     * is the same rule from the other side: it advances its own phase between whole
     * frames, so the preview clock stays out of its way while it runs.
     */
    if (!job.running && !looping.value) step(PREVIEW_STEP * rate.value);
    raf = window.requestAnimationFrame(frame);
  }

  function start() {
    if (animOn.value) return;
    animOn.value = true;
    publish();
    project.rebuild();
    if (!raf) raf = window.requestAnimationFrame(frame);
  }

  function stop() {
    if (!animOn.value) return;
    animOn.value = false;
    if (raf) {
      window.cancelAnimationFrame(raf);
      raf = 0;
    }
    /* animT is kept rather than zeroed: pressing ANIMATE again picks the tumble up
     * where it was left instead of snapping back to the start. */
    publish();
    project.rebuild();
  }

  function toggle() {
    if (animOn.value) stop();
    else start();
  }

  /** LOOP is starting. The preview driver stands down until it is finished. */
  function beginLoop() {
    looping.value = true;
    publish();
  }

  /** LOOP is over, by request or by failure. Put the preview back where it was. */
  function endLoop() {
    looping.value = false;
    publish();
    project.rebuild();
  }

  return { animOn, looping, animT, rate, step, start, stop, toggle, beginLoop, endLoop };
});
