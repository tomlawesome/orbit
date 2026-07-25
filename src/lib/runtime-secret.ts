import { readFileSync } from "node:fs";

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
