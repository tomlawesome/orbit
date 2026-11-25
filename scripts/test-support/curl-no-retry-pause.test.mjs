import { spawn } from "node:child_process";
import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "../process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * #1943 X-F2 + X-F3: under --fail with --retry N, curl-no-retry-pause retries
 * the transient HTTP codes curl itself retries (408, 429, 500, 502, 503, 504)
 * and no other, so 501 and the rest of the 5xx do not retry. Counted against a
 * tiny local server; the pause between attempts is gone, so the runs are fast.
 */
const SCRIPT = new URL("./curl-no-retry-pause", import.meta.url).pathname;
const RETRIES = 2;

let server;
afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = undefined;
});

async function requestsFor(status) {
  let requests = 0;
  server = createServer((req, res) => {
    requests += 1;
    res.writeHead(status, { "content-type": "text/plain" });
    res.end("no");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const child = spawn(SCRIPT, [
    "--silent", "--show-error", "--fail", "--retry", String(RETRIES), "--retry-delay", "5",
    `http://127.0.0.1:${port}/`,
  ], { env: { ...process.env, REAL_CURL: "curl" }, stdio: ["ignore", "ignore", "ignore"] });
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { requests, code };
}

describe("curl-no-retry-pause retries curl's own transient HTTP codes under --fail (#1943 X-F2, X-F3)", () => {
  it.each([408, 429, 500, 502, 503, 504])("retries HTTP %i, RETRIES+1 requests in all, and still fails with curl's 22", async (status) => {
    const { requests, code } = await requestsFor(status);
    expect(requests).toBe(RETRIES + 1);
    expect(code).toBe(22);
  });

  it.each([400, 404, 501, 505, 507, 599])("does not retry HTTP %i: one request, curl's 22", async (status) => {
    const { requests, code } = await requestsFor(status);
    expect(requests).toBe(1);
    expect(code).toBe(22);
  });
});
