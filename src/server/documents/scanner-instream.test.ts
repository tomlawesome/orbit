import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { scanFileWithClamAv } from "./scanner";

/** The sender's INSTREAM behaviour against a slow receiver (#1571). */

type FakeState = { digest: string | null; bytes: number; chunks: number; terminated: boolean };

/** A clamd that parses `zINSTREAM\0` and the length-prefixed chunks, hashes every payload byte and answers clean. */
async function startFakeClamd(options: { pauseEvery?: number; destroyAfter?: number }) {
  const state: FakeState = { digest: null, bytes: 0, chunks: 0, terminated: false };
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const hash = createHash("sha256");
    let stage: "command" | "header" | "payload" = "command";
    let command = Buffer.alloc(0);
    let header = Buffer.alloc(0);
    let remaining = 0;
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (stage === "command") {
          const end = chunk.indexOf(0, offset);
          command = Buffer.concat([command, chunk.subarray(offset, end < 0 ? chunk.length : end)]);
          if (end < 0) return;
          if (command.toString("ascii") !== "zINSTREAM") return void socket.destroy();
          stage = "header";
          offset = end + 1;
        } else if (stage === "header") {
          const take = Math.min(4 - header.length, chunk.length - offset);
          header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
          offset += take;
          if (header.length < 4) continue;
          remaining = header.readUInt32BE(0);
          header = Buffer.alloc(0);
          if (remaining === 0) {
            state.terminated = true;
            state.digest = hash.digest("hex");
            return void socket.end(Buffer.from("stream: OK\0", "ascii"));
          }
          stage = "payload";
        } else {
          const take = Math.min(remaining, chunk.length - offset);
          hash.update(chunk.subarray(offset, offset + take));
          state.bytes += take;
          remaining -= take;
          offset += take;
          if (remaining > 0) continue;
          stage = "header";
          state.chunks += 1;
          if (state.chunks === options.destroyAfter) return void socket.destroy();
          if (options.pauseEvery && state.chunks % options.pauseEvery === 0) {
            // The sender's writes queue inside libuv while the receiver is not reading.
            socket.pause();
            setTimeout(() => socket.resume(), 20);
          }
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the fake clamd has no port");
  const close = () => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { port: address.port, state, close };
}

describe("INSTREAM sender (#1571)", () => {
  let directory = "";
  let filePath = "";
  let fileDigest = "";
  const closers: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "orbit-instream-"));
    filePath = join(directory, "document.bin");
    await writeFile(filePath, randomBytes(8 * 1024 * 1024));
    fileDigest = createHash("sha256").update(await readFile(filePath)).digest("hex");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(closers.splice(0).map((close) => close()));
  });
  afterAll(() => rm(directory, { recursive: true, force: true }));

  const scan = (port: number) => scanFileWithClamAv(filePath, { host: "127.0.0.1", port, timeoutMs: 30_000 });
  const start = async (options: Parameters<typeof startFakeClamd>[0]) => {
    const fake = await startFakeClamd(options);
    closers.push(fake.close);
    return fake;
  };

  // May pass before the fix, when nothing is released yet: it guards the hazard of releasing a chunk before libuv has written it.
  it("delivers every byte intact to a receiver that stalls, then reads the terminator", async () => {
    const fake = await start({ pauseEvery: 8 });
    await expect(scan(fake.port)).resolves.toEqual({ status: "clean" });
    expect(fake.state.terminated).toBe(true);
    expect(fake.state.bytes).toBe(8 * 1024 * 1024);
    expect(fake.state.digest).toBe(fileDigest);
  });

  it("answers unavailable, with no unhandled rejection, when the receiver destroys its socket mid-stream", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const fake = await start({ destroyAfter: 4 });
      await expect(scan(fake.port)).resolves.toEqual({ status: "error", reason: "unavailable" });
      expect(fake.state.terminated).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("zeroes and frees every payload chunk it handed to the socket", async () => {
    const handed: Array<{ bytes: Buffer; lengthAtWrite: number }> = [];
    const write = Socket.prototype.write;
    const fake = await start({ pauseEvery: 8 });
    vi.spyOn(Socket.prototype, "write").mockImplementation(function (this: Socket, ...args: unknown[]) {
      // Only the sender's side: the fake's own socket is bound to the port.
      const first = args[0];
      if (this.remotePort === fake.port && Buffer.isBuffer(first)) handed.push({ bytes: first, lengthAtWrite: first.length });
      return (write as (...a: unknown[]) => boolean).apply(this, args);
    });
    await expect(scan(fake.port)).resolves.toEqual({ status: "clean" });
    // The command, the 4-byte headers and the terminator are small; the payload chunks are file-sized.
    const payload = handed.filter((entry) => entry.lengthAtWrite >= 1024);
    expect(payload.length).toBeGreaterThanOrEqual(128);
    expect(payload.filter((entry) => entry.bytes.byteLength !== 0)).toHaveLength(0);
  });
});
