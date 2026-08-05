#!/usr/bin/env node
/*
 * A static server with no dependencies, for two jobs:
 *
 *   1. Serving the engine bench, which imports beam-core's built ESM directly. A
 *      browser will not load ES modules from file://, so this exists.
 *   2. Serving the two original tools, so they can be opened side by side with the
 *      bench and driven against real hardware from the same origin.
 *
 * Web Serial and Web Bluetooth both need a secure context. http://localhost counts
 * as one in Chromium, so hardware works from here.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? ".");
const PORT = Number(process.env.PORT ?? 8173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
  ".ino": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".stl": "application/octet-stream",
  ".woff2": "font/woff2",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/tools/bench/index.html";

    /* Contain the served tree. A dev server that will hand out anything above its
     * root is a bad habit even on localhost. */
    const target = join(ROOT, normalize(path));
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end("outside the served root");
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || info.isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found: " + path);
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": TYPES[extname(target)] ?? "application/octet-stream",
      /* No caching: this is a bench, and a stale module is a confusing bench. */
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`beam bench   http://localhost:${PORT}/`);
  console.log(`washer tool  http://localhost:${PORT}/originals/laserriggg%20(1)/laser-rig.html`);
  console.log(`detent tool  http://localhost:${PORT}/originals/files%20(44)/detent-plot.html`);
  console.log(`serving      ${ROOT}`);
});
