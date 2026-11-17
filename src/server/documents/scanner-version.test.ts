import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { readClamAvVersion } from "./scanner";

/** Audit A-R2: the VERSION reply is read from a socket we do not control; it must stay small. */

const servers: Server[] = [];
const sockets = new Set<Socket>();

async function fakeClamd(reply: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("data", () => reply(socket));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("readClamAvVersion", () => {
  it("answers the VERSION line of a normal reply", async () => {
    const port = await fakeClamd((socket) => socket.end("ClamAV 1.5.4/28137/Mon Sep 28 06:24:12 2026\0"));
    expect(await readClamAvVersion({ host: "127.0.0.1", port, timeoutMs: 5_000 })).toBe("ClamAV 1.5.4/28137/Mon Sep 28 06:24:12 2026");
  });

  it("A-R2: a reply that never ends its line is refused, not kept as a multi-megabyte version string", async () => {
    const port = await fakeClamd((socket) => socket.end("x".repeat(4 * 1024 * 1024)));
    const answer = await readClamAvVersion({ host: "127.0.0.1", port, timeoutMs: 5_000 });
    expect(answer === null || answer.length <= 1024).toBe(true);
  });
});
