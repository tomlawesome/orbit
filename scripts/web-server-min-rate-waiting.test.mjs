import { EventEmitter } from "node:events";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * #1390 second review, F1: the body-rate floor follows the standard pattern of
 * Kestrel's MinRequestBodyDataRate. The rate is measured only over time the
 * server is waiting for the client (the request is not paused), added up
 * across pauses: every 30 s of such waiting time must bring at least 30 KiB or
 * the socket is destroyed. A pause in a wall-clock window does not excuse the
 * window (the first design skipped any window with a pause, so a route that
 * paused briefly in every window shielded a client sending nothing).
 *
 * Same harness as web-server-min-rate.test.mjs: the real shim in this
 * process, fake timers, a stand-in request that emits `pause` and `resume`
 * the way adapter-node's body reader does.
 */

const SHIM = fileURLToPath(new URL("./web-server.mjs", import.meta.url));
const WINDOW_MS = 30_000;
const KIB = 1024;

const FIXTURE_ADAPTER = `
import http from "node:http";
export const server = http.createServer();
`;

const scratch = [];
const savedEnv = { ORIGIN: process.env.ORIGIN, PROTOCOL_HEADER: process.env.PROTOCOL_HEADER, HOST_HEADER: process.env.HOST_HEADER };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The shim, freshly loaded beside the fixture adapter; resolves to the adapter's server. */
async function loadShim() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-web-server-min-rate-"));
  scratch.push(dir);
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(dir, "index.js"), FIXTURE_ADAPTER);
  copyFileSync(SHIM, join(dir, "server.mjs"));
  process.env.ORIGIN = "https://orbit.example.test";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await import(pathToFileURL(join(dir, "server.mjs")).href);
  const { server } = await import(pathToFileURL(join(dir, "index.js")).href);
  return server;
}

/** A stand-in request and response: the socket counts bytes the test says arrived. */
function connection() {
  const socket = new EventEmitter();
  socket.bytesRead = 0;
  socket.destroyed = false;
  socket.destroy = vi.fn(() => { socket.destroyed = true; socket.emit("close"); });
  const request = new EventEmitter();
  request.socket = socket;
  request.complete = false;
  request.headers = {};
  request.method = "POST";
  request.url = "/api/portable-archives/import";
  const response = new EventEmitter();
  response.setHeader = vi.fn();
  response.headersSent = false;
  response.writableEnded = false;
  const finish = () => { request.complete = true; request.emit("end"); request.emit("close"); };
  return { socket, request, response, finish };
}

function deliver(server, request, response) {
  server.emit("request", request, response);
}


/** Runs `seconds` of fake time one second at a time, calling `each(second)` first. */
async function run(seconds, each) {
  for (let second = 0; second < seconds; second += 1) {
    each?.(second);
    await vi.advanceTimersByTimeAsync(1_000);
  }
}

describe("F1: the rate is judged over the time the server waits for the client, added up across pauses", () => {
  it("cuts a client that sent two quick packets while the route was busy and then one byte every 29 s, once 30 s of waiting time has gone by, though every 30 s window holds a pause", async () => {
    // Catches skipping any window that held a pause: the route pausing for one second in every window would shield a client sending nothing, for ever.
    vi.useFakeTimers();
    const server = await loadShim();
    const { socket, request, response } = connection();
    deliver(server, request, response);
    request.emit("pause");               // the route is busy at the start
    socket.bytesRead += 8 * KIB;         // two quick packets
    socket.bytesRead += 8 * KIB;
    let waitingSeconds = 0;
    let cutAtWaiting = null;
    await run(120, (second) => {
      // From second 10: 14 s waiting, then 1 s paused, over and over, so every wall window has a pause.
      const phase = (second - 10) % 15;
      if (second === 10) request.emit("resume");
      else if (second > 10 && phase === 0) request.emit("resume");
      else if (second > 10 && phase === 14) request.emit("pause");
      if (second >= 10 && phase !== 14) waitingSeconds += 1;
      if (second % 29 === 28) socket.bytesRead += 1;
      if (cutAtWaiting === null && socket.destroy.mock.calls.length > 0) cutAtWaiting = waitingSeconds;
    });
    if (cutAtWaiting === null && socket.destroy.mock.calls.length > 0) cutAtWaiting = waitingSeconds;
    expect(socket.destroy, "cut after 30 s of waiting with under 30 KiB").toHaveBeenCalled();
    // 30 s of waiting passed by wall second ~42; the sample runs on a 30 s tick, so within two ticks.
    expect(cutAtWaiting).toBeLessThanOrEqual(30 + 30);
    expect(cutAtWaiting).toBeGreaterThanOrEqual(30);
  });

  it("does not cut a client that keeps up during every wait, however long the server works between waits", async () => {
    // Guards the other side of the rule: time the server spends working is not the client's time. Five minutes of work, then 30 s of waiting that brings 64 KiB, six times over.
    vi.useFakeTimers();
    const server = await loadShim();
    const { socket, request, response, finish } = connection();
    deliver(server, request, response);
    request.emit("pause");
    for (let round = 0; round < 6; round += 1) {
      await run(300);                    // the route works; nothing is read, nothing arrives
      request.emit("resume");
      await run(30, (second) => { if (second % 5 === 0) socket.bytesRead += 11 * KIB; });
      request.emit("pause");
    }
    expect(socket.destroy).not.toHaveBeenCalled();
    request.emit("resume");
    finish();
  });

  it("still cuts a client that sends nothing while the server only waits (30 s, no pauses)", async () => {
    // Guard: the plain stall is still cut within two windows.
    vi.useFakeTimers();
    const server = await loadShim();
    const { socket, request, response } = connection();
    deliver(server, request, response);
    await vi.advanceTimersByTimeAsync(2 * WINDOW_MS + 1_000);
    expect(socket.destroy).toHaveBeenCalled();
  });
});
