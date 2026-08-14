#!/usr/bin/env node
/**
 * Test-harness static server. Serves the ratified mockups and the self-hosted
 * font so the gate can compare a newly-built screen against its design.
 *
 * Deliberately part of the test rig and nothing else — the mockups are served
 * to the owner from the separate preview host, not from here.
 *
 * The mockups <link> Space Grotesk from fonts.googleapis.com; the app
 * self-hosts it. The harness points the mockup at the same local files so the
 * comparison is about design rather than font delivery, and so the gate works
 * with no network at all.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");

const ROOTS = {
  "/design/": resolve(repo, "design"),
  "/fonts/": resolve(repo, "web/node_modules/@fontsource/space-grotesk/files"),
  /* The app self-hosts all three faces (#418). The mockups fetch only Space
     Grotesk and let Inter and JetBrains Mono fall back to whatever the host
     offers, so without these the gate would measure font delivery rather
     than design — the very thing the interception exists to prevent. */
  "/inter/": resolve(repo, "web/node_modules/@fontsource-variable/inter/files"),
  "/mono/": resolve(repo, "web/node_modules/@fontsource-variable/jetbrains-mono/files"),
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

const port = Number(process.argv[2] ?? 5174);

createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const mount = Object.keys(ROOTS).find((prefix) => path.startsWith(prefix));
  if (!mount) return void response.writeHead(404).end("not found");

  // normalize() collapses any ../ before it can escape the mounted directory.
  const file = join(ROOTS[mount], normalize(path.slice(mount.length)));
  if (!file.startsWith(ROOTS[mount]) || !existsSync(file) || !statSync(file).isFile()) {
    return void response.writeHead(404).end("not found");
  }

  response.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(response);
}).listen(port, () => console.log(`fidelity static server on :${port}`));
