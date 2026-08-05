/*
 * What to do with the machine you just connected.
 *
 * Both original tools carried this knowledge and neither surfaced it well. The
 * stepper tool had a manual behind a modal whose quickstart order is load bearing
 * (leave limits off until you have found the edges, capture corners in TL TR BR BL,
 * solve, check the residual, only then derive limits and persist). The servo tool
 * had it scattered through fifteen inline explainers, each one a measured fact that
 * cost bench time to learn.
 *
 * Here it is one thing: a per machine procedure the app can walk you through, with
 * each step knowing how to tell whether it is already done. Connect a rig and the
 * app knows which procedure applies, because the profile came from the board rather
 * than from a dropdown.
 */

import type { MachineProfile } from "@virgilvox/beam-core";

export interface SetupStep {
  id: string;
  title: string;
  /** What to do, in the imperative. One or two sentences. */
  body: string;
  /** Why it is in this position in the order. Omitted where the order is arbitrary. */
  why?: string;
  /** Which panel this step happens in, so the app can point at it. */
  panel: string;
  /** True when the current state says this step is already satisfied. */
  done: (s: SetupState) => boolean;
  /** Shown as a warning rather than an instruction. */
  caution?: string;
}

/** Everything a step needs to decide whether it has happened. */
export interface SetupState {
  connected: boolean;
  adopted: boolean;
  invertChecked: boolean;
  cornersCaptured: number;
  mappingSolved: boolean;
  residualMm: number | null;
  limitsDerived: boolean;
  limitsOn: boolean;
  persisted: boolean;
  originSet: boolean;
  hasContent: boolean;
  planned: boolean;
}

export interface MachineGuide {
  /** One line, shown under the machine name. */
  summary: string;
  /** The physical thing, in plain terms. */
  what: string;
  steps: SetupStep[];
  /** Facts worth knowing that are not steps. Ported from the inline explainers. */
  facts: { title: string; body: string }[];
  /** Things that will hurt the rig or the operator. */
  cautions: string[];
}

const SHARED_STEPS = {
  connect: {
    id: "connect",
    title: "Connect",
    body: "Connect over USB or Bluetooth. The app reads the board's stored setup and adopts it, so a reload costs you nothing.",
    why: "The board is bolted to the wall, so it is the authority on how it is installed. Nothing is pushed to it until you ask.",
    panel: "link",
    done: (s: SetupState) => s.connected && s.adopted,
  },
  content: {
    id: "content",
    title: "Choose something to draw",
    body: "Pick a source: text, an SVG, an image, a 3D model, or sketch straight onto the target.",
    panel: "content",
    done: (s: SetupState) => s.hasContent,
  },
  plan: {
    id: "plan",
    title: "Plan and preview",
    body: "The preview shows what the machine will actually do, flaws included, not the ideal path. If the two disagree, believe the preview.",
    panel: "path",
    done: (s: SetupState) => s.planned,
  },
} as const;

/* ------------------------------------------------------------ detent-28byj -- */

