import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { processCorpus } from "./tika.mjs";

/*
 * X-Q2 (#1151): the script used to log "FAIL <file> <status>" for a PDF Tika
 * could not parse and keep going with an exit code of 0, so a corpus build
 * with a broken file looked the same as a clean one to anything checking the
 * exit status (`echo $?`, a CI job, `&&` in a shell script).
 *
 * A fake Tika stands in, in-process, rather than spawning tika.mjs against a
 * container on Orbit's document-processing network, which a unit test cannot
 * reach.
 */

let server;
let base;
let directory;
const logged = [];
const log = (...parts) => logged.push(parts.join(" "));

function start(responder) {
  return new Promise((resolve) => {
    server = createServer(responder);
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

afterEach(() => {
  logged.length = 0;
  rmSync(directory, { recursive: true, force: true });
  return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
});

describe("processCorpus", () => {
  it("names the file and reports it as failed when Tika cannot parse a PDF", async () => {
    await start((request, response) => {
      response.writeHead(422, { "content-type": "text/plain" });
      response.end("unsupported media");
    });
    directory = mkdtempSync(join(tmpdir(), "orbit-corpus-tika-"));
    writeFileSync(join(directory, "broken.pdf"), "not a real pdf");

    const failed = await processCorpus({ dir: directory, url: base, log });

    expect(failed).toEqual(["broken.pdf"]);
    expect(logged.join("\n")).toContain("FAIL broken.pdf 422");
  });

  it("writes the stripped text and reports nothing failed when every PDF parses", async () => {
    await start((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      // A Markdown metacharacter Tika escapes that the source document never
      // contained (#982): the fixture must hold it unescaped.
      response.end("hello \\*world\\*");
    });
    directory = mkdtempSync(join(tmpdir(), "orbit-corpus-tika-"));
    writeFileSync(join(directory, "ok.pdf"), "not a real pdf either");

    const failed = await processCorpus({ dir: directory, url: base, log });

    expect(failed).toEqual([]);
    expect(readFileSync(join(directory, "ok.txt"), "utf8")).toBe("hello *world*");
  });

  it("reports every failing file when some of the corpus parses fine and some does not", async () => {
    let calls = 0;
    await start((request, response) => {
      calls += 1;
      if (calls === 1) {
        // Files are processed in sorted order: "a-ok.pdf" before "b-broken.pdf".
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("fine");
        return;
      }
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("broke");
    });
    directory = mkdtempSync(join(tmpdir(), "orbit-corpus-tika-"));
    writeFileSync(join(directory, "a-ok.pdf"), "x");
    writeFileSync(join(directory, "b-broken.pdf"), "y");

    const failed = await processCorpus({ dir: directory, url: base, log });

    expect(failed).toEqual(["b-broken.pdf"]);
    expect(readFileSync(join(directory, "a-ok.txt"), "utf8")).toBe("fine");
  });
});
