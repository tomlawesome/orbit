import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FAKE_TOKEN, FakeGithub, runScript } from "../test-support/fake-github.mjs";
import { PROCESS_TEST_TIMEOUT_MS } from "../process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * #1824: handoff releases pile up in the handoff repository; GitLab's
 * handoff_to_github job deletes the ones older than a limit (14 days by
 * default), and their tags, and nothing else. It runs with GITHUB_HANDOFF_TOKEN
 * against GITHUB_HANDOFF_REPO; no GitHub workflow runs it.
 */
const SCRIPT = new URL("./github-prune-handoffs.sh", import.meta.url).pathname;
const DAY = 24 * 3600 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const sha = (c) => `handoff-${c.repeat(40)}`;
const DECOY_REPOSITORY = "decoy-owner/orbit-itself";

let fake;
beforeEach(async () => {
  fake = await new FakeGithub().start();
});
afterEach(async () => {
  await fake.stop();
});

const prune = ({ extra = {}, token = FAKE_TOKEN } = {}) => {
  const env = {
    GITHUB_API_URL: fake.apiUrl,
    GITHUB_HANDOFF_REPO: fake.repository,
    // Orbit's own repository: never pruned.
    GITHUB_REPOSITORY: DECOY_REPOSITORY,
    ...extra,
  };
  if (token !== null) env.GITHUB_HANDOFF_TOKEN = token;
  for (const [key, value] of Object.entries(env)) if (value === null) delete env[key];
  return runScript(SCRIPT, env);
};

const remaining = () => fake.releases.map((r) => r.tag_name).sort();
const published = (tag, age, extra = {}) => fake.addRelease({ tag_name: tag, created_at: daysAgo(age), draft: false, ...extra });

describe("github-prune-handoffs.sh", () => {
  it("deletes old handoff releases and their tags, and keeps every other release and tag", async () => {
    published(sha("a"), 15); // old handoff: goes
    published(sha("b"), 30); // older: goes
    published(sha("c"), 13); // younger than 14 days: stays
    published(sha("d"), 0); // new: stays
    published("v1.2.3", 40); // old, other name: stays
    published(`not-${sha("f")}`, 40); // does not start handoff-: stays
    published(`${sha("9")}x`, 40); // longer than 40 hex: stays
    published(`handoff-${"a".repeat(39)}`, 40); // shorter than 40 hex: stays
    published(`handoff-${"A".repeat(40)}`, 40); // not lower-case hex: stays
    const result = await prune();
    expect(result.status, result.stderr).toBe(0);
    expect(fake.deleted.sort()).toEqual([sha("a"), sha("b")].sort());
    expect(fake.deletedTags.sort()).toEqual([sha("a"), sha("b")].sort());
    expect(remaining()).toEqual(
      [sha("c"), sha("d"), "v1.2.3", `not-${sha("f")}`, `${sha("9")}x`, `handoff-${"a".repeat(39)}`, `handoff-${"A".repeat(40)}`].sort(),
    );
    expect([...fake.tags].sort()).toEqual(remaining());
  });

  it("deletes an old leftover draft too, which has no tag, and still succeeds", async () => {
    fake.addRelease({ tag_name: sha("a"), created_at: daysAgo(20), draft: true });
    fake.addRelease({ tag_name: sha("b"), created_at: daysAgo(2), draft: true });
    published(sha("c"), 20);
    const result = await prune();
    expect(result.status, result.stderr).toBe(0);
    expect(fake.deleted.sort()).toEqual([sha("a"), sha("c")].sort());
    expect(remaining()).toEqual([sha("b")]);
  });

  it("matches the tag name, not the release title", async () => {
    published("v9.9.9", 40, { name: sha("a") });
    published(sha("b"), 40, { name: "Some title" });
    const result = await prune();
    expect(result.status, result.stderr).toBe(0);
    expect(fake.deleted).toEqual([sha("b")]);
    expect(fake.deletedTags).toEqual([sha("b")]);
  });

  it("follows ORBIT_HANDOFF_MAX_AGE_DAYS", async () => {
    published(sha("a"), 4);
    published(sha("b"), 2);
    const result = await prune({ extra: { ORBIT_HANDOFF_MAX_AGE_DAYS: "3" } });
    expect(result.status, result.stderr).toBe(0);
    expect(fake.deleted).toEqual([sha("a")]);
    expect(fake.deletedTags).toEqual([sha("a")]);
  });

  it("prunes releases past the first page of the list", async () => {
    for (let i = 0; i < 45; i += 1) published(`handoff-${String(i).padStart(40, "0")}`, 20);
    published(sha("z"), 1);
    const result = await prune();
    expect(result.status, result.stderr).toBe(0);
    expect(fake.deleted).toHaveLength(45);
    expect(fake.deletedTags).toHaveLength(45);
    expect(remaining()).toEqual([sha("z")]);
  });

  it("works only on the repository named by GITHUB_HANDOFF_REPO", async () => {
    published(sha("a"), 40);
    const result = await prune();
    expect(result.status, result.stderr).toBe(0);
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.outsideRepository()).toEqual([]);
  });

  it("does nothing, successfully, when there is nothing old enough", async () => {
    published(sha("a"), 1);
    const result = await prune();
    expect(result.status, result.stderr).toBe(0);
    expect(fake.mutations()).toEqual([]);
  });

  it("refuses an age that is not a whole number, deleting nothing", async () => {
    published(sha("a"), 40);
    for (const age of ["soon", "-1", "1.5"]) {
      const result = await prune({ extra: { ORBIT_HANDOFF_MAX_AGE_DAYS: age } });
      expect(result.status, JSON.stringify(age)).not.toBe(0);
    }
    expect(fake.mutations()).toEqual([]);
  });

  it("refuses an unset GITHUB_HANDOFF_REPO before any request, even with GITHUB_REPOSITORY set", async () => {
    published(sha("a"), 40);
    const result = await prune({ extra: { GITHUB_HANDOFF_REPO: null } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GITHUB_HANDOFF_REPO");
    expect(fake.requests).toEqual([]);
  });

  it("refuses a missing GITHUB_HANDOFF_TOKEN before any request", async () => {
    published(sha("a"), 40);
    const result = await prune({ token: null });
    expect(result.status).not.toBe(0);
    expect(fake.requests).toEqual([]);
  });

  it("does not delete what it was refused: a rejected token fails and changes nothing", async () => {
    published(sha("a"), 40);
    const result = await prune({ token: "wrong-fake-token-for-tests" });
    expect(result.status).not.toBe(0);
    expect(fake.deleted).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain("wrong-fake-token-for-tests");
  });

  it("never prints the token", async () => {
    published(sha("a"), 40);
    const result = await prune();
    expect(result.stdout + result.stderr).not.toContain(FAKE_TOKEN);
    expect(fake.requests.every((r) => r.authorized)).toBe(true);
  });
});
