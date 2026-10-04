import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #1151 O1-Q5: configure.sh and configuration.sh each hand-duplicate the
// ".orbit-config.rollback" suffix as their own readonly constant (never
// sourced -- both scripts are deliberately source-less, so this is not
// fixed by having one import the other). Both test files also hard-code the
// literal suffix rather than reading either constant, so a one-sided edit
// to just one script's constant passed every existing test while silently
// breaking --check-rollback and every real rollback-file interaction.
//
// This extracts both real constants from the live scripts (never a
// hand-typed duplicate of its own) and fails if they ever diverge, the same
// role src/lib/session-secret.contract.test.ts already plays for
// secret_hex256_pattern between configure.sh and config-contract.ts.

const configureSource = readFileSync(join(import.meta.dirname, "configure.sh"), "utf8");
const configurationSource = readFileSync(join(import.meta.dirname, "configuration.sh"), "utf8");

function extractConstant(source, name) {
  const match = source.match(new RegExp(`^readonly ${name}="([^"]*)"$`, "mu"));
  if (!match) throw new Error(`Could not find readonly ${name}="..." in the given source`);
  return match[1];
}

describe("configure.sh and configuration.sh agree on the rollback-file suffix (#1151 O1-Q5)", () => {
  it("configuration_rollback_suffix and rollback_suffix are the same literal", () => {
    const configureSuffix = extractConstant(configureSource, "configuration_rollback_suffix");
    const configurationSuffix = extractConstant(configurationSource, "rollback_suffix");
    expect(configureSuffix).toBe(configurationSuffix);
    expect(configureSuffix).toBe(".orbit-config.rollback");
  });
});
