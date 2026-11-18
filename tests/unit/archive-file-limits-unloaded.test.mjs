// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";

/*
 * #1605 b1 O-R9: archiveFileProblem(file, null) answered null, so a file picked
 * before the engine's limits had loaded skipped the size check and went on to
 * be read. Ruled (2026-11-17): refuse until the limits have loaded, as
 * passphraseProblem does ("reload the page"), one fail-closed rule on both gates.
 */
const ws = vi.hoisted(() => ({
  previewPortableArchive: vi.fn(),
  importPortableArchive: vi.fn(),
  readSignInMethods: vi.fn(),
  startStepUp: vi.fn(),
  writePortableArchive: vi.fn(),
  wordsOf: (/** @type {unknown} */ _error, fallback = "Something went wrong.") => fallback,
}));
vi.mock("$lib/data/workspace.js", () => ws);

const { archiveFileProblem } = await import("../../web/src/routes/household/[id]/archive.js");
const page = createPageLoader("archive-file-limits-unloaded");

beforeEach(() => {
  for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset();
});
afterEach(() => page.unmount());
afterAll(() => page.teardown());

/** @param {HTMLElement} target @param {string} text */
const buttonWith = (target, text) => /** @type {HTMLButtonElement | undefined} */ ([...target.querySelectorAll("button")].find((b) => b.textContent?.includes(text)));

describe("a chosen archive file while the engine's limits are unknown (#1605 O-R9)", () => {
  it("is refused with the words to reload the page, whatever its size", () => {
    expect(archiveFileProblem({ size: 2048 }, null)).toMatch(/reload/);
    expect(archiveFileProblem({ size: 2048 }, undefined)).toMatch(/reload/);
  });

  it("an empty file is still called empty", () => {
    expect(archiveFileProblem({ size: 0 }, null)).toMatch(/empty/);
  });

  it("the desk card keeps the file from being looked inside and says to reload", async () => {
    const { target, flushSync } = await page.mount("routes/household/[id]/DeskArchive.svelte", {
      householdId: "h1", householdName: "Home", entries: 2, sections: 1, limits: null,
    });
    buttonWith(target, "bring one in")?.click();
    flushSync();
    const input = /** @type {HTMLInputElement} */ (target.querySelector('input[type="file"]'));
    const file = new File(["{}"], "home.orbit", { type: "application/octet-stream" });
    Object.defineProperty(input, "files", { configurable: true, get: () => [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    await settle();

    expect(target.querySelector(".refuse")?.textContent ?? "").toMatch(/reload/);
    expect(buttonWith(target, "look inside")).toBeUndefined();
    expect(ws.previewPortableArchive).not.toHaveBeenCalled();
  });
});
