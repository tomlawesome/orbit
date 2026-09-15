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

// This one cannot import `corpus-dir.mjs`: it runs inside a container with
// only itself mounted, and the corpus arrives as a volume. The directory is
// whichever one was mounted at /data -- `sources` or `holdout` -- and
// `--dir`/`CORPUS_DIR` override it for a run outside a container.
const dirFlag = process.argv.indexOf("--dir");
const dir = (dirFlag !== -1 ? process.argv[dirFlag + 1] : undefined) ?? process.env.CORPUS_DIR ?? "/data";
const url = process.env.TIKA_URL ?? "http://orbit-tika:9998";

for (const f of readdirSync(dir).filter((n) => n.endsWith(".pdf")).sort()) {
  const bytes = readFileSync(`${dir}/${f}`);
  const res = await fetch(new URL("/tika", url), {
    method: "PUT",
    headers: { Accept: "text/plain", "Content-Type": "application/pdf" },
    body: new Uint8Array(bytes),
    redirect: "error",
  });
  if (!res.ok) {
    console.error("FAIL", f, res.status);
    continue;
  }
  // Mirrors undoTikaMarkdownEscapes() in tika.ts (#982): Tika escapes
  // Markdown metacharacters the document does not contain, and production
  // strips them, so the fixture must hold the stripped text.
  const text = (await res.text()).replace(/\\([\\`*_{}[\]()#+\-.!|&<>~])/gu, "$1");
  writeFileSync(`${dir}/${f.replace(/\.pdf$/, ".txt")}`, text);
  console.error(f, res.status, text.length, "chars");
}
