import { beforeEach, describe, expect, it } from "vitest";
import { hbUid, resetHbUid } from "./uid";

describe("hbUid", () => {
  beforeEach(() => {
    resetHbUid();
  });

  /*
   * Two controls sharing an id means one label points at the wrong box, and in a
   * rail of twelve numbers that is a value pushed to a board by mistake.
   */
  it("never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(hbUid("hb-num"));
    expect(seen.size).toBe(1000);
  });

  it("keeps the prefix and defaults it", () => {
    expect(hbUid("hb-rng")).toBe("hb-rng-1");
    expect(hbUid()).toBe("hb-2");
  });

  /* Ids go straight into an HTML id attribute and a CSS-unsafe one breaks
   * `label[for]` lookups in older engines. */
  it("produces an id that is valid unquoted in a selector", () => {
    expect(hbUid("hb-sel")).toMatch(/^[A-Za-z][A-Za-z0-9\-_]*$/);
  });
});
