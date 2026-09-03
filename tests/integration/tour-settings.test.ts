import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { userPreferences } from "@/db/schema";
import { GET as readTour, PUT as writeTour } from "@/app/api/settings/tour/route";
import { getAuthConfig } from "@/lib/env";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  requestForSession,
  requestWithoutSession,
  type IntegrationSession,
} from "./support/fixtures";

/**
 * The first-run tour record against PostgreSQL (#751, slice 1 of #477). The
 * unit tests pin the route's own behaviour; this pins what only a real
 * database can show — that the column round-trips, that one reader's record
 * is their own, and that a write can never touch another user's row.
 */
const TOUR_URL = "http://127.0.0.1:3000/api/settings/tour";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Tour = { tourSeenAt: string | null };

async function read(session: IntegrationSession): Promise<{ status: number; tour: Tour }> {
  const response = await readTour(requestForSession(session, TOUR_URL));
  const body = await response.json() as { tour: Tour };
  return { status: response.status, tour: body.tour };
}

async function write(session: IntegrationSession, body: unknown, headers: Record<string, string> = {}) {
  const response = await writeTour(requestForSession(session, TOUR_URL, {
    method: "PUT",
    body: JSON.stringify(body),
    headers,
  }));
  return { status: response.status, body: await response.json() as { tour?: Tour; error?: { code: string } } };
}

async function storedTourSeenAt(userId: string): Promise<Date | null> {
  const [row] = await getDb().select({ tourSeenAt: userPreferences.tourSeenAt })
    .from(userPreferences).where(eq(userPreferences.userId, userId));
  return row?.tourSeenAt ?? null;
}

describe("PostgreSQL first-run tour contracts", () => {
  it("round-trips the column: unseen by default, set, then cleared", async () => {
    const fixture = await createIntegrationFixture("tour-round-trip");
    const member = await fixture.session("member");

    const initial = await read(member);
    expect(initial.tour).toEqual({ tourSeenAt: null });
    expect(await storedTourSeenAt(member.userId)).toBeNull();

    const seenAt = "2026-08-15T09:30:00.000Z";
    const set = await write(member, { tourSeenAt: seenAt });
    expect(set.status).toBe(200);
    expect(set.body.tour).toEqual({ tourSeenAt: seenAt });
    expect((await storedTourSeenAt(member.userId))?.toISOString()).toBe(seenAt);

    const afterSet = await read(member);
    expect(afterSet.tour).toEqual({ tourSeenAt: seenAt });

    const cleared = await write(member, { tourSeenAt: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tour).toEqual({ tourSeenAt: null });
    expect(await storedTourSeenAt(member.userId)).toBeNull();
  });

  it("stores one reader's record without touching another's", async () => {
    const fixture = await createIntegrationFixture("tour-per-user");
    const member = await fixture.session("member");
    const owner = await fixture.session("owner");

    const seenAt = "2026-08-20T00:00:00.000Z";
    const saved = await write(member, { tourSeenAt: seenAt });
    expect(saved.status).toBe(200);

    const mine = await read(member);
    expect(mine.tour).toEqual({ tourSeenAt: seenAt });

    const theirs = await read(owner);
    expect(theirs.tour).toEqual({ tourSeenAt: null });
    expect(await storedTourSeenAt(owner.userId)).toBeNull();
  });

  it("ignores a user id supplied in the body and writes only the session's own row", async () => {
    const fixture = await createIntegrationFixture("tour-ignores-body-user-id");
    const member = await fixture.session("member");
    const owner = await fixture.session("owner");

    const seenAt = "2026-08-22T00:00:00.000Z";
    const result = await write(member, { userId: owner.userId, tourSeenAt: seenAt });
    expect(result.status).toBe(200);

    expect((await storedTourSeenAt(member.userId))?.toISOString()).toBe(seenAt);
    expect(await storedTourSeenAt(owner.userId)).toBeNull();
  });

  it("refuses a non-timestamp value at the route, and stores nothing", async () => {
    const fixture = await createIntegrationFixture("tour-refuses-non-timestamp");
    const member = await fixture.session("member");

    for (const invalid of [{ tourSeenAt: 12345 }, { tourSeenAt: "not-a-timestamp" }, { tourSeenAt: true }]) {
      const refused = await write(member, invalid);
      expect(refused.status, JSON.stringify(invalid)).toBe(422);
      expect(refused.body.error?.code).toBe("validation_failed");
    }
    expect(await storedTourSeenAt(member.userId)).toBeNull();
  });

  it("answers nothing and writes nothing without a session or a CSRF token", async () => {
    const fixture = await createIntegrationFixture("tour-refused");
    const member = await fixture.session("member");
    const config = getAuthConfig();

    const anonymousRead = await readTour(requestWithoutSession(TOUR_URL));
    expect(anonymousRead.status).toBe(401);
    expect(anonymousRead.headers.get("cache-control")).toBe("no-store");

    const anonymousWrite = await writeTour(requestWithoutSession(TOUR_URL, {
      method: "PUT",
      body: JSON.stringify({ tourSeenAt: "2026-08-25T00:00:00.000Z" }),
      headers: { origin: config.appUrl.origin, "sec-fetch-site": "same-origin" },
    }));
    expect(anonymousWrite.status).toBe(401);

    const noCsrf = await write(member, { tourSeenAt: "2026-08-25T00:00:00.000Z" }, {
      "x-csrf-token": "invalid-csrf",
    });
    expect(noCsrf.status).toBe(403);

    const crossSite = await write(member, { tourSeenAt: "2026-08-25T00:00:00.000Z" }, {
      origin: "https://attacker.invalid",
    });
    expect(crossSite.status).toBe(403);

    expect(await storedTourSeenAt(member.userId)).toBeNull();
  });
});
