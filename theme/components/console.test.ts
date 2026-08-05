import { describe, expect, it } from "vitest";
import { capLines, HB_CONSOLE_MAX, type HbConsoleLine } from "./console";

function lines(n: number): HbConsoleLine[] {
  return Array.from({ length: n }, (_, i) => ({ text: `line ${i}`, level: "rx" as const }));
}

describe("capLines", () => {
  it("keeps the newest and drops the oldest", () => {
    const out = capLines(lines(10), 3);
    expect(out.map((l) => l.text)).toStrictEqual(["line 7", "line 8", "line 9"]);
  });

  /*
   * The common case is a log under the cap, on every render, for the whole life of
   * the app. Returning the input untouched is what keeps that free.
   */
  it("returns the same array when it is already under the cap", () => {
    const src = lines(5);
    expect(capLines(src, 400)).toBe(src);
    expect(capLines(src, 5)).toBe(src);
  });

  it("copies rather than mutating when it trims", () => {
    const src = lines(6);
    const out = capLines(src, 2);
    expect(out).not.toBe(src);
    expect(src.length).toBe(6);
  });

  it("handles a zero or negative cap without throwing", () => {
    expect(capLines(lines(4), 0)).toStrictEqual([]);
    expect(capLines(lines(4), -1)).toStrictEqual([]);
  });

  it("handles an empty log", () => {
    const src: HbConsoleLine[] = [];
    expect(capLines(src, 400)).toBe(src);
  });

  /*
   * 400 is the servo tool's node cap, ported rather than picked. See console.ts.
   */
  it("defaults to the ported cap", () => {
    expect(HB_CONSOLE_MAX).toBe(400);
    expect(capLines(lines(500), HB_CONSOLE_MAX).length).toBe(400);
  });
});
