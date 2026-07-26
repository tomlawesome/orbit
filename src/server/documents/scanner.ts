import { createReadStream } from "node:fs";
import { createConnection } from "node:net";

export type MalwareScanResult =
  | { status: "clean" }
  | { status: "infected"; signature: string }
  | { status: "error"; reason: "unavailable" | "timeout" | "protocol" | "scanner" };

export function parseClamAvResponse(response: string): MalwareScanResult {
  const normalized = response.replace(/\0+$/, "").trim();
  if (normalized.endsWith(": OK")) return { status: "clean" };
  const found = /: (.+) FOUND$/.exec(normalized);
  if (found) return { status: "infected", signature: found[1].slice(0, 160) };
  return { status: "error", reason: normalized.includes("ERROR") ? "scanner" : "protocol" };
}

/** Checks clamd readiness without submitting document content. */
export async function pingClamAv(
  options: { host: string; port: number; timeoutMs: number },
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: options.host, port: options.port });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(Math.min(options.timeoutMs, 5_000), () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("data", (chunk: Buffer) => finish(chunk.toString("ascii").replace(/\0+$/, "").trim() === "PONG"));
    socket.on("connect", () => socket.write(Buffer.from("zPING\0", "ascii")));
    socket.on("close", () => finish(false));
  });
}

function writeSocket(socket: ReturnType<typeof createConnection>, bytes: Buffer): Promise<void> {
  if (socket.write(bytes)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("drain", resolve);
    socket.once("error", reject);
  });
}

/** Streams a quarantined file to clamd without sharing Orbit's filesystem. */
export async function scanFileWithClamAv(
  path: string,
  options: { host: string; port: number; timeoutMs: number },
): Promise<MalwareScanResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: options.host, port: options.port });
    let settled = false;
    let response = "";

    const finish = (result: MalwareScanResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(options.timeoutMs, () => finish({ status: "error", reason: "timeout" }));
    socket.on("error", () => finish({ status: "error", reason: "unavailable" }));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (response.includes("\0")) finish(parseClamAvResponse(response));
    });
    socket.on("close", () => {
      if (!settled) finish(response ? parseClamAvResponse(response) : { status: "error", reason: "protocol" });
    });

    socket.on("connect", () => {
      void (async () => {
        try {
          await writeSocket(socket, Buffer.from("zINSTREAM\0", "ascii"));
          for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const size = Buffer.allocUnsafe(4);
            size.writeUInt32BE(bytes.length);
            await writeSocket(socket, Buffer.concat([size, bytes]));
          }
          await writeSocket(socket, Buffer.alloc(4));
        } catch {
          finish({ status: "error", reason: "unavailable" });
        }
      })();
    });
  });
}
