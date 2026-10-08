import { createECDH } from "node:crypto";
import { chmodSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  ConfigureEngineRefusal,
  ensureSecretsDirectory,
  internal as configureEngineInternal,
  updateManagedKeys,
} from "./configure-engine";

// VAPID push keys (#1210 build note D7, ADR-0032 as amended). configure.sh's
// ensure_vapid_keys needed Docker only because bash had to borrow a Node
// runtime to generate the pair (a throwaway `vapid-generator` image build,
// or `docker run` of the resolved app image). Inside the engine it is
// node:crypto and two file writes, so it runs here, at the end of the bare
// configure flow, and the bash function, the script it ran and the image
// stage that carried it are gone.

// A literal, not built from configure-engine's SECRETS_DIRECTORY_NAME: the two
// modules import each other, and a top-level read across that cycle would see
// the binding before it is initialised.
export const VAPID_PRIVATE_KEY_RELATIVE_PATH = ".orbit-secrets/vapid-private-key";
export const VAPID_PRIVATE_KEY_RUNTIME_PATH = "/run/orbit-secrets/orbit-vapid-private-key";

export interface VapidKeyPair {
  /** Uncompressed P-256 public point, unpadded base64url (what browsers' PushManager expects). */
  publicKey: string;
  /** Raw 32-byte P-256 private scalar, unpadded base64url. */
  privateKey: string;
}

/** A VAPID key pair is a P-256 ECDH key pair, encoded as unpadded base64url (the former scripts/generate-vapid.mjs). */
export function generateVapidKeyPair(): VapidKeyPair {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  // getPrivateKey() drops leading zero bytes (about one key in 256), and
  // web-push accepts only a 32-byte VAPID private key: left-pad it back.
  const scalar = ecdh.getPrivateKey();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString("base64url"),
  };
}

export interface EnsureVapidKeysResult {
  generated: boolean;
  message?: string;
}

/**
 * ensure_vapid_keys (configure.sh, guarantees #24-26): an existing non-empty
 * private key file is kept (mode restricted to 600) and nothing else is
 * touched; otherwise a new pair is generated, the private key written
 * atomically at mode 600, and only then are VAPID_PUBLIC_KEY and
 * VAPID_PRIVATE_KEY_FILE recorded in .env-orbit. A symlink or other
 * non-regular file at the key path is refused, like every other secret the
 * engine manages.
 */
export function ensureVapidKeys(deployDir: string, generate: () => VapidKeyPair = generateVapidKeyPair): EnsureVapidKeysResult {
  const keyPath = join(deployDir, VAPID_PRIVATE_KEY_RELATIVE_PATH);
  const link = lstatSync(keyPath, { throwIfNoEntry: false });
  if (link) {
    const target = statSync(keyPath, { throwIfNoEntry: false });
    if (link.isSymbolicLink() || !target?.isFile()) {
      throw new ConfigureEngineRefusal(
        `Refusing to use ${VAPID_PRIVATE_KEY_RELATIVE_PATH} because it is not a regular file.`,
        "secret-file-invalid",
      );
    }
    if (target.size > 0) {
      try {
        chmodSync(keyPath, 0o600);
      } catch {
        throw new ConfigureEngineRefusal(`Could not restrict permissions on ${VAPID_PRIVATE_KEY_RELATIVE_PATH}.`, "secret-file-invalid");
      }
      return { generated: false };
    }
  }

  ensureSecretsDirectory(deployDir);
  const pair = generate();
  if (!pair.publicKey || !pair.privateKey) {
    throw new ConfigureEngineRefusal("VAPID key generation returned invalid values.", "write-failed");
  }
  configureEngineInternal.atomicWriteFile(keyPath, `${pair.privateKey}\n`, 0o600, "vapid.installing");
  updateManagedKeys(deployDir, [
    ["VAPID_PUBLIC_KEY", pair.publicKey],
    ["VAPID_PRIVATE_KEY_FILE", VAPID_PRIVATE_KEY_RUNTIME_PATH],
  ]);
  return { generated: true, message: "Generated VAPID push keys." };
}
