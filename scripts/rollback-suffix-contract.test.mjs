import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #1151 O1-Q5: the ".orbit-config.rollback" suffix is written in more than
// one place, and a one-sided edit silently broke --check-rollback and every
// real rollback-file interaction while every other test passed. Since #1210
// the migration that creates the copy is the engine's
// (src/lib/configuration-migration.ts's CONFIGURATION_ROLLBACK_SUFFIX);
// repair.sh keeps its own readonly constant (it is deliberately
// source-less), and configure.sh names the copy once, to find the engine
// image for --check-rollback. This reads all three from the live files.

const migrationSource = readFileSync(join(import.meta.dirname, "..", "src", "lib", "configuration-migration.ts"), "utf8");
const repairSource = readFileSync(join(import.meta.dirname, "repair.sh"), "utf8");
const configureSource = readFileSync(join(import.meta.dirname, "configure.sh"), "utf8");

describe("the engine, repair.sh and configure.sh agree on the rollback-file suffix (#1151 O1-Q5)", () => {
  it("CONFIGURATION_ROLLBACK_SUFFIX, repair.sh's constant and configure.sh's lookup are the same literal", () => {
    const engineSuffix = migrationSource.match(/^export const CONFIGURATION_ROLLBACK_SUFFIX = "([^"]*)";$/mu)?.[1];
    const repairSuffix = repairSource.match(/^readonly configuration_rollback_suffix="([^"]*)"$/mu)?.[1];
    expect(engineSuffix).toBe(".orbit-config.rollback");
    expect(repairSuffix).toBe(engineSuffix);
    expect(configureSource).toContain(`"\${environment_file}${engineSuffix}"`);
  });
});
