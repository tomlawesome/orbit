// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";
import { WORKSPACE_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";
import { createPageLoader, runtime } from "../support/svelte-page.mjs";

/*
 * #1433 D20, owner ruling on where the figures go: the kept page previews'
 * size and the documents not yet drawn are two rows in the DOCUMENT JOBS card
 * (not the upload-limit card), on the desk and on the pocket.
 *
 *   desk    two .kv rows after the jobs list, before the footnote "the 25 most
 *           recently touched jobs are kept"
 *   pocket  two Row items after the jobs list, before the card's problem line
 *
 *   "page previews kept"  the size in megabytes ("0 MB" at zero)
 *   "not yet drawn"       "1 document" / "N documents", "none" at zero
 *
 * Neither row is shown when the API sends no preview figures.
 */

vi.mock("$lib/backdrops/station.js", () => ({ mountStation: () => () => {} }));

const PAGE = "routes/administration/+page.svelte";
const MiB = 1_048_576;

const loader = createPageLoader("administration-previews-1433", {
  stub: (file) => /\/lib\/Chrome\.svelte$/.test(file),
});
beforeAll(() => loader.setup(PAGE));
afterAll(() => loader.teardown());
afterEach(() => {
  loader.unmount();
  vi.unstubAllGlobals();
});

/** @param {{ previewBytes?: number, previewsPending?: number } | undefined} figures  what the health API sends beside `metadata` */
async function mount(figures, pocket) {
  const api = fixtureApi({
    "GET /api/workspace": () => {
      const workspace = structuredClone(WORKSPACE_FIXTURE);
      for (const household of workspace.households) /** @type {any} */ (household).today = "2026-10-03";
      return { workspace };
    },
    "GET /api/admin/operations": () => ({ operations: { documentJobs: [], documentJobCounts: {}, mailProbes: { mailbox: null, relay: null } } }),
    "GET /api/admin/documents/health": () => ({ health: { ...figures } }),
  });
  vi.stubGlobal("fetch", api.fetch);
  vi.stubGlobal("matchMedia", (/** @type {string} */ query) => ({
    matches: pocket, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  await loader.mount(PAGE, { data: { fixtures: false } }, { url: "http://localhost/administration" });
  const { flushSync } = await runtime();
  for (let turn = 0; turn < 10; turn += 1) { await new Promise((done) => setTimeout(done, 0)); flushSync(); }
}

const clean = (/** @type {string | null} */ text) => (text ?? "").replace(/\s+/gu, " ").trim();

/** The text of every leaf element under `root`, in document order. */
function leaves(/** @type {Element} */ root) {
  return [...root.querySelectorAll("*")]
    .filter((element) => element.children.length === 0 && clean(element.textContent) !== "")
    .map((element) => clean(element.textContent));
}

/** The words of the Document jobs card, in order, for either dialect. */
function jobsCard(/** @type {boolean} */ pocket) {
  const card = document.querySelector(pocket ? "#ad-documents" : "#jobs-card");
  expect(card, "the Document jobs card").not.toBeNull();
  return /** @type {Element} */ (card);
}

describe.each([["desk", false], ["pocket", true]])("the administration page previews rows on the %s", (_name, pocket) => {
  it("shows the size and the count in the Document jobs card, after the jobs list", async () => {
    await mount({ previewBytes: 5 * MiB, previewsPending: 3 }, pocket);
    const words = leaves(jobsCard(pocket));
    const kept = words.indexOf("page previews kept");
    const waiting = words.indexOf("not yet drawn");
    expect(kept, `"page previews kept" among ${JSON.stringify(words)}`).toBeGreaterThan(-1);
    expect(waiting, `"not yet drawn" among ${JSON.stringify(words)}`).toBeGreaterThan(-1);
    // Each label sits beside its value.
    expect(words.slice(Math.max(0, kept - 1), kept + 2)).toContain("5 MB");
    expect(words.slice(Math.max(0, waiting - 1), waiting + 2)).toContain("3 documents");
    // After the (empty) jobs list...
    expect(Math.min(kept, waiting)).toBeGreaterThan(words.indexOf("no document jobs yet"));
    // ...and, on the desk, before the footnote.
    if (!pocket) expect(Math.max(kept, waiting)).toBeLessThan(words.findIndex((word) => /^the 25 most recently touched jobs/u.test(word)));
  });

  it("is not in the upload-limit card", async () => {
    await mount({ previewBytes: 5 * MiB, previewsPending: 3 }, pocket);
    const upload = document.querySelector(pocket ? "[data-ad='upload-limit'], #ad-upload-limit" : "#upload-limit-card");
    if (upload) expect(clean(upload.textContent)).not.toMatch(/page previews|not yet drawn/u);
    expect(document.body.textContent).not.toContain("previews waiting");
  });

  it("says one document in the singular", async () => {
    await mount({ previewBytes: 2 * MiB, previewsPending: 1 }, pocket);
    expect(leaves(jobsCard(pocket))).toContain("1 document");
  });

  it("says 0 MB and none at zero", async () => {
    await mount({ previewBytes: 0, previewsPending: 0 }, pocket);
    const words = leaves(jobsCard(pocket));
    expect(words).toContain("0 MB");
    expect(words).toContain("none");
  });

  it("shows neither row when the API sends no preview figures", async () => {
    await mount({}, pocket);
    const text = clean(document.body.textContent);
    expect(text).not.toContain("page previews kept");
    expect(text).not.toContain("not yet drawn");
  });
});
