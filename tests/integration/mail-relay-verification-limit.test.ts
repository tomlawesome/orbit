import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDb } from "@/db";
import {
  auditLog,
  imapRecipientAliases,
  mailInMailbox,
  mailInRelays,
  mailInSecrets,
  mailInSenderAddresses,
} from "@/db/schema";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { seedSenderAddress } from "@/server/mail-in/sender-addresses";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRouteForSession, loadRoute, type RouteHandler } from "./support/request-event";

/*
 * Issue #1403, owner decision 2026-10-14 (note 38581): the route that sends
 * the sender check email, `POST /api/settings/mail-relay/verification`, is
 * rate-limited per member.
 *
 *   - at most one check email per 60 seconds, and five per 24 hours;
 *   - a refused request answers 429 `sender_check_too_soon`, with a
 *     `Retry-After` header in whole seconds (RFC 6585 section 4), and sends
 *     no email;
 *   - the count is kept in the database, so a restart does not forget it
 *     (the reasoning of local sign-in lockout, ADR-0023 section 4);
 *   - refused requests (429, 409, 503) do not count;
 *   - an already-checked address still answers 409, never 429;
 *   - the limit is per member.
 *
 * Assumptions the specification leaves open, stated so a reviewer can
 * overrule them:
 *
 *   - The 24-hour limit is a ROLLING window: a send counts for 24 hours after
 *     it was made. `Retry-After` for the sixth request is therefore the time
 *     until the OLDEST of the five counted sends leaves the window, rounded up
 *     to a whole second; for a too-soon request it is the time until 60
 *     seconds have passed since the newest counted send, rounded up.
 *   - When both limits apply, `Retry-After` is the longer wait (the earliest
 *     moment a retry could succeed). These cases never make both apply at
 *     once except where noted.
 *   - Time is moved with Vitest's fake `Date` only (timers stay real, so the
 *     database driver is unaffected). No integration test used fake timers
 *     before, and the stored timestamps cannot be set directly here because
 *     where the limit's state lives is the build's choice. The build must
 *     therefore read the time from the JavaScript clock (`new Date()` /
 *     `Date.now()`) rather than the database's `now()`.
 *   - Instants of exactly 60 s or exactly 24 h are not tested (whether the
 *     boundary itself is inside or outside is not specified); cases step one
 *     second either side.
 *   - A "restart" is closing the database pool and dropping the settings and
 *     key caches, so the next request reads everything from the database
 *     again. (Reloading every module with vi.resetModules() was tried and
 *     breaks the account-address decryption for reasons unrelated to this
 *     feature, so a count held in a module variable would not be caught by
 *     this alone; the fixtures make new members per case, which is what keeps
 *     such state from carrying over between cases.)
 *   - Mail is captured at the transport library, as in
 *     mail-relay-verification.test.ts. A 503 is provoked by removing the SMTP
 *     settings.
 */
const mail = vi.hoisted(() => ({
  sent: [] as Array<{ from: string; to: string; subject: string; text: string }>,
}));

vi.mock("nodemailer", () => {
  const createTransport = () => ({
    async sendMail(message: { from: string; to: string; subject: string; text: string }) {
      mail.sent.push({ from: message.from, to: message.to, subject: message.subject, text: message.text });
      return { messageId: "fixture" };
    },
    async verify() { return true; },
    close() {},
  });
  return { default: { createTransport }, createTransport };
});

const VERIFICATION_URL = "http://127.0.0.1:3000/api/settings/mail-relay/verification";
const SECOND = 1000;
const DAY_S = 24 * 3600;
/* A whole second, so every Retry-After below is an exact integer. */
const T0 = Date.UTC(2031, 2, 4, 9, 0, 0);

let route: RouteHandler | undefined;
const verificationRoute = async () => route ?? (route = (await loadRoute("settings/mail-relay/verification")).POST);

let fixture: IntegrationFixture;
const savedEnvironment: Record<string, string | undefined> = {};

const SMTP_URL = "smtp://orbit-test:fake-smtp-password@smtp.example.test:587";

