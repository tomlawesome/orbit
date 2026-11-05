/**
 * #1681: the e2e stack's DKIM key stand-in, `tests/dkim-dns/server.mjs`.
 *
 * It is started the way its container starts it: `node server.mjs` as a child
 * process, configured only by environment --
 *   DKIM_SELECTOR, DKIM_DOMAIN   the one name it answers;
 *   DKIM_RECORD_FILE             the record text (a trailing newline is not part of it);
 *   DKIM_DNS_PORT                the UDP port (5353 in the stack).
 * It is queried with node's own resolver pointed at it, the same way the
 * product's MAIL_IN_DKIM_DNS_SERVERS lookup will be.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resolver } from "node:dns/promises";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
const SELECTOR = "orbit-e2e";
const DOMAIN = "example.test";
const NAME = `${SELECTOR}._domainkey.${DOMAIN}`;

/** A real 2048-bit key record, built the way tests/support/dkim-signing.ts builds it. */
function rsaRecord() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return `v=DKIM1; k=rsa; p=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`;
}

async function freeUdpPort() {
  const socket = createSocket("udp4");
  await new Promise((resolve, reject) => socket.once("error", reject).bind(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

const RECORD = rsaRecord();
let directory;
let child;
let port;
let output = "";

function resolverFor() {
  const resolver = new Resolver({ timeout: 500, tries: 1 });
  resolver.setServers([`127.0.0.1:${port}`]);
  return resolver;
}

/** Until the server answers at all (any DNS answer, NXDOMAIN included), or 10 s. */
async function waitUntilAnswering() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server.mjs exited (${child.exitCode}) before answering:\n${output}`);
    try {
      await resolverFor().resolveTxt(NAME);
      return;
    } catch (error) {
      if (error?.code === "ENOTFOUND" || error?.code === "ENODATA") return;
      if (Date.now() > deadline) throw new Error(`server.mjs never answered on 127.0.0.1:${port} (${error?.code}):\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "orbit-dkim-dns-"));
  const recordFile = join(directory, "dkim-test-record.txt");
  writeFileSync(recordFile, `${RECORD}\n`);
  port = await freeUdpPort();
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DKIM_SELECTOR: SELECTOR, DKIM_DOMAIN: DOMAIN, DKIM_RECORD_FILE: recordFile, DKIM_DNS_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await waitUntilAnswering();
});

after(() => {
  child?.kill();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("tests/dkim-dns/server.mjs", () => {
  it("answers the configured name with the whole record, split into strings of at most 255 bytes", async () => {
    assert.ok(Buffer.byteLength(RECORD) > 255, "a 2048-bit record needs more than one string");
    const records = await resolverFor().resolveTxt(NAME);
    assert.equal(records.length, 1, "one TXT record");
    const [chunks] = records;
    assert.ok(chunks.length >= 2, `split into several strings, got ${chunks.length}`);
    for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk) <= 255, `string of ${Buffer.byteLength(chunk)} bytes`);
    assert.equal(chunks.join(""), RECORD);
  });

  it("answers the configured name the same way on repeated queries", async () => {
    const resolver = resolverFor();
    for (let i = 0; i < 3; i += 1) assert.equal((await resolver.resolveTxt(NAME))[0].join(""), RECORD);
  });

  for (const other of [
    `other._domainkey.${DOMAIN}`,
    `${SELECTOR}._domainkey.other.test`,
    `x.${NAME}`,
    DOMAIN,
    "orbit.test",
  ]) {
    it(`answers NXDOMAIN for ${other}`, async () => {
      await assert.rejects(resolverFor().resolveTxt(other), (error) => {
        assert.equal(error.code, "ENOTFOUND", `NXDOMAIN, not ${error.code}`);
        return true;
      });
    });
  }
});
