// Parse every PDF in the corpus with the REAL Tika, exactly as
// src/server/documents/tika.ts extractTextWithTika() does, and write the
// text beside it. Tika publishes no host port, so this runs inside a
// container on Orbit's document-processing network:
//
//   docker run --rm --network orbit_orbit-document-processing \
//     -v "$PWD/scripts/corpus/sources:/data" \
//     -v "$PWD/scripts/corpus/tika.mjs:/app/tika.mjs:ro" \
//     node:26-alpine node /app/tika.mjs
//
// The output is the corpus text, escapes and flattened tables included.
// That is the point: the fixture is what production actually sees.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

/*
 * Parses every PDF in `dir` and returns the names of the ones Tika could not
 * parse (X-Q2, #1151). `fetchImpl` and `log` are injectable so the test can
 * stand a fake Tika in-process rather than spawning this file against a real
 * one -- spawning would need the real document-processing network this
 * script's own header comment describes, which a test cannot stand up.
 */
export async function processCorpus({ dir, url, fetchImpl = fetch, log = console.error }) {
  const failed = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".pdf")).sort()) {
    const bytes = readFileSync(`${dir}/${f}`);
    const res = await fetchImpl(new URL("/tika", url), {
      method: "PUT",
      headers: { Accept: "text/plain", "Content-Type": "application/pdf" },
      body: new Uint8Array(bytes),
      redirect: "error",
    });
    if (!res.ok) {
      log("FAIL", f, res.status);
      failed.push(f);
      continue;
    }
    // Mirrors undoTikaMarkdownEscapes() in tika.ts (#982): Tika escapes
    // Markdown metacharacters the document does not contain, and production
    // strips them, so the fixture must hold the stripped text.
    const text = (await res.text()).replace(/\\([\\`*_{}[\]()#+\-.!|&<>~])/gu, "$1");
    writeFileSync(`${dir}/${f.replace(/\.pdf$/, ".txt")}`, text);
    log(f, res.status, text.length, "chars");
  }
  return failed;
}

async function main() {
  // This one cannot import `corpus-dir.mjs`: it runs inside a container with
  // only itself mounted, and the corpus arrives as a volume. The directory is
  // whichever one was mounted at /data -- `sources` or `holdout` -- and
  // `--dir`/`CORPUS_DIR` override it for a run outside a container.
  const dirFlag = process.argv.indexOf("--dir");
  const dir = (dirFlag !== -1 ? process.argv[dirFlag + 1] : undefined) ?? process.env.CORPUS_DIR ?? "/data";
  const url = process.env.TIKA_URL ?? "http://orbit-tika:9998";

  const failed = await processCorpus({ dir, url });
  if (failed.length > 0) {
    console.error(`tika failed to parse ${failed.length} file(s): ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
