import crypto, { createHash } from "node:crypto";

export function bad(data: string): string[] {
  return [
    // ruleid: weak-hash
    crypto.createHash("md5").update(data).digest("hex"),
    // ruleid: weak-hash
    createHash("SHA1").update(data).digest("hex"),
  ];
}

export function good(data: string): string {
  // ok: weak-hash
  return createHash("sha256").update(data).digest("hex");
}
