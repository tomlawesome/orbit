import { getAuthConfig } from "@/lib/env";
import { databaseConnectionString } from "@/db";
import { readRuntimeSecret } from "@/lib/runtime-secret";
import { getDocumentConfig } from "@/server/documents/config";
import { getNotificationWorkerConfig } from "@/server/notification-worker";
import { getImapIngestionConfig } from "@/server/imap-ingestion";
import { setConfigurationProblems } from "@/lib/configuration-problems";
import { logFormats, logLevels, type ConfigurationSetting } from "@/lib/logger";

export type StartupConfigurationCode =
  | "configuration_version"
  | "configuration_core"
  | "configuration_optional";

export type StartupConfigurationIssue = {
  /*
   * The logger's list rather than a copy of it. This union was written out
   * twice, so adding a setting here compiled and then failed at
   * `setConfigurationProblems`, which types its argument against the logger —
   * one of the duplicated cross-layer contracts #447 collects.
   */
  field: ConfigurationSetting;
  code: StartupConfigurationCode;
};

export class StartupConfigurationError extends Error {
  readonly issues: StartupConfigurationIssue[];

  constructor(issues: StartupConfigurationIssue[]) {
    super("Orbit startup configuration is invalid");
    this.name = "StartupConfigurationError";
    this.issues = issues;
  }
}

function selectedProfileConfiguration(environment: NodeJS.ProcessEnv): StartupConfigurationIssue[] {
  const profiles = new Set((environment.COMPOSE_PROFILES ?? "").split(",").map((profile) => profile.trim()).filter(Boolean));
  const issues: StartupConfigurationIssue[] = [];
  if (profiles.has("processing") && !environment.TIKA_URL) {
    issues.push({ field: "processing", code: "configuration_optional" });
  }
  if (profiles.has("ai") && !environment.OLLAMA_MODEL) {
    issues.push({ field: "ai", code: "configuration_optional" });
  }
  return issues;
}

function hasAny(environment: NodeJS.ProcessEnv, names: string[]): boolean {
  return names.some((name) => typeof environment[name] === "string" && environment[name] !== "");
}

/** Validates all startup prerequisites without opening a database connection. */
export function validateStartupConfiguration(environment: NodeJS.ProcessEnv = process.env): void {
  const issues: StartupConfigurationIssue[] = [];
  if (environment.ORBIT_CONFIG_SCHEMA_VERSION !== "1") {
    issues.push({ field: "ORBIT_CONFIG_SCHEMA_VERSION", code: "configuration_version" });
  }
  /*
   * The fixture harness has no business in a production Orbit (#773).
   *
   * ORBIT_FIXTURES makes the /api routes answer with stand-in data and, since
   * #789, bypasses the authentication gate as well. Until the cut (#735) two
   * things had to go wrong before either mattered: nothing production ran set
   * the variable, AND the composite entry kept /api on the engine whatever the
   * SvelteKit app believed. The cut deleted that second layer. This is its
   * replacement — a signed-in operator on a real deployment is now one
   * accident away from being shown fabricated data, and would have no way to
   * tell.
   *
   * Fail closed on the value: anything present and non-empty blocks, including
   * "0" and anything unparseable. A reader who put the variable there meant
   * something by it, and guessing "off" on their behalf is exactly the guess
   * this exists to refuse. An empty string is left alone — that is Compose
   * passing through an unset variable, not an instruction.
   */
  if (
    environment.NODE_ENV === "production" &&
    typeof environment.ORBIT_FIXTURES === "string" &&
    environment.ORBIT_FIXTURES !== ""
  ) {
    issues.push({ field: "fixtures", code: "configuration_core" });
  }
  try {
    getAuthConfig(environment);
  } catch {
    issues.push({ field: "authentication", code: "configuration_core" });
  }
  try {
    databaseConnectionString(environment);
  } catch {
    issues.push({ field: "database", code: "configuration_core" });
  }
  try {
    getDocumentConfig(environment);
  } catch {
    issues.push({ field: "documents", code: "configuration_core" });
  }
  const notificationEnvironment = {
    ...environment,
    VAPID_SUBJECT: undefined,
    VAPID_PUBLIC_KEY: undefined,
    VAPID_PRIVATE_KEY: undefined,
    VAPID_PRIVATE_KEY_FILE: undefined,
  };
  try {
    getNotificationWorkerConfig(notificationEnvironment);
  } catch {
    issues.push({ field: "mail", code: "configuration_optional" });
  }
  if (environment.IMAP_ENABLED !== "false") {
    try {
      getImapIngestionConfig(environment);
    } catch {
      issues.push({ field: "imap", code: "configuration_optional" });
    }
  }
  if (environment.ORBIT_LOG_LEVEL !== undefined && !(logLevels as readonly string[]).includes(environment.ORBIT_LOG_LEVEL)) {
    issues.push({ field: "logging", code: "configuration_optional" });
  }
  if (environment.ORBIT_LOG_FORMAT !== undefined && !(logFormats as readonly string[]).includes(environment.ORBIT_LOG_FORMAT)) {
    issues.push({ field: "logging", code: "configuration_optional" });
  }
  if (hasAny(environment, ["VAPID_SUBJECT"])) {
    try {
      const privateKey = readRuntimeSecret(environment, "VAPID_PRIVATE_KEY");
      if (!environment.VAPID_SUBJECT || !environment.VAPID_PUBLIC_KEY || !privateKey) {
        throw new Error("push configuration incomplete");
      }
    } catch {
      issues.push({ field: "push", code: "configuration_optional" });
    }
  }
  issues.push(...selectedProfileConfiguration(environment));
  setConfigurationProblems(issues);
  const blockingIssues = issues.filter((issue) => issue.code !== "configuration_optional");
  if (blockingIssues.length > 0) throw new StartupConfigurationError(issues);
}
