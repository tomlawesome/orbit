import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { userPreferences } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { dismissWhatsNew, readWhatsNew, recordNewAccountSeenVersion } from "@/server/whats-new";
import type { ReleaseNotes } from "@/release-notes";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
} from "./support/fixtures";

/**
 * The what's-new notice against PostgreSQL (#1618, server half). The unit
 * tests pin the selection rules; this pins what only a real database shows:
 * the column round-trips, shown once then never again, the stored version
 * never moves backwards, and one person's record is their own. Notes are
 * injected, never the real release files.
 */
afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const bullet = (lead: string) => ({ lead, text: `${lead} text.` });
const NOTES: ReleaseNotes[] = [
  { version: "v0.3.5", forEveryone: [bullet("E5")], forAdministrators: [bullet("A5")] },
  { version: "v0.3.6", forEveryone: [], forAdministrators: [bullet("A6")] },
  { version: "v0.3.7", forEveryone: [bullet("E7")], forAdministrators: [] },
];

async function stored(userId: string): Promise<string | null> {
  const [row] = await getDb().select({ seen: userPreferences.whatsNewSeenVersion })
    .from(userPreferences).where(eq(userPreferences.userId, userId));
  return row?.seen ?? null;
}

async function setStored(userId: string, seen: string | null): Promise<void> {
  await getDb().update(userPreferences).set({ whatsNewSeenVersion: seen }).where(eq(userPreferences.userId, userId));
}

const versionsOf = (answer: { releases: { version: string }[] }) => answer.releases.map((r) => r.version);

