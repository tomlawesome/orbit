import { expect, test } from "@playwright/test";

import { APP } from "../fidelity/pocket-states.js";
import { onPhone, signedIn } from "./a11y-support.js";
import { guardedRoute } from "./workspace-writes.js";

/*
 * #1354: the archive card's behaviour as a person sees it, on the desk
 * (DeskArchive.svelte) and on the pocket (PocketArchive.svelte), so that
 * moving their shared state machine into one controller cannot change it
 * unnoticed. One test, run in rig-desktop and in rig-phone, speaks for both;
 * where the two dialects differ the test says how, and that difference is the
 * point of the pocket/desk assertions: the sign-in-again challenge is a Sheet
 * (a modal dialog) on the pocket and sits inline in the card on the desk.
 *
 * Covered here: idle; the passphrase pair (mismatch, match); the button armed
 * by one tap and fired by the second; the challenge (open, wrong proof, cancel,
 * answered); work in progress; written (the file and its download); a refused
 * write; the same for bringing one in (file chosen, looked inside, conflicts,
 * armed, challenged, brought in); a double tap sending one request. Already
 * covered elsewhere and not repeated: the desk's 4 s relax and its wrong
 * passphrase refusal, the member who is shown no card (v19-archive.spec.js),
 * the real write and bring-in on a stack (tests/e2e/v19-archive.spec.ts,
 * archive-slot.spec.ts).
 */

const HARLOW = "hh-harlow-1";
const PASSPHRASE = "correct-horse-battery-staple";
const SETTLE = 15_000;
const CHALLENGE_REFUSAL = { error: { code: "recent_authentication_required", message: "Confirm it is you before making this change" } };

test.describe.configure({ timeout: 60_000 });

/**
 * The card and the pieces of it whose place differs by dialect.
 * @param {import("@playwright/test").Page} page
 * @param {boolean} phone
 */
function cardOf(page, phone) {
  const card = phone ? page.locator('section[data-hh="archive"]') : page.locator(".c-archive");
  /* The challenge: the pocket's Sheet, a modal dialog; the desk's, inline in the card. */
  const challenge = phone ? page.getByRole("dialog", { name: /Confirm it.s you/ }) : card.locator(".challenge");
  return {
    card,
    challenge,
    proof: challenge.getByLabel("your password"),
    confirm: challenge.getByRole("button", { name: "confirm and carry on" }),
    cancelChallenge: challenge.getByRole("button", { name: phone ? "close" : "cancel" }),
    /* The act button: the pocket holds both of its labels in one button. */
    act: (/** @type {RegExp} */ name) => card.getByRole("button", { name }).first(),
  };
}

/**
 * The button's armed mark ("tap again to ..."): the desk swaps its label; the
 * pocket keeps both labels in the button and shows the one the armed state
 * makes readable (its other is aria-hidden).
 * @param {ReturnType<typeof cardOf>} c @param {boolean} phone @param {RegExp} words
 */
const armedMark = (c, phone, words) => (phone ? c.card.locator('.set[aria-hidden="false"]') : c.card.getByText(words)).first();

/**
 * Stands in for the engine's archive routes in this page, and records what the
 * card sent. The write and the import answer the first request, which carries
 * no proof, with the engine's "confirm it is you" 403, as the real routes do.
 * @param {import("@playwright/test").Page} page
 * @param {{ write?: (proofGiven: boolean, count: number) => Promise<{ status: number, json: unknown }>, bringIn?: (proofGiven: boolean, count: number) => Promise<{ status: number, json: unknown }> }} [answers]
 */
async function archiveRoutes(page, answers = {}) {
  /** @type {{ proof: boolean }[]} */
  const writes = [];
  /** @type {{ proof: boolean }[]} */
  const imports = [];
  /** @type {string[]} */
  const previews = [];
  await page.route(`${APP}/api/households/${HARLOW}/portable-archives`, guardedRoute(async (route) => {
    const proof = Boolean(route.request().postDataJSON().currentPassword);
    writes.push({ proof });
    const answer = answers.write
      ? await answers.write(proof, writes.length)
      : proof
        ? { status: 200, json: { archive: { id: "abc-123", expiresAt: "2026-12-01T00:00:00Z", includesDocuments: true, downloadUrl: "/api/portable-archives/abc-123" } } }
        : { status: 403, json: CHALLENGE_REFUSAL };
    await route.fulfill(answer);
  }));
  await page.route(`${APP}/api/portable-archives/preview`, guardedRoute(async (route) => {
    previews.push(route.request().method());
    await route.fulfill({ json: { preview: { householdName: "Source Home", sections: 2, items: 3, documents: 1, conflicts: [{ id: "i1", title: "Boiler service" }], documentsExcluded: false } } });
  }));
  await page.route(`${APP}/api/portable-archives/import`, guardedRoute(async (route) => {
    /* multipart: the proof is a field of the form, so look for its name in the body. */
    const proof = (route.request().postData() ?? "").includes('name="currentPassword"');
    imports.push({ proof });
    const answer = answers.bringIn
      ? await answers.bringIn(proof, imports.length)
      : proof
        ? { status: 200, json: { importedItems: 2, documentsExcluded: 0 } }
        : { status: 403, json: CHALLENGE_REFUSAL };
    await route.fulfill(answer);
  }));
  return { writes, imports, previews };
}

