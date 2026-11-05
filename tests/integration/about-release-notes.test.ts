import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { userPreferences } from "@/db/schema";
import { readReleaseNotes, readWhatsNew } from "@/server/whats-new";
import type { ReleaseNotes } from "@/release-notes";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
} from "./support/fixtures";

/**
 * The About page's release-notes read against PostgreSQL (#1713). Beside
 * readWhatsNew (#1618) and filtered by role the same way -- the
 * administrator fact read from the database, not taken from the caller --
 * but it lists every bundled release and records nothing: no seen version
 * for a new account, no change to anyone's stored value. Notes injected.
 */
afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const bullet = (lead: string) => ({ lead, text: `${lead} text.` });
const NOTES: ReleaseNotes[] = [
  { version: "v0.3.5", forEveryone: [bullet("E5")], forAdministrators: [bullet("A5")] },
  { version: "v0.3.6", forEveryone: [], forAdministrators: [bullet("A6")] },
  { version: "v0.3.7", forEveryone: [bullet("E7")], forAdministrators: [] },
  { version: "v0.3.8", forEveryone: [], forAdministrators: [] },
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

describe("PostgreSQL release-notes read for the About page (#1713)", () => {
  it("gives an administrator every release with both parts, newest first, and the running version", async () => {
    const fixture = await createIntegrationFixture("rn-admin");
    const { userId } = await fixture.session("admin");

    const answer = await readReleaseNotes(userId, { runningVersion: "v0.3.7", notes: NOTES });
    expect(answer).toEqual({
      version: "v0.3.7",
      releases: [
        { version: "v0.3.7", forEveryone: [bullet("E7")], forAdministrators: [] },
        { version: "v0.3.6", forEveryone: [], forAdministrators: [bullet("A6")] },
        { version: "v0.3.5", forEveryone: [bullet("E5")], forAdministrators: [bullet("A5")] },
      ],
    });
  });

  it("gives a member the everyone part only, and leaves out a release with nothing for them", async () => {
    const fixture = await createIntegrationFixture("rn-member");
    const { userId } = await fixture.session("member");

    const answer = await readReleaseNotes(userId, { runningVersion: "v0.3.7", notes: NOTES });
    expect(answer.releases).toEqual([
      { version: "v0.3.7", forEveryone: [bullet("E7")] },
      { version: "v0.3.5", forEveryone: [bullet("E5")] },
    ]);
    for (const release of answer.releases) expect("forAdministrators" in release).toBe(false);
  });

  it("filters by role exactly as readWhatsNew does, for every role", async () => {
    const fixture = await createIntegrationFixture("rn-parity");
    for (const role of ["admin", "owner", "member", "outsider"] as const) {
      const { userId } = await fixture.session(role);
      await setStored(userId, "v0.0.0");
      const card = await readWhatsNew(userId, { runningVersion: "v0.3.7", notes: NOTES });
      const page = await readReleaseNotes(userId, { runningVersion: "v0.3.7", notes: NOTES });
      expect(page, role).toEqual(card);
    }
  });

  it("lists every release whatever the person has already seen", async () => {
    const fixture = await createIntegrationFixture("rn-seen");
    const { userId } = await fixture.session("admin");
    await setStored(userId, "v0.3.7");

    expect((await readWhatsNew(userId, { runningVersion: "v0.3.7", notes: NOTES })).releases).toEqual([]);
    expect(versionsOf(await readReleaseNotes(userId, { runningVersion: "v0.3.7", notes: NOTES }))).toEqual(["v0.3.7", "v0.3.6", "v0.3.5"]);
  });

  it("records nothing for a new account: a null stored value stays null", async () => {
    const fixture = await createIntegrationFixture("rn-null");
    const { userId } = await fixture.session("member");
    await setStored(userId, null);

    const answer = await readReleaseNotes(userId, { runningVersion: "v0.3.7", notes: NOTES });
    expect(versionsOf(answer)).toEqual(["v0.3.7", "v0.3.5"]);
    expect(await stored(userId)).toBeNull();
  });

  it("does not move anyone's stored version, however often it is read", async () => {
    const fixture = await createIntegrationFixture("rn-still");
    const { userId } = await fixture.session("admin");
    await setStored(userId, "v0.3.4");

    for (let i = 0; i < 3; i += 1) await readReleaseNotes(userId, { runningVersion: "v0.3.7", notes: NOTES });
    expect(await stored(userId)).toBe("v0.3.4");
    /* ...so the card still has its notes to show. */
    expect(versionsOf(await readWhatsNew(userId, { runningVersion: "v0.3.7", notes: NOTES }))).toEqual(["v0.3.7", "v0.3.6", "v0.3.5"]);
  });

  it("is an empty list, not an error, with no notes bundled", async () => {
    const fixture = await createIntegrationFixture("rn-empty");
    const { userId } = await fixture.session("member");
    expect(await readReleaseNotes(userId, { runningVersion: "v0.3.7", notes: [] })).toEqual({ version: "v0.3.7", releases: [] });
  });

  it("still lists the notes with a null version in a dev build, and records nothing", async () => {
    const fixture = await createIntegrationFixture("rn-dev");
    const { userId } = await fixture.session("member");
    await setStored(userId, null);

    for (const runningVersion of [null, undefined, "dev"]) {
      const answer = await readReleaseNotes(userId, { runningVersion, notes: NOTES });
      expect(answer.version).toBeNull();
      expect(versionsOf(answer)).toEqual(["v0.3.7", "v0.3.5"]);
    }
    expect(await stored(userId)).toBeNull();
  });

  it("reads the bundled notes by default", async () => {
    const fixture = await createIntegrationFixture("rn-default");
    const { userId } = await fixture.session("admin");
    const { releaseNotes } = await import("@/release-notes");
    const answer = await readReleaseNotes(userId, { runningVersion: "v0.3.7" });
    const expected = releaseNotes.filter((one) => one.forEveryone.length || one.forAdministrators.length).map((one) => one.version);
    expect(new Set(versionsOf(answer))).toEqual(new Set(expected));
  });

  it("lists the notes it is given, not the bundled ones (injected, non-empty)", async () => {
    /* The bundled v0.3.7 notes are empty, so a read that ignored `notes` and
       used the bundle would also give an empty list and pass the test above
       vacuously. These are non-empty and carry versions the bundle lacks. */
    const fixture = await createIntegrationFixture("rn-injected");
    const { userId } = await fixture.session("admin");
    const { releaseNotes } = await import("@/release-notes");
    const answer = await readReleaseNotes(userId, { runningVersion: "v0.3.7", notes: NOTES });
    expect(versionsOf(answer).length, "the injected notes gave something").toBeGreaterThan(0);
    expect(versionsOf(answer)).toEqual(["v0.3.7", "v0.3.6", "v0.3.5"]);
    expect(answer.releases).not.toEqual(
      (await readReleaseNotes(userId, { runningVersion: "v0.3.7", notes: releaseNotes })).releases,
    );
  });
});