const DETENT: MachineGuide = {
  summary: "Two mirrors on geared steppers. Slow, repeatable, and it will not tell you when it skips.",
  what:
    "Two 28BYJ-48 motors each turn a mirror. The first mirror swings the beam sideways, the second lifts it. " +
    "One half step is about 0.088 degrees of mirror and twice that of beam, and that is the finest move it has: " +
    "the ULN2003 driver has no current control, so there is no microstepping to reach for.",

  steps: [
    SHARED_STEPS.connect,
    {
      id: "invert",
      title: "Leave limits off and fix the directions",
      body: "Jog each axis and check the beam moves the way you expect. If an axis goes the wrong way, flip its invert. Inversion is a wiring correction, so it changes the hardware and never the preview.",
      why: "Limits stay off until you know where the edges are. Free jog is how you find them.",
      panel: "motion",
      done: (s) => s.invertChecked,
    },
    {
      id: "origin",
      title: "Set the origin",
      body: "Steer to the middle of where you want to draw and zero there. There are no limit switches, so home is wherever you say it is.",
      panel: "jog",
      done: (s) => s.originSet,
    },
    {
      id: "corners",
      title: "Capture four corners",
      body: "Beam on, steer to each corner of your target and capture, in the order top left, top right, bottom right, bottom left.",
      why: "The order is the order the solver expects. Capturing them out of order produces a map that looks solved and aims wrong.",
      panel: "corners",
      done: (s) => s.cornersCaptured >= 4,
      caution: "The beam is live while you do this. Know where it is pointing.",
    },
    {
      id: "solve",
      title: "Solve the mapping",
      body: "Solve, then read the residual. Under about 0.3 mm is a clean capture. If it warns that the quad aspect disagrees with your field, fit the field height to the quad.",
      why: "The residual is the honest check: it pushes each corner back through the solved map and measures how far it lands from where you actually put it.",
      panel: "corners",
      done: (s) => s.mappingSolved && s.residualMm !== null && s.residualMm < 0.5,
    },
    {
      id: "limits",
      title: "Derive limits, then enforce them",
      body: "Derive the soft limits from the four corners, then turn enforcement on.",
      why: "Now, not earlier: the limits come from the corners, so the corners have to exist first.",
      panel: "limits",
      done: (s) => s.limitsDerived && s.limitsOn,
    },
    {
      id: "rate",
      title: "Find the real speed ceiling",
      body: "Run the stall hunt. It blinks the beam at home before each pass; mark that spot. The first rate whose blink comes back somewhere else is past pull-out. Set the draw rate to about 70 percent of the last clean rate.",
      why: "A skipped step is geometry that is silently gone. There is no feedback and nothing will tell you it happened.",
      panel: "patterns",
      done: () => false,
      caution: "Above roughly 1000 half steps per second these motors start skipping.",
    },
    {
      id: "persist",
      title: "Save it to the board",
      body: "Persist the config. It writes to the board's flash, so the next session starts where this one ended.",
      panel: "motion",
      done: (s) => s.persisted,
    },
    SHARED_STEPS.content,
    SHARED_STEPS.plan,
  ],

  facts: [
    {
      title: "Backlash is two numbers, not one",
      body: "Comp is what the board applies at a reversal. Slack is what the gearbox actually has, measured with the lash gauge pattern. The preview shows you what those two disagreeing looks like on the wall: equal and they cancel, comp of zero against real slack gives you the classic doubled line.",
    },
    {
      title: "Measuring the slack",
      body: "Run the lash gauge. It draws the same line left to right then right to left. Measure the gap between the two traces, divide by the mm per step figure, and that is your lash in steps.",
    },
    {
      title: "The case aperture",
      body: "Beam deflection is about 0.177 degrees per step, so limits spanning N steps give a cone N times that wide. A window at distance d from the second mirror must be at least 2 d tan(half angle) across, plus the beam diameter.",
    },
    {
      title: "Coils get hot",
      body: "These motors cook if a phase is left energised all day, so the board releases them after an idle timeout. Re-energising holds the last phase for about 30 ms first, so the rotor pulls back into register before being asked to move.",
    },
  ],

  cautions: [
    "There is no feedback. If the motors skip, nothing detects it and the rest of the drawing is in the wrong place.",
    "The board kills the beam five seconds after the host goes quiet with nothing queued, and on any Bluetooth disconnect.",
  ],
};

/* ----------------------------------------------------------- washer-servo -- */

