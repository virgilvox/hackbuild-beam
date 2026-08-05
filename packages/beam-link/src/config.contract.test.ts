import { describe, expect, it } from "vitest";
import {
  detentConfigLines,
  washerConfigLine,
  type DetentBoardConfig,
  type WasherBoardConfig,
} from "./config.js";

/*
 * A config patch has to actually carry something.
 *
 * The serialiser skips undefined fields, which is right: a patch is a partial and
 * the caller decides what to write. The failure mode that hides behind it is a
 * caller whose field NAMES are wrong. Every field is then undefined, every field
 * is skipped, and the result is a syntactically perfect line that sets nothing.
 * No error is raised anywhere, on either side.
 *
 * That is not hypothetical. The app built its patch from its own vocabulary
 * (`throwMm`, `fieldW`, `mountHMm`, `invA`, `minA`) and pushed it at both boards.
 * The servo board's config uses `distMm`, `wallW`, `wallH`, `mountH`, so not one
 * field matched and `push` sent the bare string "CFG ". The stepper board's config
 * happens to share `throwMm` and `fieldW`, so geometry got through and the
 * inversions and limits, which it calls `invX` and `minX`, silently did not.
 *
 * It also hides itself: connect adopts the board's config, so a lost write shows up
 * as the app reverting to the old value on the next reconnect rather than as a
 * failure at the time.
 *
 * So these tests assert the shape of the CONTRACT rather than any one caller: a
 * patch that means to set something must produce a line that sets it, and a patch
 * of foreign names must not quietly look like success.
 */

describe("washer config line", () => {
  it("writes every field it was given", () => {
    const line = washerConfigLine({
      distMm: 200,
      wallW: 400,
      wallH: 300,
      mountH: 70,
      dither: true,
      leadPan: 3,
      leadTilt: 1.5,
    });
    for (const kv of ["ds=200", "ww=400", "wh=300", "mh=70", "dit=1", "ffp=3", "fft=1.5"]) {
      expect(line).toContain(kv);
    }
  });

  it("carries dither and lead, which the firmware implements and nothing was sending", () => {
    /* Both are the difference between legible text and not on this rig, and both
     * were absent from every patch the app built. Named separately from the field
     * sweep above so the reason survives if that test is ever loosened. */
    expect(washerConfigLine({ dither: true })).toContain("dit=1");
    expect(washerConfigLine({ dither: false })).toContain("dit=0");
    expect(washerConfigLine({ leadPan: 2.5 })).toContain("ffp=2.5");
    expect(washerConfigLine({ leadTilt: 0 })).toContain("fft=0");
  });

  it("produces an empty line for an empty patch, and only for an empty patch", () => {
    /* The bare header is the signature of the bug. It is legitimate for a patch
     * that genuinely sets nothing, and it is what a wrongly named patch produces,
     * so callers are checked against it below rather than the serialiser being
     * made to throw. */
    expect(washerConfigLine({}).trim()).toBe("CFG");
  });

  it("sets nothing when handed the stepper board's vocabulary", () => {
    const foreign = { throwMm: 200, fieldW: 400, fieldH: 300, invX: true, minX: -10 };
    expect(washerConfigLine(foreign as Partial<WasherBoardConfig>).trim()).toBe("CFG");
  });
});

describe("detent config lines", () => {
  it("writes geometry, inversions and limits", () => {
    const lines = detentConfigLines({
      throwMm: 200,
      sepMm: 22,
      fieldW: 400,
      fieldH: 400,
      invX: true,
      invY: false,
      limitsOn: true,
      minX: -100,
      maxX: 100,
      minY: -50,
      maxY: 50,
    }).join("\n");
    expect(lines).toContain("G 200 22 400 400");
    /* The inversions and the limit values are the half that used to go missing. */
    expect(lines).toMatch(/\bI\b/);
    expect(lines).toMatch(/-100/);
    expect(lines).toMatch(/\b100\b/);
  });

  it("sets no geometry when handed the servo board's vocabulary", () => {
    const foreign = { distMm: 200, wallW: 400, wallH: 300, mountH: 70 };
    const lines = detentConfigLines(foreign as Partial<DetentBoardConfig>).join("\n");
    expect(lines).not.toMatch(/^G /m);
  });
});
