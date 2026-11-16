import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1810 W-F2 (note 57316): a scan that timed out is said in its own two lines,
 * not as the held line. The server answers 503 `document_scanner_timeout`
 * (nobody is alerted for one slow scan); the lane is undrawable like the held
 * one, and never says administrators were told.
 */
const SLOW = "The scanner didn’t answer in time.";
const WHY_SLOW_WORDS = "it is still attached when you add this entry<br>orbit checks it again then";

const file = () => new File([new Uint8Array([37, 80, 68, 70])], "policy.pdf", { type: "application/pdf" });
const refusal = (code) => () => new Response(
  JSON.stringify({ error: { code, message: "scanner" } }),
  { status: 503, headers: { "content-type": "application/json" } },
);

function stubFetch(answer) {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).includes("/api/auth/session")) {
      return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "t" }), { status: 200 });
    }
    if (init?.method === "POST") return answer();
    throw new Error(`unexpected fetch: ${String(url)}`);
  }));
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("the create lane and a scanner timeout (#1810 W-F2)", () => {
  it("exports the two lines' words", async () => {
    const mod = await import("../../web/src/lib/data/document-read.js");
    expect(mod.FOCUS_SLOW).toBe(SLOW);
    expect(mod.WHY_SLOW).toBe(WHY_SLOW_WORDS);
  });

  it("a document_scanner_timeout page outcome is undrawable with the slow why", async () => {
    stubFetch(refusal("document_scanner_timeout"));
    const { readPickedDocument } = await import("../../web/src/lib/data/document-read.js");
    expect(await readPickedDocument("h1", file()).page).toEqual({ kind: "undrawable", why: WHY_SLOW_WORDS });
  });

  it("undrawnFocus(WHY_SLOW) is the slow line over its own why", async () => {
    const { undrawnFocus } = await import("../../web/src/lib/data/document-read.js");
    expect(undrawnFocus(WHY_SLOW_WORDS)).toEqual({ line: SLOW, why: WHY_SLOW_WORDS });
  });

  it("whyLines splits the slow why into two lines", async () => {
    const { whyLines } = await import("../../web/src/lib/data/document-read.js");
    expect(whyLines(WHY_SLOW_WORDS)).toHaveLength(2);
  });

  it("never says administrators were told or notified for a timeout", async () => {
    stubFetch(refusal("document_scanner_timeout"));
    const { readPickedDocument, whyLines, undrawnFocus } = await import("../../web/src/lib/data/document-read.js");
    const drawn = await readPickedDocument("h1", file()).page;
    const said = [undrawnFocus(drawn.why).line, ...whyLines(drawn.why)].join(" ");
    expect(said).not.toMatch(/notified|been told|administrators?/iu);
    expect(said).toContain("didn’t answer in time");
  });

  it("the unreachable scanner keeps the held line", async () => {
    stubFetch(refusal("document_scanner_unreachable"));
    const { readPickedDocument, FOCUS_HELD } = await import("../../web/src/lib/data/document-read.js");
    expect(await readPickedDocument("h1", file()).page).toEqual({ kind: "undrawable", why: FOCUS_HELD });
  });
});
