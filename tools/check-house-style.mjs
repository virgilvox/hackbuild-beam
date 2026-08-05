#!/usr/bin/env node
/*
 * House style for the files ESLint does not see.
 *
 * The eslint plugin covers .ts and .js. It does not cover .html, .vue, .css or .md,
 * which is where nearly all UI copy is going to live once the app exists: templates,
 * the theme components, the manual, the inline explainers. That is precisely where
 * the rule is worth having, so it cannot be the part that is unenforced.
 *
 * Same two rules as the plugin: no em dashes, no en dashes, no emoji.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "originals", "coverage", ".pio"]);
const SKIP_FILES = new Set(["pnpm-lock.yaml"]);
const EXTS = new Set([".html", ".vue", ".css", ".md", ".yml", ".yaml", ".json", ".svg"]);

const DASHES = [
  ["—", "em dash"],
  ["–", "en dash"],
  ["―", "horizontal bar"],
  ["‒", "figure dash"],
];
const EMOJI = /\p{Extended_Pictographic}/u;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(p))) out.push(p);
  }
  return out;
}

const problems = [];
let scanned = 0;

for (const file of walk(".")) {
  scanned++;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const [ch, name] of DASHES) {
      if (line.includes(ch)) {
        problems.push(`${file}:${i + 1}  ${name}. Use a plain ASCII hyphen, a comma, or two sentences.`);
      }
    }
    if (EMOJI.test(line)) {
      problems.push(`${file}:${i + 1}  emoji. Icons are inline SVG.`);
    }
  });
}

console.log(`house style: ${scanned} non-script files scanned`);
if (problems.length) {
  console.error("\nFAIL");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("  clean");
