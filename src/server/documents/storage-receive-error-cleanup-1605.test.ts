import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDocumentStorage } from "./storage";

/* #1605 SEC-D2/1 (from #1209): a stalled upload is ended by the web server
   (scripts/web-server.mjs, minimum body rate, #1390), which destroys the
   socket, so the body stream then errors. This pins what `receive` does with
   that: the quarantine file is removed and the error is passed on. */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("receive when the body stream errors mid-upload", () => {
  it("rejects, removes the quarantine file and closes its handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbit-receive-error-1605-"));
    roots.push(root);
    const storage = new LocalDocumentStorage(join(root, "objects"), join(root, "quarantine"));
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(1_024).fill(0x41));
          return undefined;
        }
        controller.error(new Error("socket destroyed"));
        return undefined;
      },
    });

    await expect(storage.receive(body, "30000000-0000-4000-8000-000000000001", 1_048_576)).rejects.toThrow();

    await expect(readdir(join(root, "quarantine"))).resolves.toEqual([]);
  });
});
