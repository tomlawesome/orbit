import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "@/lib/env";
import { deriveImapRecipientAlias } from "@/server/mail-in/core/imap-recipient";

/**
 * The relay endpoint's contract (#432). Only the database and the auth config
 * are stubbed: the session is read through the real `readSession`, the alias
 * through the real `deriveImapRecipientAlias`, and the listening/ingest words
 * through the real environment parser — so what these tests pin is the route's
 * own behaviour rather than a rehearsal of it.
 */

const config: AuthConfig = {
  appUrl: new URL("https://orbit.example"),
  sessionSecret: "mail-relay-route-session-secret-that-is-long-enough",
  sessionTtlSeconds: 3600,
  issuer: "https://issuer.mail-relay.example.invalid/",
  clientId: "mail-relay-client",
  clientSecret: "mail-relay-client-secret",
  callbackUrl: "https://orbit.example/api/auth/callback",
  scopes: "openid profile email",
  claims: { email: "email", emailVerified: "email_verified", name: "name", avatar: "picture" },
  secureCookies: true,
};

/** Every query the route makes, answered in order from a queue of row sets. */
const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], deleteSession: vi.fn() }));

function queryStub(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject);
      }
      return () => chain;
    },
  });
  return chain;
}

vi.mock("@/db", () => ({
  getDb: () => ({
    select: () => queryStub(mocks.rows.shift() ?? []),
    delete: () => ({ where: mocks.deleteSession }),
  }),
}));
vi.mock("@/lib/env", () => ({ getAuthConfig: () => config }));

import { GET } from "./route";

// A configured, switched-on instance. The values are deliberately recognisable
// so the "nothing leaks" assertion below has something real to look for.
const IMAP_HOST = "imap.relay-route.example.invalid";
const IMAP_MAILBOX = "OrbitPrivateIntake";
const IMAP_USER = "relay-route-mailbox-user";
const RECIPIENT_DOMAIN = "in.relay-route.example.invalid";
const ALIAS_SECRET = "relay-route-alias-secret-that-is-long-enough";

function configureMailIn(overrides: Record<string, string> = {}): void {
  const environment: Record<string, string> = {
    IMAP_ENABLED: "true",
    IMAP_HOST,
    IMAP_PORT: "9993",
    IMAP_USER,
    IMAP_PASSWORD: "relay-route-mailbox-password",
    IMAP_MAILBOX,
    IMAP_RECIPIENT_DOMAIN: RECIPIENT_DOMAIN,
    IMAP_TRUSTED_RECIPIENT_HEADER: "X-Orbit-Delivered-To",
    IMAP_ALIAS_CURRENT_GENERATION: "3",
    IMAP_ALIAS_CURRENT_SECRET: ALIAS_SECRET,
    SMTP_HOST: "smtp.relay-route.example.invalid",
    ...overrides,
  };
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
}

const SESSION_TOKEN = "relay-route-session-token";

function sessionRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    activeHouseholdId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    userId,
    email: "relay@example.invalid",
    emailVerified: true,
    displayName: "Relay Reader",
    avatarUrl: null,
    isInstanceAdmin: false,
    disabledAt: null,
    themeMode: "dark",
    themeId: "starchart",
    textSize: "comfortable",
    urgencyPalette: "themed",
    emailNotifications: true,
    pushNotifications: true,
    ...overrides,
  };
}

function signedIn(url = "http://127.0.0.1:3000/api/settings/mail-relay"): NextRequest {
  const request = new NextRequest(url);
  request.cookies.set("__Host-orbit-session", SESSION_TOKEN);
  return request;
}

type RelayBody = {
  relay: { address: string | null; listening: string; lastReceived: string | null; ingest: string };
};

async function relayFor(rows: unknown[][]): Promise<{ status: number; noStore: string | null; body: RelayBody; raw: string }> {
  mocks.rows.splice(0, mocks.rows.length, ...rows);
  const response = await GET(signedIn());
  const body = await response.json() as RelayBody;
  return {
    status: response.status,
    noStore: response.headers.get("cache-control"),
    body,
    raw: JSON.stringify(body),
  };
}

beforeEach(() => {
  configureMailIn();
});

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.rows.length = 0;
  mocks.deleteSession.mockReset();
});

