import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EncryptJWT, base64url, jwtDecrypt } from "jose";
import type { AuthConfig } from "@/lib/env";
import { AuthError } from "@/lib/auth/errors";

const TRANSACTION_ISSUER = "orbit";
const TRANSACTION_AUDIENCE = "oidc-login-transaction";

export interface LoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

export function randomUrlSafe(byteLength = 32): string {
  return base64url.encode(randomBytes(byteLength));
}

export function createPkceChallenge(codeVerifier: string): string {
  return base64url.encode(createHash("sha256").update(codeVerifier, "ascii").digest());
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createCsrfToken(sessionToken: string, secret: string): string {
  return base64url.encode(createHmac("sha256", secret).update(`csrf:${sessionToken}`, "utf8").digest());
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function transactionKey(secret: string): Uint8Array {
  return createHash("sha256").update(`oidc-transaction:${secret}`, "utf8").digest();
}

export async function sealLoginTransaction(transaction: LoginTransaction, config: AuthConfig): Promise<string> {
  return new EncryptJWT({ ...transaction })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(TRANSACTION_ISSUER)
    .setAudience(TRANSACTION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .encrypt(transactionKey(config.sessionSecret));
}

export async function openLoginTransaction(value: string, config: AuthConfig): Promise<LoginTransaction> {
  try {
    const { payload } = await jwtDecrypt(value, transactionKey(config.sessionSecret), {
      issuer: TRANSACTION_ISSUER,
      audience: TRANSACTION_AUDIENCE,
      clockTolerance: 5,
    });
    const fields = [payload.state, payload.nonce, payload.codeVerifier, payload.returnTo];
    if (!fields.every((field) => typeof field === "string" && field.length > 0)) {
      throw new Error("Login transaction claims are incomplete");
    }
    return {
      state: payload.state as string,
      nonce: payload.nonce as string,
      codeVerifier: payload.codeVerifier as string,
      returnTo: payload.returnTo as string,
    };
  } catch (error) {
    throw new AuthError("invalid_state", "The sign-in transaction is invalid or has expired", 400, { cause: error });
  }
}

export function safeReturnPath(value: string | null): string {
  // A leading "\" is normalized to "/" by WHATWG URL parsing on special schemes,
  // so "/\evil.com" resolves to the external origin "https://evil.com/" once
  // joined with appUrl in the callback route. Backslashes have no legitimate use
  // in an application-relative path, so any occurrence is rejected outright.
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u001f\\]/.test(value)) return "/";
  return value;
}