describe("PostgreSQL what's-new contracts", () => {
  it("shows once, then never again after dismissal", async () => {
    const fixture = await createIntegrationFixture("wn-once");
    const { userId } = await fixture.session("member");
    await setStored(userId, "v0.3.4");

    const first = await readWhatsNew(userId, { runningVersion: "v0.3.7", notes: NOTES });
    expect(first.version).toBe("v0.3.7");
    expect(versionsOf(first)).toEqual(["v0.3.7", "v0.3.5"]);

    await dismissWhatsNew(userId, "v0.3.7", { runningVersion: "v0.3.7" });
    expect(await stored(userId)).toBe("v0.3.7");
    expect((await readWhatsNew(userId, { runningVersion: "v0.3.7", notes: NOTES })).releases).toEqual([]);
  });

  it("gives an administrator both parts and a member the everyone part only", async () => {
    const fixture = await createIntegrationFixture("wn-roles");
    const admin = await fixture.session("admin");
    const member = await fixture.session("member");
    await setStored(admin.userId, "v0.3.4");
    await setStored(member.userId, "v0.3.4");

    const adminAnswer = await readWhatsNew(admin.userId, { runningVersion: "v0.3.5", notes: NOTES });
    expect(adminAnswer.releases).toEqual([
      { version: "v0.3.5", forEveryone: [bullet("E5")], forAdministrators: [bullet("A5")] },
    ]);
    const memberAnswer = await readWhatsNew(member.userId, { runningVersion: "v0.3.5", notes: NOTES });
    expect(memberAnswer.releases).toEqual([{ version: "v0.3.5", forEveryone: [bullet("E5")] }]);
    expect("forAdministrators" in memberAnswer.releases[0]).toBe(false);
  });

  it("reaches administrators only for a release with only an administrators part", async () => {
    const fixture = await createIntegrationFixture("wn-admin-only");
    const admin = await fixture.session("admin");
    const member = await fixture.session("member");
    await setStored(admin.userId, "v0.3.5");
    await setStored(member.userId, "v0.3.5");

    expect(versionsOf(await readWhatsNew(admin.userId, { runningVersion: "v0.3.6", notes: NOTES }))).toEqual(["v0.3.6"]);
    expect((await readWhatsNew(member.userId, { runningVersion: "v0.3.6", notes: NOTES })).releases).toEqual([]);
  });

  it("shows a fresh account nothing old, and records the running version", async () => {
    const fixture = await createIntegrationFixture("wn-fresh");
    const { userId } = await fixture.session("outsider");
    await setStored(userId, null);

    await recordNewAccountSeenVersion(userId, "v0.3.7");
    expect(await stored(userId)).toBe("v0.3.7");
    expect((await readWhatsNew(userId, { runningVersion: "v0.3.7", notes: NOTES })).releases).toEqual([]);

    /* ...and sees the next release's notes after an upgrade. */
    const later: ReleaseNotes[] = [...NOTES, { version: "v0.3.8", forEveryone: [bullet("E8")], forAdministrators: [] }];
    expect(versionsOf(await readWhatsNew(userId, { runningVersion: "v0.3.8", notes: later }))).toEqual(["v0.3.8"]);
  });

  it("treats a null stored value as a new account: records the running version, shows nothing", async () => {
    const fixture = await createIntegrationFixture("wn-null");
    const { userId } = await fixture.session("member");
    await setStored(userId, null);

    const answer = await readWhatsNew(userId, { runningVersion: "v0.3.7", notes: NOTES });
    expect(answer.releases).toEqual([]);
    expect(await stored(userId)).toBe("v0.3.7");
  });

  it("leaves a null value alone when the running version does not parse", async () => {
    const fixture = await createIntegrationFixture("wn-null-dev");
    const { userId } = await fixture.session("member");
    await setStored(userId, null);

    for (const runningVersion of [null, undefined, "dev", "v0.3"]) {
      const answer = await readWhatsNew(userId, { runningVersion, notes: NOTES });
      expect(answer).toEqual({ version: null, releases: [] });
      expect(await stored(userId)).toBeNull();
    }
  });

  it("recordNewAccountSeenVersion is a no-op for an unparsable version and never overwrites a value", async () => {
    const fixture = await createIntegrationFixture("wn-record");
    const { userId } = await fixture.session("member");
    await setStored(userId, null);

    await recordNewAccountSeenVersion(userId, "dev");
    await recordNewAccountSeenVersion(userId, "");
    expect(await stored(userId)).toBeNull();

    await setStored(userId, "v0.3.2");
    await recordNewAccountSeenVersion(userId, "v0.3.7");
    expect(await stored(userId)).toBe("v0.3.2");
  });

  it("shows skipped releases together, newest first", async () => {
    const fixture = await createIntegrationFixture("wn-skipped");
    const admin = await fixture.session("admin");
    await setStored(admin.userId, "v0.3.0");

    const answer = await readWhatsNew(admin.userId, { runningVersion: "v0.3.7", notes: NOTES });
    expect(versionsOf(answer)).toEqual(["v0.3.7", "v0.3.6", "v0.3.5"]);
  });

  it("is empty on a downgrade and does not change the stored value", async () => {
    const fixture = await createIntegrationFixture("wn-downgrade");
    const { userId } = await fixture.session("member");
    await setStored(userId, "v0.3.7");

    expect((await readWhatsNew(userId, { runningVersion: "v0.3.5", notes: NOTES })).releases).toEqual([]);
    expect(await stored(userId)).toBe("v0.3.7");
  });

  it("never moves the stored version backwards, and is idempotent", async () => {
    const fixture = await createIntegrationFixture("wn-monotonic");
    const { userId } = await fixture.session("member");
    await setStored(userId, "v0.3.6");

    await dismissWhatsNew(userId, "v0.3.5", { runningVersion: "v0.3.7" });
    expect(await stored(userId)).toBe("v0.3.6");

    await dismissWhatsNew(userId, "v0.3.7", { runningVersion: "v0.3.7" });
    await dismissWhatsNew(userId, "v0.3.7", { runningVersion: "v0.3.7" });
    expect(await stored(userId)).toBe("v0.3.7");
  });

  it("stores the running version when the card showed something newer", async () => {
    const fixture = await createIntegrationFixture("wn-clamp");
    const { userId } = await fixture.session("member");
    await setStored(userId, "v0.3.4");

    await dismissWhatsNew(userId, "v0.3.9", { runningVersion: "v0.3.7" });
    expect(await stored(userId)).toBe("v0.3.7");
  });

  it("compares numerically when storing", async () => {
    const fixture = await createIntegrationFixture("wn-numeric");
    const { userId } = await fixture.session("member");
    await setStored(userId, "v0.3.9");

    await dismissWhatsNew(userId, "v0.3.10", { runningVersion: "v0.3.10" });
    expect(await stored(userId)).toBe("v0.3.10");
  });

  it("refuses a malformed shown version with a 422 validation_failed and stores nothing", async () => {
    const fixture = await createIntegrationFixture("wn-malformed");
    const { userId } = await fixture.session("member");
    await setStored(userId, "v0.3.4");

    for (const bad of ["banana", "", "0.3.7", "v0.3", "v0.3.7-rc1", "v01.3.7"]) {
      const error = await dismissWhatsNew(userId, bad, { runningVersion: "v0.3.7" }).catch((e: unknown) => e);
      expect(error, bad).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(422);
      expect((error as AppError).code).toBe("validation_failed");
    }
    expect(await stored(userId)).toBe("v0.3.4");
  });

  it("keeps two people's records apart", async () => {
    const fixture = await createIntegrationFixture("wn-isolation");
    const member = await fixture.session("member");
    const owner = await fixture.session("owner");
    await setStored(member.userId, "v0.3.4");
    await setStored(owner.userId, "v0.3.4");

    await dismissWhatsNew(member.userId, "v0.3.7", { runningVersion: "v0.3.7" });

    expect(await stored(member.userId)).toBe("v0.3.7");
    expect(await stored(owner.userId)).toBe("v0.3.4");
    expect(versionsOf(await readWhatsNew(owner.userId, { runningVersion: "v0.3.7", notes: NOTES }))).toEqual(["v0.3.7", "v0.3.5"]);
    expect((await readWhatsNew(member.userId, { runningVersion: "v0.3.7", notes: NOTES })).releases).toEqual([]);
  });
});