/** @param {import("@playwright/test").Page} page @param {boolean} phone */
async function openExportForm(page, phone) {
  const { card } = cardOf(page, phone);
  await signedIn(`/household/${HARLOW}`, "any-dialect")(page);
  await expect(card).toBeVisible({ timeout: SETTLE });
  /* Idle: the manifest of what the file would hold, and the one way in. */
  await expect(card.getByText("never in the file")).toBeVisible();
  await card.getByRole("button", { name: phone ? "export this system" : "write an archive →" }).click();
  return cardOf(page, phone);
}

/** The two passphrase fields, filled alike. @param {ReturnType<typeof cardOf>} c */
async function typePassphrases(c) {
  await c.card.getByLabel("a passphrase for the file").fill(PASSPHRASE);
  await c.card.getByLabel("the passphrase again").fill(PASSPHRASE);
}

/** Arms the write button and fires it with the second tap. @param {ReturnType<typeof cardOf>} c */
async function armAndFire(c) {
  const act = c.act(/write the archive/);
  await act.click(); // arm
  await act.click(); // fire
}

test("the passphrase pair is checked before the write button wakes", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await archiveRoutes(page);
  const c = await openExportForm(page, phone);
  await expect(c.act(/write the archive/)).toBeDisabled();
  await c.card.getByLabel("a passphrase for the file").fill(PASSPHRASE);
  await c.card.getByLabel("the passphrase again").fill("a-different-phrase-entirely");
  await expect(c.card.getByText("the two passphrases are not the same yet")).toBeVisible();
  await expect(c.act(/write the archive/)).toBeDisabled();
  await c.card.getByLabel("the passphrase again").fill(PASSPHRASE);
  await expect(c.card.getByText("the two passphrases are not the same yet")).toHaveCount(0);
  await expect(c.act(/write the archive/)).toBeEnabled();
  /* A passphrase under the engine's floor is refused in the engine's words. */
  await c.card.getByLabel("a passphrase for the file").fill("short");
  await c.card.getByLabel("the passphrase again").fill("short");
  await expect(c.card.getByText(/at least \d+ characters/)).toBeVisible();
  await expect(c.act(/write the archive/)).toBeDisabled();
});

test("writing an archive: tap, tap again, confirm it is you, work in progress, written", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => { release = () => resolve(undefined); });
  const seen = await archiveRoutes(page, {
    write: async (proof) => {
      if (!proof) return { status: 403, json: CHALLENGE_REFUSAL };
      await held;
      return { status: 200, json: { archive: { id: "abc-123", expiresAt: "2026-12-01T00:00:00Z", includesDocuments: true, downloadUrl: "/api/portable-archives/abc-123" } } };
    },
  });
  const c = await openExportForm(page, phone);
  await typePassphrases(c);
  await expect(c.challenge).toHaveCount(0);

  await c.act(/write the archive/).click(); // arm: nothing is sent yet
  await expect(armedMark(c, phone, /^tap again to write the archive/)).toBeVisible();
  expect(seen.writes).toEqual([]);
  await c.act(/write the archive/).click(); // fire

  /* The engine asks for a fresh proof: a Sheet on the pocket, inline on the desk. */
  await expect(c.challenge).toBeVisible({ timeout: SETTLE });
  await expect(c.challenge).toContainText("asks you to sign in again first");
  if (phone) {
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(c.challenge).toHaveAttribute("aria-modal", "true");
  } else {
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(c.card.locator(".challenge")).toBeVisible();
  }
  expect(seen.writes).toEqual([{ proof: false }]);
  await expect(c.confirm).toBeDisabled(); // nothing typed yet

  await c.proof.fill("my-account-password");
  await expect(c.confirm).toBeEnabled();
  await c.confirm.click();
  /* In progress while the engine writes: the button says so and cannot be pressed again. */
  await expect(c.challenge.getByRole("button", { name: "confirming…" })).toBeDisabled({ timeout: SETTLE });
  expect(seen.writes).toEqual([{ proof: false }, { proof: true }]);
  release();

  /* Written: the file's name, when it keeps until, and the way to fetch it; the challenge is gone. */
  await expect(c.card.getByText(/orbit-export-abc-123\.orbit/)).toBeVisible({ timeout: SETTLE });
  await expect(c.card.getByText(/ready until/)).toBeVisible();
  await expect(c.card.getByText(/Orbit keeps your last 2/)).toBeVisible();
  await expect(c.card.getByRole("link", { name: phone ? "download" : "download the file" })).toHaveAttribute("href", /\/api\/portable-archives\/abc-123/);
  await expect(c.challenge).toHaveCount(0);
  expect(seen.writes).toHaveLength(2);
});

