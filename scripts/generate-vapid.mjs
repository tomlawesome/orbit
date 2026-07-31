import { createECDH } from "node:crypto";

// A VAPID key pair is a P-256 ECDH key pair, encoded as unpadded base64url.
// Keeping this to Node's built-in crypto API lets the standalone Orbit image
// bootstrap keys without retaining the web-push package at runtime.
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();

process.stdout.write(
  `public=${ecdh.getPublicKey().toString("base64url")}\nprivate=${ecdh.getPrivateKey().toString("base64url")}\n`,
);