describe("GET /api/settings/mail-relay", () => {
  it("answers the session's own derived alias, no-store, in bounded words only", async () => {
    const userId = "22222222-2222-4222-8222-222222222222";
    const receivedAt = new Date("2026-08-11T09:24:00.000Z");
    const { status, noStore, body, raw } = await relayFor([
      [sessionRow(userId)],
      [{ receivedAt }],
    ]);

    expect(status).toBe(200);
    expect(noStore).toBe("no-store");
    expect(body.relay).toEqual({
      address: deriveImapRecipientAlias(userId, RECIPIENT_DOMAIN, { generation: 3, secret: ALIAS_SECRET }),
      listening: "connected · listening",
      lastReceived: "2026-08-11T09:24:00.000Z",
      ingest: "enabled",
    });

    // #411: never the host, the port, the mailbox, the credential or the key —
    // only the opaque alias and a fixed word. The recipient domain IS part of
    // the address the user must be told, so it is the one name that may appear.
    expect(raw).not.toContain(IMAP_HOST);
    expect(raw).not.toContain("9993");
    expect(raw).not.toContain(IMAP_MAILBOX);
    expect(raw).not.toContain(IMAP_USER);
    expect(raw).not.toContain(ALIAS_SECRET);
    expect(raw).not.toContain("X-Orbit-Delivered-To");
    expect(raw).not.toContain("smtp");
  });

  it("gives a second session its own relay, never the first session's", async () => {
    const first = await relayFor([[sessionRow("22222222-2222-4222-8222-222222222222")], []]);
    const second = await relayFor([[sessionRow("33333333-3333-4333-8333-333333333333")], []]);

    expect(second.body.relay.address).toBe(
      deriveImapRecipientAlias("33333333-3333-4333-8333-333333333333", RECIPIENT_DOMAIN, { generation: 3, secret: ALIAS_SECRET }),
    );
    expect(second.body.relay.address).not.toBe(first.body.relay.address);
    // The request carries no user id at all, so there is nothing to substitute.
    expect(second.raw).not.toContain(first.body.relay.address!);
  });

  it("reports no arrival rather than inventing one, and never a document name", async () => {
    const { body } = await relayFor([[sessionRow("22222222-2222-4222-8222-222222222222")], []]);
    expect(body.relay.lastReceived).toBeNull();
    expect(body.relay.listening).toBe("connected · listening");
    expect(Object.keys(body.relay).sort()).toEqual(["address", "ingest", "lastReceived", "listening"]);
  });

  it("refuses a request without a session and says nothing else", async () => {
    mocks.rows.length = 0;
    const response = await GET(new NextRequest("http://127.0.0.1:3000/api/settings/mail-relay"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "session_required", message: "A valid session is required" },
    });
  });

  it("tells an instance admin they have no relay instead of handing them a dead one", async () => {
    const { status, body } = await relayFor([
      [sessionRow("44444444-4444-4444-8444-444444444444", { isInstanceAdmin: true })],
    ]);
    expect(status).toBe(200);
    expect(body.relay).toEqual({
      address: null,
      listening: "no relay on this account",
      lastReceived: null,
      // The flag is the INSTANCE's, so it stays true even for an account that
      // has no mailbox of its own.
      ingest: "enabled",
    });
  });

  it("says not listening — and never why — when mail-in is switched off", async () => {
    vi.stubEnv("IMAP_ENABLED", "false");
    const { body, raw } = await relayFor([[sessionRow("22222222-2222-4222-8222-222222222222")]]);
    expect(body.relay).toEqual({ address: null, listening: "not listening", lastReceived: null, ingest: "paused" });
    expect(raw).not.toContain(IMAP_HOST);
    expect(raw).not.toContain(RECIPIENT_DOMAIN);
  });

  it("degrades an unresolvable configuration to the same bounded words, not a 500", async () => {
    // A half-configured mailbox throws out of the environment parser; the
    // reader of this screen can do nothing with that, and its message names
    // environment variables, so it must never become the response.
    vi.stubEnv("IMAP_USER", "");
    const { status, body, raw } = await relayFor([[sessionRow("22222222-2222-4222-8222-222222222222")]]);
    expect(status).toBe(200);
    expect(body.relay).toEqual({ address: null, listening: "not listening", lastReceived: null, ingest: "paused" });
    expect(raw).not.toContain("IMAP_");
  });
});