test("a wrong password is refused in the card's words, the challenge stays, and the right one goes through", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  const seen = await archiveRoutes(page, {
    write: async (proof, count) => (count < 3
      ? { status: 403, json: CHALLENGE_REFUSAL }
      : { status: 200, json: { archive: { id: "abc-123", expiresAt: "2026-12-01T00:00:00Z", includesDocuments: true, downloadUrl: "/api/portable-archives/abc-123" } } }),
  });
  const c = await openExportForm(page, phone);
  await typePassphrases(c);
  await armAndFire(c);
  await expect(c.challenge).toBeVisible({ timeout: SETTLE });
  await c.proof.fill("not-my-password");
  await c.confirm.click();
  await expect(c.challenge).toContainText("that password did not match · try again", { timeout: SETTLE });
  await expect(c.challenge).toBeVisible();
  await expect(c.card.getByText(/orbit-export-/)).toHaveCount(0);

  await c.proof.fill("my-account-password");
  await c.confirm.click();
  await expect(c.card.getByText(/orbit-export-abc-123\.orbit/)).toBeVisible({ timeout: SETTLE });
  await expect(c.challenge).toHaveCount(0);
  expect(seen.writes).toEqual([{ proof: false }, { proof: true }, { proof: true }]);
});

test("leaving the challenge writes nothing and keeps the passphrases, ready to start again", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  const seen = await archiveRoutes(page);
  const c = await openExportForm(page, phone);
  await typePassphrases(c);
  await armAndFire(c);
  await expect(c.challenge).toBeVisible({ timeout: SETTLE });
  await c.cancelChallenge.click();
  await expect(c.challenge).toHaveCount(0, { timeout: SETTLE });
  await expect(c.card.getByLabel("a passphrase for the file")).toHaveValue(PASSPHRASE);
  await expect(c.card.getByLabel("the passphrase again")).toHaveValue(PASSPHRASE);
  await expect(c.act(/write the archive/)).toBeEnabled();
  await expect(c.card.getByText(/orbit-export-/)).toHaveCount(0);
  expect(seen.writes).toEqual([{ proof: false }]);

  /* The button needs arming afresh: one tap sends nothing. */
  await c.act(/write the archive/).click();
  await expect(c.challenge).toHaveCount(0);
  expect(seen.writes).toHaveLength(1);
  await c.act(/write the archive/).click();
  await expect(c.challenge).toBeVisible({ timeout: SETTLE });
  expect(seen.writes).toHaveLength(2);
});

test("a write the engine refuses says why, in its words, and writes no file", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  const seen = await archiveRoutes(page, {
    write: async () => ({ status: 500, json: { error: { code: "archive_failed", message: "The archive could not be written" } } }),
  });
  const c = await openExportForm(page, phone);
  await typePassphrases(c);
  await armAndFire(c);
  await expect(c.card.getByText("The archive could not be written")).toBeVisible({ timeout: SETTLE });
  await expect(c.card.getByText(/orbit-export-/)).toHaveCount(0);
  expect(seen.writes).toEqual([{ proof: false }]);
  /* Still the form, with what was typed. */
  await expect(c.card.getByLabel("a passphrase for the file")).toHaveValue(PASSPHRASE);
});

