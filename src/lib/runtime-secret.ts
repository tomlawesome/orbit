import { readFileSync } from "node:fs";

/**
 * What a NAME / NAME_FILE pair holds, without throwing (#1405): the value, or
 * which of the ways it can be unusable applies. `absent` is neither form set.
 * The answer never carries the path, and carries the value only on success.
 */
export type RuntimeSecretInspection =
  | { state: "present"; value: string }
  | { state: "absent" }
  | { state: "both_forms" }
  | { state: "unreadable" }
  | { state: "empty_file" };

export function inspectRuntimeSecret(
  environment: NodeJS.ProcessEnv,
  name: string,
): RuntimeSecretInspection {
  const directValue = environment[name];
  const filePath = environment[`${name}_FILE`];
  const hasDirectValue = typeof directValue === "string" && directValue.length > 0;
  const hasFilePath = typeof filePath === "string" && filePath.length > 0;

  if (hasDirectValue && hasFilePath) return { state: "both_forms" };
  if (hasDirectValue) return { state: "present", value: directValue };
  if (!hasFilePath) return { state: "absent" };

  let value: string;
  try {
    value = readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
  } catch {
    return { state: "unreadable" };
  }
  return value ? { state: "present", value } : { state: "empty_file" };
}

/**
 * Resolves a sensitive setting from either NAME or NAME_FILE.
 * File-backed values avoid exposing secrets through the container environment.
 */
export function readRuntimeSecret(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const directValue = environment[name];
  const filePath = environment[`${name}_FILE`];
  const hasDirectValue = typeof directValue === "string" && directValue.length > 0;
  const hasFilePath = typeof filePath === "string" && filePath.length > 0;

  if (hasDirectValue && hasFilePath) {
    throw new Error(`${name} and ${name}_FILE cannot both be configured`);
  }
  if (hasDirectValue) return directValue;
  if (!hasFilePath) return undefined;

  const value = readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
  if (!value) throw new Error(`${name}_FILE points to an empty secret`);
  return value;
}