beforeEach(async () => {
  mail.sent.length = 0;
  route = undefined;
  for (const name of ["SMTP_URL", "SMTP_FROM", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"]) savedEnvironment[name] = process.env[name];
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  process.env.SMTP_URL = SMTP_URL;
  process.env.SMTP_FROM = "Orbit <orbit@example.test>";
  fixture = await createIntegrationFixture("sender-check-limit");
});

afterEach(async () => {
  vi.useRealTimers();
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const db = getDb();
  await db.delete(imapRecipientAliases);
  await db.delete(mailInSenderAddresses);
  await db.delete(mailInRelays);
  await db.update(mailInMailbox).set({ passwordSecretId: null, aliasKeySecretId: null });
  await db.delete(mailInMailbox);
  await db.delete(mailInSecrets);
  await db.delete(auditLog);
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** Freezes the clock at `T0 + offsetSeconds`. Only `Date` is faked. */
function at(offsetSeconds: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 + offsetSeconds * SECOND);
}

/** A session made at the current (possibly faked) time, so it never reads as expired. */
async function send(role: "member" | "owner" = "member") {
  const session: IntegrationSession = await fixture.session(role);
  return callRouteForSession(await verificationRoute(), session, {
    url: VERIFICATION_URL,
    method: "POST",
    body: null,
  });
}

async function refusal(response: Response) {
  const body = await response.json() as { error: { code: string } };
  return { status: response.status, code: body.error.code, retryAfter: response.headers.get("retry-after") };
}

/** What a process restart does to what the process had learned: the pool is closed (a new one opens on the next read) and the key and settings caches are dropped. */
async function restart() {
  await closeDatabase();
  resetDocumentConfigForTests();
  resetMetadataKeyCacheForTests();
}

const rowsOf = (userId: string) => getDb().select().from(mailInSenderAddresses).where(eq(mailInSenderAddresses.userId, userId));

/** Five accepted sends, 61 s apart, starting at T0. The fifth is at T0 + 244 s. */
async function fiveSends(role: "member" | "owner" = "member") {
  for (let index = 0; index < 5; index += 1) {
    at(index * 61);
    expect((await send(role)).status).toBe(202);
  }
  expect(mail.sent).toHaveLength(5);
}

describe("one check email per 60 seconds", () => {
  it("refuses a second request within 60 s with 429 sender_check_too_soon, a Retry-After of at most 60 s, and sends no email", async () => {
    at(0);
    expect((await send()).status).toBe(202);
    expect(mail.sent).toHaveLength(1);

    at(10);
    const second = await send();

    expect(second.status).toBe(429);
    expect(second.headers.get("cache-control")).toContain("no-store");
    const { code, retryAfter } = await refusal(second);
    expect(code).toBe("sender_check_too_soon");
    expect(retryAfter).toMatch(/^[0-9]+$/);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
    expect(Number(retryAfter)).toBe(50);
    expect(mail.sent).toHaveLength(1);
  });

  it("says one second to wait when 59 s have passed", async () => {
    at(0);
    expect((await send()).status).toBe(202);

    at(59);
    const second = await send();

    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("1");
    expect(mail.sent).toHaveLength(1);
  });

  it("accepts the next request once 60 s have passed (61 s)", async () => {
    at(0);
    expect((await send()).status).toBe(202);

    at(61);
    const second = await send();

    expect(second.status).toBe(202);
    expect(second.headers.get("retry-after")).toBeNull();
    expect(mail.sent).toHaveLength(2);
  });
});

describe("five check emails per 24 hours", () => {
  it("accepts five, 61 s apart, and refuses the sixth with 429 and a Retry-After to when the oldest leaves the window", async () => {
    await fiveSends();

    at(5 * 61);
    const sixth = await send();

    expect(sixth.status).toBe(429);
    const { code, retryAfter } = await refusal(sixth);
    expect(code).toBe("sender_check_too_soon");
    expect(retryAfter).toMatch(/^[0-9]+$/);
    /* The oldest send was at T0; the sixth request is at T0 + 305 s. */
    expect(Number(retryAfter)).toBe(DAY_S - 5 * 61);
    expect(mail.sent).toHaveLength(5);
  });

  it("accepts again once the oldest send is more than 24 h old, and not before", async () => {
    await fiveSends();

    at(DAY_S - 1);
    const before = await send();
    expect(before.status).toBe(429);
    expect(before.headers.get("retry-after")).toBe("1");

    at(DAY_S + 1);
    const after = await send();
    expect(after.status).toBe(202);
    expect(mail.sent).toHaveLength(6);
  });

  it("is a rolling window: a send counts for 24 h from when it was made, not from the first send of a batch", async () => {
    const HALF = DAY_S / 2;
    at(0);
    expect((await send()).status).toBe(202);
    for (let index = 0; index < 4; index += 1) {
      at(HALF + index * 61);
      expect((await send()).status).toBe(202);
    }
    expect(mail.sent).toHaveLength(5);

    /* The first send leaves the window at DAY_S: one slot opens, no more. */
    at(DAY_S + 1);
    expect((await send()).status).toBe(202);

    /* The window now holds the four from HALF onwards and the one just made.
       The oldest of those, at HALF, leaves at HALF + DAY_S. */
    at(DAY_S + 62);
    const refused = await send();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe(String(HALF + DAY_S - (DAY_S + 62)));
    expect(mail.sent).toHaveLength(6);
  });
});

describe("refused requests do not count", () => {
  it("does not extend the 60 s wait: ten refusals at 10 s change nothing for the request at 61 s", async () => {
    at(0);
    expect((await send()).status).toBe(202);

    at(10);
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await send()).status).toBe(429);

    at(61);
    expect((await send()).status).toBe(202);
    expect(mail.sent).toHaveLength(2);
  });

  it("does not use up the five: a refusal inside the window leaves the next window slot where it was", async () => {
    at(0);
    expect((await send()).status).toBe(202);
    at(10);
    expect((await send()).status).toBe(429);
    for (let index = 1; index < 5; index += 1) {
      at(index * 61);
      expect((await send()).status).toBe(202);
    }
    expect(mail.sent).toHaveLength(5);

    /* Had the refusal at 10 s counted it would leave the window at DAY_S + 10, not DAY_S. */
    at(DAY_S + 1);
    expect((await send()).status).toBe(202);
    expect(mail.sent).toHaveLength(6);
  });

  it("does not count a 409 against the limit: once the address is unchecked again the member still has all five", async () => {
    await seedSenderAddress(fixture.users.member.id);
    at(0);
    await getDb().update(mailInSenderAddresses).set({ verifiedAt: new Date() }).where(eq(mailInSenderAddresses.userId, fixture.users.member.id));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      at(attempt * 61);
      expect((await send()).status).toBe(409);
    }
    expect(mail.sent).toEqual([]);

    await getDb().update(mailInSenderAddresses).set({ verifiedAt: null }).where(eq(mailInSenderAddresses.userId, fixture.users.member.id));
    for (let index = 0; index < 5; index += 1) {
      at(400 + index * 61);
      expect((await send()).status).toBe(202);
    }
    expect(mail.sent).toHaveLength(5);
  });

  it("does not count a 503 (mail not configured) against the limit", async () => {
    delete process.env.SMTP_URL;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      at(attempt * 61);
      const response = await send();
      expect(response.status).toBe(503);
    }
    expect(mail.sent).toEqual([]);

    process.env.SMTP_URL = SMTP_URL;
    at(6 * 61);
    expect((await send()).status).toBe(202);
    expect(mail.sent).toHaveLength(1);
  });
});

