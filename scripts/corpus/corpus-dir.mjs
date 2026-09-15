// Which corpus directory the tooling works on.
//
// `sources/` holds the 24 tuning documents. `holdout/` holds the 12 hold-out
// documents (#986 step 8), which exist to be scored, never tuned against.
// Every script here takes `--dir <name>` or the `CORPUS_DIR` environment
// variable and defaults to `sources`, so every command in the README that
// predates the hold-out still means what it meant.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);

function flagValue() {
  const at = argv.indexOf("--dir");
  if (at !== -1 && argv[at + 1] !== undefined) return argv[at + 1];
  const inline = argv.find((a) => a.startsWith("--dir="));
  return inline ? inline.slice("--dir=".length) : undefined;
}

/** The corpus directory, absolute. A relative name is taken as a sibling of
 * this script; an absolute path is used as given. */
export const corpusDir = resolve(HERE, flagValue() ?? process.env.CORPUS_DIR ?? "sources");

/** The positional arguments, with `--dir <name>` removed, so a script that
 * already took positional arguments keeps taking them. */
export const positional = (() => {
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dir") { i += 1; continue; }
    if (argv[i].startsWith("--dir=")) continue;
    rest.push(argv[i]);
  }
  return rest;
})();
