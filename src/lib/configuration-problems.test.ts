import { afterEach, describe, expect, it } from "vitest";
import {
  getConfigurationProblems,
  resetConfigurationProblemsForTests,
  setConfigurationProblems,
} from "./configuration-problems";

afterEach(() => resetConfigurationProblemsForTests());

describe("configuration problem registry", () => {
  it("stores only fixed setting, fallback and remediation classifications", () => {
    setConfigurationProblems([
      { field: "database", code: "configuration_core" },
      { field: "processing", code: "configuration_optional" },
      { field: "processing", code: "configuration_optional" },
    ]);

    expect(getConfigurationProblems()).toEqual([
      {
        code: "configuration_core",
        severity: "error",
        setting: "database",
        fallback: "startup_blocked",
        remediation: "check_configuration",
      },
      {
        code: "configuration_optional",
        severity: "warning",
        setting: "processing",
        fallback: "feature_disabled",
        remediation: "repair_configuration",
      },
    ]);
  });

  it("clears the current snapshot after safe configuration validation", () => {
    setConfigurationProblems([{ field: "authentication", code: "configuration_core" }]);
    setConfigurationProblems([]);
    expect(getConfigurationProblems()).toEqual([]);
  });
});
