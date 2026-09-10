/**
 * Operator entry point for the KEK rewrap worker (#932): `pnpm rewrap-kek
 * --next-key-file <path>`. Run this only after the running application has
 * also been given the next key via `DOCUMENT_KEK_NEXT`/`DOCUMENT_KEK_NEXT_FILE`
 * (#954, ADR-0024 decision 4) — see docs/administrator-operations.md,
 * "Rotating the document key-encryption key", for the full procedure. With
 * the next key loaded application-side, every row stays readable throughout:
 * one already moved to the next key, and one the worker has not reached yet,
 * are both readable by their own `key_id`.
 *
 * The current key comes from the ordinary runtime configuration
 * (`DOCUMENT_KEK`/`DOCUMENT_KEK_FILE`, unchanged); the next key is read only
 * from the file this command is given, exactly once, and never touches
 * configuration or the environment. Rotation is always an operator decision
 * (#932 scope): nothing here runs on a schedule or in response to anything
 * but this explicit invocation.
 */
import { readFileSync } from "node:fs";
import { isValidDocumentKekHex } from "@/lib/recovery-bundle";
import { closeDatabase } from "@/db";
import { deriveDocumentKeyId, getDocumentConfig } from "@/server/documents/config";
import {
  recordRotationCompleted,
  rotationRemaining,
  runKekRotationToCompletion,
  type RotationKeys,
} from "@/server/documents/rewrap-worker";

function usageExit(message: string): never {
  process.stderr.write(`orbit rewrap-kek: ${message}\n`);
  process.exit(1);
}

function parseNextKeyFile(argv: string[]): string {
  const flagIndex = argv.indexOf("--next-key-file");
  const path = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  if (!path) usageExit("usage: pnpm rewrap-kek --next-key-file <path>");
  return path;
}

async function main(): Promise<void> {
  const nextKeyPath = parseNextKeyFile(process.argv.slice(2));
  let nextKeyHex: string;
  try {
    nextKeyHex = readFileSync(nextKeyPath, "utf8").trim();
  } catch {
    usageExit(`could not read the next key file at ${nextKeyPath}`);
  }
  if (!isValidDocumentKekHex(nextKeyHex)) {
    usageExit("the next key file does not contain a 32-byte hexadecimal document key");
  }

  const current = getDocumentConfig();
  const nextKek = Buffer.from(nextKeyHex, "hex");
  const nextKeyId = deriveDocumentKeyId(nextKek);
  if (nextKeyId === current.keyId) {
    usageExit("the next key is identical to the current key; there is nothing to rotate");
  }
  const keys: RotationKeys = {
    currentKek: current.keyEncryptionKey,
    currentKeyId: current.keyId,
    nextKek,
    nextKeyId,
  };

  try {
    const before = await rotationRemaining(keys);
    process.stdout.write(
      `Starting rewrap: ${before.documentsRemaining} document(s), ${before.metadataKeysRemaining} metadata key(s), `
      + `${before.mailInSecretsRemaining} mail-in secret(s) to move from ${keys.currentKeyId} to ${keys.nextKeyId}.\n`,
    );
    await runKekRotationToCompletion(keys);
    await recordRotationCompleted(keys);
    process.stdout.write(
      "Rewrap complete: every row now decrypts only under the next key.\n"
      + "Replace the live document-kek secret with it, remove DOCUMENT_KEK_NEXT, and restart Orbit to finish the rotation.\n",
    );
  } finally {
    nextKek.fill(0);
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`orbit rewrap-kek: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
