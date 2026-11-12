import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FAKE_TOKEN, FakeGithub, runScript } from "../test-support/fake-github.mjs";
import { PROCESS_TEST_TIMEOUT_MS } from "../process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * #1824: handoff drafts pile up on GitHub; the publish workflow deletes the
 * ones older than a limit (14 days by default) and nothing else.
 */
const SCRIPT = new URL("./github-prune-handoffs.sh", import.meta.url).pathname;
const DAY = 24 * 3600 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const sha = (c) => `handoff-${c.repeat(40)}`;

let fake;
beforeEach(async () => {
  fake = await new FakeGithub().start();
});
afterEach(async () => {
  await fake.stop();
});

const prune = (extra = {}) =>
  runScript(SCRIPT, {
    GITHUB_API_URL: fake.apiUrl,
    GITHUB_REPOSITORY: fake.repository,
    GH_TOKEN: FAKE_TOKEN,
    ...extra,
  });

const remaining = () => fake.releases.map((r) => r.tag_name).sort();

describe("github-prune-handoffs.sh", () => {
  it("deletes old handoff drafts and keeps every other release", async () => {
    fake.addRelease({ tag_name: sha("a"), created_at: daysAgo(15) }); // old handoff draft: goes
    fake.addRelease({ tag_name: sha("b"), created_at: daysAgo(30) }); // older: goes
    fake.addRelease({ tag_name: sha("c"), created_at: daysAgo(13) }); // younger than 14 days: stays
    fake.addRelease({ tag_name: sha("d"), created_at: daysAgo(0) }); // new: stays
    fake.addRelease({ tag_name: sha("e"), created_at: daysAgo(40), draft: false }); // published, handoff-named: stays
    fake.addRelease({ tag_name: "v1.2.3", created_at: daysAgo(40), draft: true }); // draft, other name: stays
    fake.addRelease({ tag_name: "v1.2.4", created_at: daysAgo(40), draft: false });
    fake.addRelease({ tag_name: `not-${sha("f")}`, created_at: daysAgo(40), draft: true }); // does not start handoff-: stays
    const result = await prune();
    expect(result.status, result.stderr).toBe(0);
    expect(fake.deleted.sort()).toEqual([sha("a"), sha("b")].sort());
    expect(remaining()).toEqual([sha("c"), sha("d"), sha("e"), "v1.2.3", "v1.2.4", `not-${sha("f")}`].sort());
  });

  it("matches the tag name, not the release title", async () => {
    fake.addRelease({ tag_name: "v9.9.9", name: sha("a"), created_at: daysAgo(40), draft: true });
    fake.addRelease({ tag_name: sha("b"), name: "Some title", created_at: daysAgo(40), draft: true });
    const result = await prune();
    expect(result.status, result.stderr).toBe(0);
    expect(fake.deleted).toEqual([sha("b")]);
  });

  it("follows ORBIT_HANDOFF_MAX_AGE_DAYS", async () => {
    fake.addRelease({ tag_name: sha("a"), created_at: daysAgo(4) });
    fake.addRelease({ tag_name: sha("b"), created_at: daysAgo(2) });
    const result = await prune({ ORBIT_HANDOFF_MAX_AGE_DAYS: "3" });
    expect(result.status, result.stderr).toBe(0);
    expect(fake.deleted).toEqual([sha("a")]);
  });

  it("prunes releases past the first page of the list", async () => {
    for (let i = 0; i < 45; i += 1) {
      fake.addRelease({ tag_name: `handoff-${String(i).padStart(40, "0")}`, created_at: daysAgo(20) });
    }
    fake.addRelease({ tag_name: sha("z"), created_at: daysAgo(1) });
    const result = await prune();
    expect(result.status, result.stderr).toBe(0);
    expect(fake.deleted).toHaveLength(45);
    expect(remaining()).toEqual([sha("z")]);
  });

  it("does nothing, successfully, when there is nothing old enough", async () => {
    fake.addRelease({ tag_name: sha("a"), created_at: daysAgo(1) });
    const result = await prune();
    expect(result.status, result.stderr).toBe(0);
    expect(fake.mutations()).toEqual([]);
  });

  it("refuses an age that is not a whole number, deleting nothing", async () => {
    fake.addRelease({ tag_name: sha("a"), created_at: daysAgo(40) });
    for (const age of ["soon", "-1", "1.5"]) {
      const result = await prune({ ORBIT_HANDOFF_MAX_AGE_DAYS: age });
      expect(result.status, JSON.stringify(age)).not.toBe(0);
    }
    expect(fake.mutations()).toEqual([]);
  });

  it("never prints the token", async () => {
    fake.addRelease({ tag_name: sha("a"), created_at: daysAgo(40) });
    const result = await prune();
    expect(result.stdout + result.stderr).not.toContain(FAKE_TOKEN);
    expect(fake.requests.every((r) => r.authorized)).toBe(true);
  });
});
