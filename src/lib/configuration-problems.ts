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
  currentProblems = issues.flatMap((issue) => {
    const key = `${issue.field}|${issue.code}`;
    if (seen.has(key)) return [];
    seen.add(key);
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
