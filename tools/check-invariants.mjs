#!/usr/bin/env node
/*
 * Keep the invariant registry and its citations honest.
 *
 * This exists because the citations rotted once already, silently. The registry was
 * reorganised into sections, everything got renumbered, and nine comments in the
 * source carried on pointing at their old numbers. Every one of those numbers still
 * existed, so an existence check passed while the citations meant something else
 * entirely: a comment about the adjugate inverse pointing at an invariant about
 * duration residuals.
 *
 * A registry whose references do not resolve to the right thing is worse than no
 * registry, because it looks rigorous.
 *
 * Hard failures: a citation with no matching entry, or a number defined twice.
 * Warnings: a citation whose surrounding prose shares almost no vocabulary with the
 * entry it points at, which is the signature of exactly the rot above.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const REGISTRY = "docs/invariants.md";
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "originals", "coverage"]);
const EXTS = new Set([".ts", ".js", ".mjs", ".md", ".css", ".yml", ".ino", ".h"]);

const STOP = new Set(
  ("the a an and or of to in is it be that this those these on at by for with from as not " +
    "which what when where why how its it's one two both each every any all no never always " +
    "must should can may will would could than then so if but because there here their they " +
    "we you i are was were been being have has had do does did done get got make made use used " +
    "inv both washer detent porting pinned open cost test why note")
    .split(/\s+/),
);

function words(s) {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(p))) out.push(p);
  }
  return out;
}

/* ------------------------------------------------------- parse the registry -- */

const reg = readFileSync(REGISTRY, "utf8");
const entries = new Map();
const dupes = [];

/* The terminator must include end-of-input, or the last entry in the file never
 * parses. `\Z` is Python, not JavaScript: in a JS regex it is a literal Z, which is
 * why the final invariant silently went missing the first time this ran. */
const defRe = /^\*\*(INV-\d+[a-z]?)\s[^\n]*?\*\*([\s\S]*?)(?=^\*\*INV-|^##|$(?![\s\S]))/gm;
for (const m of reg.matchAll(defRe)) {
  const id = m[1];
  if (entries.has(id)) dupes.push(id);
  entries.set(id, m[2].trim());
}

/* --------------------------------------------------------- find citations -- */

const problems = [];
const warnings = [];

for (const file of walk(".")) {
  if (file.endsWith(REGISTRY)) continue;
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/\bINV-(\d+[a-z]?)\b/g)) {
      const id = `INV-${m[1]}`;
      if (!entries.has(id)) {
        problems.push(`${file}:${i + 1}  cites ${id}, which the registry does not define`);
        continue;
      }
      /* Context is the citing line plus a few either side, which is where the
       * explanation of what the invariant says actually lives. */
      const ctx = lines.slice(Math.max(0, i - 2), i + 6).join(" ");
      const a = words(ctx);
      const b = words(entries.get(id));
      let shared = 0;
      for (const w of a) if (b.has(w)) shared++;
      const overlap = b.size ? shared / Math.min(a.size || 1, b.size) : 1;
      if (shared < 2 && overlap < 0.08) {
        warnings.push(
          `${file}:${i + 1}  cites ${id} but shares almost no vocabulary with it\n` +
            `      registry says: ${entries.get(id).split("\n")[0].slice(0, 90)}`,
        );
      }
    }
  }
}

for (const d of new Set(dupes)) problems.push(`${REGISTRY}: ${d} is defined more than once`);

/* ------------------------------------------------------------------ report -- */

console.log(`invariants: ${entries.size} defined`);
for (const w of warnings) console.log(`  warn  ${w}`);
if (problems.length) {
  console.error("\nFAIL");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(warnings.length ? `  ${warnings.length} warning(s), no hard failures` : "  all citations resolve");