const WASHER: MachineGuide = {
  summary: "A pan and tilt head on two hobby servos. Fast, smooth, and it lies about where it is.",
  what:
    "Two servos aim a head: one swings it, one lifts it. Position is a pulse width in microseconds, " +
    "and the command chain is about eight times finer than the servo can actually resolve. That gap is " +
    "why dither exists.",

  steps: [
    SHARED_STEPS.connect,
    {
      id: "geometry",
      title: "Tell it how it is installed",
      body: "Set the throw to the target, the target size, and how high the head sits above the floor.",
      why: "The mount height is not cosmetic. The target sits on the floor so its centre is half its height up, while the head is lower, and the difference is what the tilt axis has to cover. Getting it wrong once drew an entire design 159 mm from where the beam was going.",
      panel: "geometry",
      done: (s) => s.adopted,
    },
    {
      id: "invert",
      title: "Fix the directions",
      body: "Jog each axis and check the beam moves the way you expect. Flip an invert if it does not.",
      panel: "motion",
      done: (s) => s.invertChecked,
    },
    {
      id: "origin",
      title: "Set the origin",
      body: "Aim at the centre of your target and zero there. That pulse pair becomes the design origin.",
      panel: "jog",
      done: (s) => s.originSet,
    },
    {
      id: "corners",
      title: "Capture four corners, if the geometry is awkward",
      body: "Optional. If the rig is off axis or the picture comes out skewed, capture the four corners and let the measured map correct it.",
      why: "The ideal model assumes the head is square to the target. Four corners absorb the ways it is not.",
      panel: "corners",
      done: (s) => s.cornersCaptured >= 4,
      caution: "The beam is live while you do this.",
    },
    {
      id: "smooth",
      title: "Check the smoothness readout",
      body: "Aim for at or above 2.5 deadband steps per frame, or far below one with dither on. The band between them is the bad one.",
      why: "The two axes are independent hysteresis quantisers. Near one step per frame they cross their deadbands at different moments, so a diagonal comes out as pan-pop, tilt-pop, pan-pop: the worst possible look, and slow with it. Holding the speed down does not help, which is the opposite of what everyone tries first.",
      panel: "path",
      done: () => false,
    },
    SHARED_STEPS.content,
    SHARED_STEPS.plan,
  ],

  facts: [
    {
      title: "What dither actually does",
      body: "It alternates the command a few microseconds either side of where the planner put it, once per servo frame. Measured against a modelled 9g servo it turns about 0.94 mm of direction-dependent error into roughly 0.35 mm of symmetric wobble. It is off by default because it holds both servos hunting all the time, which means constant buzzing and a lot more current than a servo that has settled.",
    },
    {
      title: "Lead straightens diagonals",
      body: "The pan servo hauls the whole tilt assembly, so it answers late and coordinated diagonals grow a hook at every stroke start. Two to four milliseconds of lead on pan straightens them without touching the geometry.",
    },
    {
      title: "A short throw is expensive",
      body: "It buys a big picture from a small rig, and it costs servo travel and bends the geometry hard at the edges. If the sweep runs past what your servos can reach, back the rig away or capture four corners and let the map sort it out.",
    },
    {
      title: "Mirroring",
      body: "Use it when the rig is firing at the back of something you read from the front, or when a fold-down mirror is turning the beam. Without it the writing comes out reversed, and you find out with a laser.",
    },
  ],

  cautions: [
    "The board cuts the beam if the link goes quiet with nothing queued, and it gates the beam off within 300 ms if a running job runs dry, because holding a lit beam at a dead stop burns a dot.",
  ],
};

/* ------------------------------------------------------------------ lookup -- */

const GUIDES: Record<string, MachineGuide> = {
  "detent-28byj": DETENT,
  "washer-servo": WASHER,
};

export function guideFor(profile: MachineProfile | null): MachineGuide | null {
  return profile ? (GUIDES[profile.id] ?? null) : null;
}

/** The first step that is not yet satisfied. This is what the app points at. */
export function nextStep(guide: MachineGuide | null, state: SetupState): SetupStep | null {
  if (!guide) return null;
  return guide.steps.find((s) => !s.done(state)) ?? null;
}

export function progress(guide: MachineGuide | null, state: SetupState): { done: number; total: number } {
  if (!guide) return { done: 0, total: 0 };
  return { done: guide.steps.filter((s) => s.done(state)).length, total: guide.steps.length };
}
