#!/usr/bin/env node
/*
 * Arduino sketch layout, checked before somebody finds out by compiling.
 *
 * Two rules, both of which this repo has already broken once. Neither shows up in
 * any test, any lint, or any amount of reading the code, because they are not about
 * the code: they are about which files the IDE decides belong together.
 *
 *   1. ONE SKETCH PER FOLDER. The IDE concatenates every .ino in a sketch folder
 *      into a single translation unit before compiling. Two sketches sharing a
 *      folder therefore collide on every symbol they both define, and both of these
 *      define PIN_X, HALFSTEP, setup and loop. Filing the bring-up sketch next to
 *      the firmware it helps debug is the obvious thing to do and it does not work.
 *
 *   2. FOLDER NAME EQUALS SKETCH NAME. The IDE will not open a sketch whose folder
 *      disagrees with it; it offers to move the file instead, which quietly
 *      relocates something a README is pointing at.
 *
 * Subfolders are fine and are how a companion sketch is filed: the IDE collects
 * .ino files from the sketch folder itself and does not recurse, so a sketch in a
 * subfolder is invisible to its parent and compiles on its own.
 *
 *   node tools/check-sketches.mjs
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIRMWARE = join(ROOT, "firmware");

/** Every directory under firmware/, including firmware itself. */
function dirsUnder(dir) {
  const out = [dir];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) out.push(...dirsUnder(p));
  }
  return out;
}

const problems = [];
let sketches = 0;

for (const dir of dirsUnder(FIRMWARE)) {
  const inos = readdirSync(dir).filter((f) => f.endsWith(".ino"));
  if (inos.length === 0) continue;
  sketches += inos.length;
  const rel = dir.replace(ROOT + "/", "");

  if (inos.length > 1) {
    problems.push(
      `${rel}/ holds ${inos.length} sketches: ${inos.join(", ")}\n` +
        `    The IDE compiles them as one file, so every shared symbol collides.\n` +
        `    Give each its own folder, nested here is fine.`,
    );
  }
  for (const ino of inos) {
    const want = basename(ino, ".ino");
    if (basename(dir) !== want) {
      problems.push(
        `${rel}/${ino} is in a folder called "${basename(dir)}"\n` +
          `    Arduino needs the folder to be called "${want}".`,
      );
    }
  }
}

if (problems.length) {
  process.stderr.write("sketch layout:\n\n");
  for (const p of problems) process.stderr.write("  " + p + "\n\n");
  process.exit(1);
}

process.stderr.write(`sketch layout: ${sketches} sketches, one per folder, all named to match\n`);
