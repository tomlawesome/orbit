// The composite container entry (#450, decision on #411): the Next.js
// application and the v19 front end served by ONE process on ONE socket,
// dispatched by path (scripts/v19-dispatch.mjs). Not a proxy — both handlers
// run in this process, so there is exactly one origin and the __Host- session
// cookie and assertSameOrigin write protection work unchanged.
//
// This file replaces Next's generated standalone entry (`node server.js`) as
// the image CMD. It reproduces that entry's environment exactly — NODE_ENV,
// chdir, PORT/HOSTNAME, keep-alive — and reads the Next config from
// .next/required-server-files.json, the same source the generated entry
// inlines, so a Next upgrade cannot drift a duplicated config literal.
//
// Fail-closed: if either application is missing or fails to load, the
// process exits nonzero at startup. A container must never serve a half-app.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isV19Path } from "./v19-dispatch.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");

process.env.NODE_ENV = "production";
process.chdir(dir);

const port = Number.parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOSTNAME || "0.0.0.0";

let keepAliveTimeout = Number.parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10);
if (
  Number.isNaN(keepAliveTimeout) ||
  !Number.isFinite(keepAliveTimeout) ||
  keepAliveTimeout < 0
) {
  keepAliveTimeout = undefined;
}

function fatal(stage, error) {
  console.error(`Orbit composite entry: ${stage} failed; refusing to serve a half-app.`);
  console.error(error);
  process.exit(1);
}

let nextHandler;
try {
  const requiredServerFiles = join(dir, ".next/required-server-files.json");
  const { config } = JSON.parse(readFileSync(requiredServerFiles, "utf8"));
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
  // Resolve `next` exactly as the generated server.js would: against the
  // standalone bundle's own node_modules, not anything on NODE_PATH.
  const require = createRequire(join(dir, "server.js"));
  const next = require("next");
  const app = next({ dev: false, dir, hostname, port, conf: config });
  nextHandler = app.getRequestHandler();
  await app.prepare();
} catch (error) {
  fatal("loading the Next.js application (.next/required-server-files.json)", error);
}

let v19Handler;
try {
  ({ handler: v19Handler } = await import(
    pathToFileURL(join(dir, "web/handler.js")).href
  ));
} catch (error) {
  fatal("loading the v19 front end (web/handler.js)", error);
}

const server = createServer((req, res) => {
  // req.url is origin-form; the base is only to satisfy the URL parser.
  let pathname;
  try {
    ({ pathname } = new URL(req.url, "http://composite.internal"));
  } catch {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }
  if (isV19Path(pathname)) {
    // adapter-node's handler owns every path the table sends it (assets,
    // prerendered, SSR); the fallthrough exists only for handler contract
    // completeness and must answer, not hang.
    v19Handler(req, res, () => {
      res.statusCode = 404;
      res.end("Not Found");
    });
  } else {
    nextHandler(req, res);
  }
});

if (keepAliveTimeout !== undefined) {
  server.keepAliveTimeout = keepAliveTimeout;
}

server.listen(port, hostname, () => {
  console.log(
    `Orbit composite entry: Next.js and the v19 front end on one origin at http://${hostname}:${port}`,
  );
});
