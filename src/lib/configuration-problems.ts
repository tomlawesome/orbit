import type {
  ConfigurationFallback,
  ConfigurationProblemCode,
  ConfigurationSetting,
} from "@/lib/logger";

export type ConfigurationProblem = {
  code: ConfigurationProblemCode;
  severity: "error" | "warning";
  setting: ConfigurationSetting;
  fallback: ConfigurationFallback;
  remediation: "check_configuration" | "repair_configuration";
};

let currentProblems: ConfigurationProblem[] = [];

/**
 * Replaces the process-local startup configuration snapshot. It intentionally
 * stores only fixed classifications: no values, paths, hosts, or exceptions.
 */
export function setConfigurationProblems(issues: ReadonlyArray<{ field: ConfigurationSetting; code: ConfigurationProblemCode }>): void {
  const seen = new Set<string>();
  currentProblems = issues.flatMap((issue): ConfigurationProblem[] => {
    const key = `${issue.field}|${issue.code}`;
    if (seen.has(key)) return [];
    seen.add(key);
    /* A key fault (#1405) is an error that does not stop the start: the
       instance comes up locked rather than not at all. */
    if (issue.code === "configuration_key") {
      return [{
        code: issue.code,
        severity: "error",
        setting: issue.field,
        fallback: "feature_disabled",
        remediation: "check_configuration",
      }];
    }
    const blocking = issue.code !== "configuration_optional";
    return [{
      code: issue.code,
      severity: blocking ? "error" : "warning",
      setting: issue.field,
      fallback: blocking ? "startup_blocked" : "feature_disabled",
      remediation: blocking ? "check_configuration" : "repair_configuration",
    }];
  });
}

export function getConfigurationProblems(): ConfigurationProblem[] {
  return currentProblems.map((problem) => ({ ...problem }));
}

export function resetConfigurationProblemsForTests(): void {
  currentProblems = [];
}