describe("an already-checked address", () => {
  it("answers 409 sender_already_verified, never 429, even straight after a send and after the five are used", async () => {
    await fiveSends();
    await getDb().update(mailInSenderAddresses).set({ verifiedAt: new Date() }).where(eq(mailInSenderAddresses.userId, fixture.users.member.id));

    at(5 * 61);
    const response = await send();

    expect(response.status).toBe(409);
    expect((await refusal(response)).code).toBe("sender_already_verified");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(mail.sent).toHaveLength(5);
  });

  it("answers 409 rather than 429 when the 60 s wait is still running", async () => {
    at(0);
    expect((await send()).status).toBe(202);
    await getDb().update(mailInSenderAddresses).set({ verifiedAt: new Date() }).where(eq(mailInSenderAddresses.userId, fixture.users.member.id));

    at(5);
    const response = await send();

    expect(response.status).toBe(409);
    expect((await refusal(response)).code).toBe("sender_already_verified");
  });
});

describe("the limit is per member", () => {
  it("does not make one member's sends limit another: the 60 s wait", async () => {
    at(0);
    expect((await send("member")).status).toBe(202);

    at(5);
    expect((await send("owner")).status).toBe(202);
    expect((await send("member")).status).toBe(429);

    expect(mail.sent.map((message) => message.to)).toEqual([fixture.users.member.email, fixture.users.owner.email]);
  });

  it("does not make one member's five limit another", async () => {
    await fiveSends("member");

    at(5 * 61);
    expect((await send("member")).status).toBe(429);
    const other = await send("owner");

    expect(other.status).toBe(202);
    expect(mail.sent).toHaveLength(6);
    expect(mail.sent[5].to).toBe(fixture.users.owner.email);
  });
});

describe("the limit survives a restart", () => {
  it("still refuses within 60 s after the database pool and caches were dropped, and sends nothing", async () => {
    at(0);
    expect((await send()).status).toBe(202);

    await restart();
    at(10);
    const second = await send();

    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("50");
    expect(mail.sent).toHaveLength(1);
  });

  it("still counts the five after a restart, and then lets the oldest go after 24 h", async () => {
    await fiveSends();

    await restart();
    at(5 * 61);
    const sixth = await send();
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toBe(String(DAY_S - 5 * 61));
    expect(mail.sent).toHaveLength(5);

    await restart();
    at(DAY_S + 1);
    expect((await send()).status).toBe(202);
    expect(mail.sent).toHaveLength(6);
    expect(await rowsOf(fixture.users.member.id)).toHaveLength(1);
  });
});
