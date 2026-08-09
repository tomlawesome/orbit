import { getAuthConfig } from "@/lib/env";
import { databaseConnectionString } from "@/db";
import { readRuntimeSecret } from "@/lib/runtime-secret";
import { getDocumentConfig } from "@/server/documents/config";
import { getNotificationWorkerConfig } from "@/server/notification-worker";
import { getImapIngestionConfig } from "@/server/imap-ingestion";

export type StartupConfigurationCode =
  | "configuration_version"
  | "configuration_core"
  | "configuration_optional";

export type StartupConfigurationIssue = {
  field: "ORBIT_CONFIG_SCHEMA_VERSION" | "ORBIT_IMAGE" | "authentication" | "database" | "documents" | "mail" | "imap" | "push" | "processing" | "ai";
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
  if (!environment.ORBIT_IMAGE) {
    issues.push({ field: "ORBIT_IMAGE", code: "configuration_core" });
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
  try {
    getNotificationWorkerConfig(environment);
  } catch {
    issues.push({ field: "mail", code: "configuration_optional" });
  }
  try {
    getImapIngestionConfig(environment);
  } catch {
    issues.push({ field: "imap", code: "configuration_optional" });
  }
  const pushKeys = ["VAPID_SUBJECT", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_PRIVATE_KEY_FILE"];
  if (hasAny(environment, pushKeys)) {
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
  if (issues.length > 0) throw new StartupConfigurationError(issues);
}
