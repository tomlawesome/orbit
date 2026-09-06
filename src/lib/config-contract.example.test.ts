import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ALLOWED_KEYS } from "./config-contract";

// .env-orbit.example is the operator-facing catalogue of every supported
// variable (active or commented example). It must stay in exact agreement
// with the contract's allowed-key list — a key documented but unsupported
// misleads operators; a key supported but undocumented is invisible.

const examplePath = fileURLToPath(new URL("../../.env-orbit.example", import.meta.url));

function keysInExample(): Set<string> {
  const keys = new Set<string>();
  for (const line of readFileSync(examplePath, "utf8").split("\n")) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match) keys.add(match[1]);
  }
  return keys;
}

describe(".env-orbit.example agrees with the configuration contract", () => {
  const documented = keysInExample();

  it("documents no unsupported keys", () => {
    const unsupported = [...documented].filter(
      (key) => !(ALLOWED_KEYS as readonly string[]).includes(key),
    );
    expect(unsupported).toEqual([]);
  });

  it("supports no undocumented keys", () => {
    const undocumented = ALLOWED_KEYS.filter((key) => !documented.has(key));
    expect(undocumented).toEqual([]);
  });
});