test("a quick double tap sends one write, and confirming twice answers one", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  /** @type {() => void} */
  let releaseFirst = () => {};
  const firstHeld = new Promise((resolve) => { releaseFirst = () => resolve(undefined); });
  /** @type {() => void} */
  let releaseProof = () => {};
  const proofHeld = new Promise((resolve) => { releaseProof = () => resolve(undefined); });
  const seen = await archiveRoutes(page, {
    write: async (proof) => {
      if (!proof) {
        await firstHeld;
        return { status: 403, json: CHALLENGE_REFUSAL };
      }
      await proofHeld;
      return { status: 200, json: { archive: { id: "abc-123", expiresAt: "2026-12-01T00:00:00Z", includesDocuments: true, downloadUrl: "/api/portable-archives/abc-123" } } };
    },
  });
  const c = await openExportForm(page, phone);
  await typePassphrases(c);

  /* Two taps in the same instant: the first arms, the second fires. */
  await c.act(/write the archive/).evaluate((button) => { for (let tap = 0; tap < 2; tap += 1) /** @type {HTMLElement} */ (button).click(); });
  await expect.poll(() => seen.writes.length, { timeout: SETTLE }).toBe(1);
  await page.waitForTimeout(500);
  expect(seen.writes).toEqual([{ proof: false }]);
  releaseFirst();
  await expect(c.challenge).toBeVisible({ timeout: SETTLE });

  await c.proof.fill("my-account-password");
  await c.confirm.evaluate((button) => { for (let tap = 0; tap < 2; tap += 1) /** @type {HTMLElement} */ (button).click(); });
  await expect.poll(() => seen.writes.length, { timeout: SETTLE }).toBe(2);
  await page.waitForTimeout(500);
  expect(seen.writes).toEqual([{ proof: false }, { proof: true }]);
  releaseProof();
  await expect(c.card.getByText(/orbit-export-abc-123\.orbit/)).toBeVisible({ timeout: SETTLE });
  expect(seen.writes).toHaveLength(2);
});

test("an armed button relaxes back after 4 s without a second tap, on the pocket too (#1342)", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await page.clock.install();
  const seen = await archiveRoutes(page);
  const c = await openExportForm(page, phone);
  await typePassphrases(c);
  const armed = armedMark(c, phone, /^tap again to write the archive/);
  await page.clock.pauseAt(new Date(Date.now() + 2_000));
  await c.act(/write the archive/).click(); // arm
  await expect(armed).toBeVisible({ timeout: SETTLE });
  await page.clock.runFor(3_900);
  await expect(armed).toBeVisible();
  await page.clock.runFor(200);
  await expect(armed).toHaveCount(0, { timeout: SETTLE });
  /* Relaxed means a tap now only arms again: nothing is sent. */
  await c.act(/write the archive/).click();
  await expect(armed).toBeVisible({ timeout: SETTLE });
  expect(seen.writes).toEqual([]);
  await expect(c.challenge).toHaveCount(0);
});

test("the passphrase step can be walked away from on the desk (cancel)", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the pocket form has no cancel; it is left by opening another tab");
  await archiveRoutes(page);
  const c = await openExportForm(page, false);
  await typePassphrases(c);
  await c.card.getByRole("button", { name: "cancel" }).click();
  await expect(c.card.getByLabel("a passphrase for the file")).toHaveCount(0);
  await expect(c.card.getByRole("button", { name: "write an archive →" })).toBeVisible();
});

/** The file `setInputFiles` chooses. @param {Buffer} [buffer] */
const archiveFile = (buffer = Buffer.from("{}")) => ({ name: "orbit-archive.json", mimeType: "application/json", buffer });

/** @param {import("@playwright/test").Page} page @param {boolean} phone */
async function openBringIn(page, phone) {
  const c = cardOf(page, phone);
  await signedIn(`/household/${HARLOW}`, "any-dialect")(page);
  await expect(c.card).toBeVisible({ timeout: SETTLE });
  await c.card.getByRole("tab", { name: "bring one in" }).click();
  if (!phone) await c.card.getByRole("button", { name: "bring in an archive →" }).click();
  return c;
}

test("bringing one in: choose the file, look inside, see what stays out, tap twice, confirm, brought in", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  const seen = await archiveRoutes(page);
  const c = await openBringIn(page, phone);
  const lookInside = c.card.getByRole("button", { name: "look inside" });

  await c.card.locator('input[type="file"]').setInputFiles(archiveFile());
  await expect(c.card.getByText("orbit-archive.json", { exact: true }).first()).toBeVisible();
  await expect(lookInside).toBeDisabled(); // no passphrase yet
  await c.card.getByLabel("the file's passphrase").fill(PASSPHRASE);
  await expect(lookInside).toBeEnabled();
  expect(seen.previews).toEqual([]);
  await lookInside.click();

  /* The preview: what it holds, and the entry already here that stays out. */
  await expect(c.card.getByText("Source Home")).toBeVisible({ timeout: SETTLE });
  await expect(c.card.getByText("Boiler service")).toBeVisible();
  await expect(c.card.getByText("already here · stays out")).toBeVisible();
  expect(seen.previews).toEqual(["POST"]);
  expect(seen.imports).toEqual([]);

  /* The pocket's armed button is named by its other label, so the name allows both. */
  const bring = c.card.getByRole("button", { name: /bring in 2 entries|^tap again/ }).first();
  await bring.click(); // arm
  await expect(armedMark(c, phone, /^tap again to bring in 2 entries/)).toBeVisible();
  expect(seen.imports).toEqual([]);
  await bring.click(); // fire
  await expect(c.challenge).toBeVisible({ timeout: SETTLE });
  await expect(page.getByRole("dialog")).toHaveCount(phone ? 1 : 0);
  await c.proof.fill("my-account-password");
  await c.confirm.click();
  await expect(c.card.getByText("brought in 2 entries from Source Home")).toBeVisible({ timeout: SETTLE });
  await expect(c.challenge).toHaveCount(0);
  expect(seen.imports).toEqual([{ proof: false }, { proof: true }]);
});

