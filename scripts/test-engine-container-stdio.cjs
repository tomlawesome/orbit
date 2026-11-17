"use strict";
// Preloaded (`node --require`) into the engine the test shims run in place of
// `docker run ... orbit.js` (#1861). In a real install the engine runs in a
// container: Docker sits between it and the launcher, so a launcher that went
// away and closed its pipes never makes the engine's own writes fail. Here the
// engine shares install.sh's stdout and stderr directly, and without this a
// closed pipe ends it with an unhandled EPIPE (install.rollback.test.mjs,
// #1456) where a container would have carried on. Write errors are dropped,
// as they never reach a containerised engine.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
