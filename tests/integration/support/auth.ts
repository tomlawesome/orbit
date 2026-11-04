/**
 * Shared sign-in scaffolding for the integration suites: the request origin,
 * a signed-in actor, local and provider-only accounts, and the error-response
 * check. Each suite names its own accounts through `TestUserNaming`, so the
 * addresses and subjects a suite asserts on stay the suite's own.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { getDb } from "@/db";
import { externalIdentities, userPreferences, users } from "@/db/schema";
import { sessionCookieName } from "@/lib/auth/cookies";
import { hashPassword } from "@/lib/auth/password";
import { createSession, csrfTokenForSession, readSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/env";
import { createLocalUser } from "@/server/local-credentials";
import { accountAddressColumns } from "./fixtures";

export const ORIGIN = "http://127.0.0.1:3000";

export interface Actor {
  id: string;
  email: string;
  sessionId: string;
  cookie: string;
  csrfToken: string;
}

/** How a suite names the accounts it creates, and where it records them for cleanup. */
export interface TestUserNaming {
  /** The address domain: `${label}@${domain}`. */
  domain: string;
  /** The display name is `${displayPrefix} ${label}`. */
  displayPrefix: string;
  /** The provider subject is `${subjectPrefix}${label}`. */
  subjectPrefix: string;
  issuer: string;
  password: string;
  /** Receives every created user id so the suite can delete them afterwards. */
  created: string[];
}

/** A user with a password and, optionally, a linked provider identity and/or the instance-administrator flag. */
export async function localUser(
  naming: TestUserNaming,
  label: string,
  options: { identity?: boolean; administrator?: boolean } = {},
): Promise<string> {
  const user = await createLocalUser({
    email: `${label}@${naming.domain}`,
    displayName: `${naming.displayPrefix} ${label}`,
    passwordHash: await hashPassword(naming.password),
  });
  naming.created.push(user.id);
  if (options.identity) {
    await getDb().insert(externalIdentities).values({
      userId: user.id,
      issuer: naming.issuer,
      subject: `${naming.subjectPrefix}${label}`,
    });
  }
  if (options.administrator) {
    await getDb().update(users).set({ isInstanceAdmin: true }).where(eq(users.id, user.id));
  }
  return user.id;
}

/** A user with a provider identity and no password. */
export async function oidcUser(
  naming: TestUserNaming,
  label: string,
  options: { administrator?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const [user] = await getDb().insert(users).values({
    id,
    ...(await accountAddressColumns(id, `${label}@${naming.domain}`)),
    emailVerified: true,
    displayName: `${naming.displayPrefix} ${label}`,
    isInstanceAdmin: options.administrator === true,
  }).returning({ id: users.id });
  naming.created.push(user.id);
  await getDb().insert(userPreferences).values({ userId: user.id });
  await getDb().insert(externalIdentities).values({
    userId: user.id,
    issuer: naming.issuer,
    subject: `${naming.subjectPrefix}${label}`,
  });
  return user.id;
}

export async function actorFor(userId: string): Promise<Actor> {
  const config = getAuthConfig();
  const { token } = await createSession(userId, config);
  const session = await readSession(
    { get: (name) => (name === sessionCookieName(config) ? token : undefined) },
    config,
  );
  if (!session) throw new Error("The session was not persisted");
  /* Readable here by construction: these journeys run with a working key, and
     the address is encrypted now (#969), so a null would mean the fixture lost
     the key rather than that the account has no address. Fail loudly. */
  if (session.user.email === null) throw new Error("The account address could not be read");
  return {
    id: userId,
    email: session.user.email,
    sessionId: session.id,
    cookie: `${sessionCookieName(config)}=${token}`,
    csrfToken: csrfTokenForSession(session, config),
  };
}

/** The response is the given status with the given error code and is not cacheable; returns the error body. */
export async function expectApiError(response: Response, status: number, code: string): Promise<{ message?: string }> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as { error?: { code?: string; message?: string } };
  expect(body.error?.code).toBe(code);
  return body.error ?? {};
}