test("bringing one in: a refused file says so and can be swapped; an empty file is refused before it is sent", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  const seen = await archiveRoutes(page);
  const c = await openBringIn(page, phone);
  const input = c.card.locator('input[type="file"]');
  await input.setInputFiles(archiveFile(Buffer.alloc(0)));
  await expect(c.card.getByText("this file is empty")).toBeVisible({ timeout: SETTLE });
  await expect(c.card.getByRole("button", { name: "look inside" })).toHaveCount(0);
  expect(seen.previews).toEqual([]);

  /* Choosing a usable file after it carries on to the passphrase step. */
  await input.setInputFiles(archiveFile());
  await expect(c.card.getByText("this file is empty")).toHaveCount(0);
  await expect(c.card.getByLabel("the file's passphrase")).toBeVisible();
});

test("bringing one in: another file takes the person back to choose, and a wrong passphrase on the pocket is refused in the server's words", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await archiveRoutes(page);
  const c = await openBringIn(page, phone);
  await page.route(`${APP}/api/portable-archives/preview`, guardedRoute(async (route) => {
    await route.fulfill({ status: 422, json: { error: { code: "archive_passphrase_invalid", message: "The passphrase or archive is invalid" } } });
  }));
  await c.card.locator('input[type="file"]').setInputFiles(archiveFile());
  await c.card.getByLabel("the file's passphrase").fill("not-the-right-phrase-at-all");
  await c.card.getByRole("button", { name: "look inside" }).click();
  await expect(c.card.getByText("The passphrase or archive is invalid")).toBeVisible({ timeout: SETTLE });
  await expect(c.card.getByText("Source Home")).toHaveCount(0);
  /* Still on the file step, so the person can fix the phrase or swap the file. */
  await expect(c.card.getByLabel("the file's passphrase")).toBeVisible();
  await c.card.getByRole("button", { name: phone ? /another file|choose another/ : "another file" }).first().click();
  await expect(c.card.getByLabel("the file's passphrase")).toHaveCount(0);
});

test("bringing one in: a quick double tap sends one request, and confirming twice answers one", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => { release = () => resolve(undefined); });
  const seen = await archiveRoutes(page, {
    bringIn: async (proof) => {
      if (!proof) return { status: 403, json: CHALLENGE_REFUSAL };
      await held;
      return { status: 200, json: { importedItems: 2, documentsExcluded: 0 } };
    },
  });
  const c = await openBringIn(page, phone);
  await c.card.locator('input[type="file"]').setInputFiles(archiveFile());
  await c.card.getByLabel("the file's passphrase").fill(PASSPHRASE);
  await c.card.getByRole("button", { name: "look inside" }).click();
  const bring = c.card.getByRole("button", { name: /bring in 2 entries|^tap again/ }).first();
  await expect(bring).toBeVisible({ timeout: SETTLE });
  await bring.evaluate((button) => { for (let tap = 0; tap < 2; tap += 1) /** @type {HTMLElement} */ (button).click(); });
  await expect(c.challenge).toBeVisible({ timeout: SETTLE });
  await page.waitForTimeout(500);
  expect(seen.imports).toEqual([{ proof: false }]);

  await c.proof.fill("my-account-password");
  await c.confirm.evaluate((button) => { for (let tap = 0; tap < 2; tap += 1) /** @type {HTMLElement} */ (button).click(); });
  await expect.poll(() => seen.imports.length, { timeout: SETTLE }).toBe(2);
  await page.waitForTimeout(500);
  expect(seen.imports).toEqual([{ proof: false }, { proof: true }]);
  release();
  await expect(c.card.getByText("brought in 2 entries from Source Home")).toBeVisible({ timeout: SETTLE });
  expect(seen.imports).toHaveLength(2);
});
