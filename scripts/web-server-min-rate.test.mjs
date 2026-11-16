import { EventEmitter } from "node:events";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * #1390 (design note §6.2): the start-up shim is the body-rate floor for every
 * route, kit's own drain included. On every request it samples
 * `request.socket.bytesRead` every 30 s while `request.complete` is false,
 * before and after the answer alike, and destroys the socket when fewer than
 * 30 KiB arrived in a window (1 KiB/s, Apache mod_reqtimeout's MinRate).
 * Sampling reads no body and adds no `data` listener.
 *
 * Runs the real shim in this process with fake timers: the shim is copied
 * beside a fixture `index.js` (the seam scripts/web-server.test.mjs pins),
 * imported, and handed a stand-in request whose socket counts bytes.
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

describe("§6.2: the shim cuts a body arriving under 30 KiB per 30 s window", () => {
  it("destroys the socket of a drained body at one byte per 29 s within 60 s, after the answer was sent", async () => {
    // Catches requestTimeout = 0 with nothing in its place: kit's own drain (its CSRF 403) would wait on this body for ever.
    vi.useFakeTimers();
    const server = await loadShim();
    const { socket, request, response } = connection();
    deliver(server, request, response);
    // Kit has answered; the body is still being drained.
    response.headersSent = true;
    response.writableEnded = true;
    response.emit("finish");
    const drip = setInterval(() => { socket.bytesRead += 1; }, 29_000);

    await vi.advanceTimersByTimeAsync(60_000);
    clearInterval(drip);
    expect(socket.destroy, "cut within two windows").toHaveBeenCalled();
  });

  it("destroys the socket of a body sending 29 KiB per window before any answer", async () => {
    // Catches a threshold looser than 30 KiB per 30 s, or sampling only after the answer.
    vi.useFakeTimers();
    const server = await loadShim();
    const { socket, request, response } = connection();
    deliver(server, request, response);
    const trickle = setInterval(() => { socket.bytesRead += 29 * KIB; }, WINDOW_MS - 1);

    await vi.advanceTimersByTimeAsync(2 * WINDOW_MS + 1_000);
    clearInterval(trickle);
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("does not cut an archive upload at 1 MiB/s for 400 s", async () => {
    // Catches a whole-request deadline coming back in another form, or a window that miscounts a fast body.
    vi.useFakeTimers();
    const server = await loadShim();
    const { socket, request, response, finish } = connection();
    deliver(server, request, response);
    const upload = setInterval(() => { socket.bytesRead += 1024 * KIB; }, 1_000);

    await vi.advanceTimersByTimeAsync(400_000);
    clearInterval(upload);
    finish();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("stops sampling once the body is complete: a finished request on an idle keep-alive socket is not cut", async () => {
    // Catches sampling that outlives the request and kills an idle keep-alive connection.
    vi.useFakeTimers();
    const server = await loadShim();
    const { socket, request, response, finish } = connection();
    deliver(server, request, response);
    socket.bytesRead += 500;
    finish();

    await vi.advanceTimersByTimeAsync(5 * WINDOW_MS);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("reads no body: it attaches no data or readable listener to the request", async () => {
    // Catches a rate check that counts by reading the body (it would consume what kit and the routes read).
    vi.useFakeTimers();
    const server = await loadShim();
    const { request, response, finish } = connection();
    deliver(server, request, response);
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(request.listenerCount("data")).toBe(0);
    expect(request.listenerCount("readable")).toBe(0);
    finish();
  });
});
