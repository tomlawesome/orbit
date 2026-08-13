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

// Alias-compatibility names are accepted by the parser for pre-rotation
// installations but are deliberately undocumented (configuration.sh calls
// them "not documented defaults").
const UNDOCUMENTED_COMPAT_KEYS = new Set([
  "IMAP_ALIAS_GENERATION",
  "IMAP_ALIAS_CURRENT_KEY",
  "IMAP_ALIAS_CURRENT_KEY_FILE",
  "IMAP_ALIAS_SECRET",
  "IMAP_ALIAS_SECRET_FILE",
  "IMAP_ALIAS_PREVIOUS_KEY",
  "IMAP_ALIAS_PREVIOUS_KEY_FILE",
  "IMAP_ALIAS_PREVIOUS_EXPIRY",
]);

describe(".env-orbit.example agrees with the configuration contract", () => {
  const documented = keysInExample();

  it("documents no unsupported keys", () => {
    const unsupported = [...documented].filter(
      (key) => !(ALLOWED_KEYS as readonly string[]).includes(key),
    );
    expect(unsupported).toEqual([]);
  });

  it("supports no undocumented keys beyond the compatibility aliases", () => {
    const undocumented = ALLOWED_KEYS.filter(
      (key) => !documented.has(key) && !UNDOCUMENTED_COMPAT_KEYS.has(key),
    );
    expect(undocumented).toEqual([]);
  });
});
