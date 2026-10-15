import { expect, test, type Page } from "@playwright/test";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { exclusiveSpecFile } from "./support/exclusive-spec";
import { sessionHeaders } from "./support/households";
import { ensureLocalPassword } from "./support/local-credentials";
import { cleanup, READER, seedHousehold, signIn } from "./support/signed-in";
import { workerFixturePassword } from "./support/worker-identity";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/* #1316: one worker at a time in the archive-slot specs, in whichever project. */
exclusiveSpecFile("archive-slot");

/**
 * #1316 (DATA3): the instance handles one archive preview, import or export at
 * a time. While another signed-in request is in the middle of an archive
 * upload, a second one is refused at once with a 429 `archive_busy` and a
 * Retry-After of 60 seconds, before the server reads a byte of it. The archive
 * screen says so in plain words and keeps the chosen file and the passphrase,
 * so the person only taps "look inside" again; once the first request has
 * ended (here: the client goes away) the same tap works and the archive comes
 * in.
 *
 * The first request is held by this test, not the browser: a signed-in Node
 * `fetch` to the preview route whose body never finishes (a chunk every five
 * seconds, so the stalled-upload watchdog does not cut it off). Nothing
 * waits on a clock: the second request is polled until it answers 429, and
 * after the abort until it stops.
 *
 * Runs on both layouts (desktop-chromium and mobile-chromium): the refusal is
 * a message on the archive card, and the pocket has its own dialect of it.
 */

/* One archive request is held at a time, so the specs in this file take turns (#1316). */
test.describe.configure({ mode: "serial" });

/** Large enough that a server which stops reading cannot hide it in socket buffers. */
const LARGE_BODY_BYTES = 25_000_000;

const PASSPHRASE = "correct-horse-battery-staple";
const PREVIEW_PATH = "/api/portable-archives/preview";
const BUSY_SENTENCE = "Orbit\u2019s processing another request right now, please try again in a few minutes.";
/** Browsers that must receive a refusal for a large body they are still sending. */
const LARGE_BODY_PROJECTS = ["desktop-firefox", "desktop-chromium"];

/**
 * The holder must still be uploading when a probe is answered; if it has
 * already settled, the slot is not held by it and a 429 (or the lack of one)
 * would prove nothing.
 */
function failIfHolderSettled(holder: ReturnType<typeof holdPreviewOpen>) {
  const outcome = holder.outcome();
  if (outcome === null) return;
  throw new Error("status" in outcome ? `the holder lost the slot: HTTP ${outcome.status}` : `the holder lost the slot: ${outcome.error}`);
}

/** The archive card of whichever layout this project draws: the desk card, or the pocket's. */
const archiveCard = (page: Page, isMobile: boolean) =>
  isMobile ? page.locator('section[data-hh="archive"]') : page.locator(".c-archive");

/** Where the refusal appears: the desk card's `.refuse`, the pocket's `.p-error` alert. */
const refusalIn = (page: Page, isMobile: boolean) =>
  isMobile ? archiveCard(page, true).locator('.p-error[role="alert"]') : archiveCard(page, false).locator(".refuse");

/** The cookies this browser context is holding, as a Cookie header Node's fetch can send. */
async function cookieHeader(page: Page): Promise<string> {
  const cookies = await page.context().cookies(new URL(page.url()).origin);
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/**
 * A signed-in POST that is still uploading: the headers and a first chunk go
 * out at once, then one more chunk every five seconds until aborted. Returns
 * the way to end it, `inFlight` (settles once the first chunk has been taken
 * up for sending, or the request has already failed) and `outcome()`: null
 * while the request is in flight, else `{ status }` if the server answered or
 * `{ error }` if it died.
 */
function holdPreviewOpen(origin: string, headers: Record<string, string>) {
  const controller = new AbortController();
  let outcome: { status: number } | { error: string } | null = null;
  let taken = () => {};
  const firstChunkTaken = new Promise<void>((resolve) => { taken = resolve; });
  let timer: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(encoder.encode("{"));
      timer = setInterval(() => {
        try { stream.enqueue(encoder.encode(" ")); } catch { clearInterval(timer); }
      }, 5_000);
    },
    pull() { taken(); },
    cancel() { clearInterval(timer); },
  });
  const settled = fetch(`${origin}${PREVIEW_PATH}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body,
    /* Node's fetch needs `duplex` for a streamed request body. */
    duplex: "half",
    signal: controller.signal,
  } as RequestInit & { duplex: "half" }).then(
    (response) => { outcome = { status: response.status }; },
    (error) => { outcome = { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }; },
  );
  return {
    inFlight: Promise.race([firstChunkTaken, settled]).then(() => undefined),
    outcome: () => outcome,
    async end() {
      controller.abort();
      clearInterval(timer);
      await settled;
    },
  };
}

test("while one archive upload is in progress a second is refused at once, and goes through after it ends", async ({ page, isMobile }) => {
  test.setTimeout(270_000);
  await signIn(page, "/home");
  const source = await seedHousehold(page, "archive-slot-source", { withItem: true });
  const target = await seedHousehold(page, "archive-slot-target");
  /* Writing and bringing in an archive both ask the reader to prove it is them. */
  await ensureLocalPassword(page, READER(), workerFixturePassword(READER()));
  await page.goto("/home");

  let holder: ReturnType<typeof holdPreviewOpen> | undefined;
  try {
    // ── an archive to bring in: written through the export route, once, before anything is held ──
    const written = await page.request.post(`/api/households/${source.id}/portable-archives`, {
      headers: await sessionHeaders(page),
      data: { passphrase: PASSPHRASE, includeDocuments: true, currentPassword: workerFixturePassword(READER()) },
    });
    expect(written.ok(), `the archive was not written (HTTP ${written.status()}): ${await written.text()}`).toBe(true);
    const { archive } = (await written.json()) as { archive: { downloadUrl: string } };
    const downloaded = await page.request.get(archive.downloadUrl);
    expect(downloaded.ok()).toBe(true);
    const file = { name: "orbit-archive.json", mimeType: "application/json", buffer: await downloaded.body() };

    // ── the screen, with the file chosen and its passphrase typed ──
    await page.goto(`/household/${target.id}`);
    const card = archiveCard(page, isMobile);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("tab", { name: "bring one in" }).click();
    if (!isMobile) await card.getByRole("button", { name: "bring in an archive →" }).click();
    await card.locator('input[type="file"]').setInputFiles(file);
    await card.getByLabel("the file's passphrase").fill(PASSPHRASE);
    await expect(card.getByRole("button", { name: "look inside" })).toBeEnabled();

    // ── another signed-in request takes the slot and does not finish ──
    const origin = new URL(page.url()).origin;
    const headers = { ...(await sessionHeaders(page)), cookie: await cookieHeader(page) };
    const held = holdPreviewOpen(origin, headers);
    holder = held;
    await held.inFlight;

    const probe = async () => {
      const response = await fetch(`${origin}${PREVIEW_PATH}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      });
      return response;
    };
    await expect.poll(async () => {
      const status = (await probe()).status;
      failIfHolderSettled(held);
      return status;
    }, {
      message: "the second archive request is refused with 429 while the first is in progress",
      timeout: 30_000,
      intervals: [250, 500, 1_000],
    }).toBe(429);
    const refused = await probe();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("archive_busy");

    // ── the screen says so, and keeps the file ──
    await card.getByRole("button", { name: "look inside" }).click();
    const refusal = refusalIn(page, isMobile);
    await expect(refusal).toBeVisible({ timeout: 15_000 });
    /* The owner's sentence, word for word (the desk card puts a prefix before it). */
    await expect(refusal).toContainText(BUSY_SENTENCE);
    await expect(refusal).not.toContainText("The passphrase or archive is invalid");
    await expect(card.locator(".inside, .hh-preview")).toHaveCount(0);
    // Still on the "file chosen" step: the file's name, its passphrase and the button to try again.
    await expect(card.getByText("orbit-archive.json").first()).toBeVisible();
    await expect(card.getByLabel("the file's passphrase")).toHaveValue(PASSPHRASE);
    await expect(card.getByRole("button", { name: "look inside" })).toBeEnabled();

    // ── the first request ends; the slot comes free ──
    await holder.end();
    holder = undefined;
    await expect.poll(async () => (await probe()).status, {
      message: "the archive request is no longer refused once the first has ended",
      timeout: 60_000,
      intervals: [250, 500, 1_000, 2_000],
    }).not.toBe(429);

    // ── the same tap now works, and the archive comes in ──
    await card.getByRole("button", { name: "look inside" }).click();
    const preview = card.locator(".inside, .hh-preview");
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(refusalIn(page, isMobile)).toHaveCount(0);

    await card.getByRole("button", { name: "bring in 1 entry" }).click(); // arm
    await card.getByRole("button", { name: /^tap again/ }).click(); // fire

    /* A fresh sign-in challenge: the export's proof cannot pay for an import. */
    const answered = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/portable-archives/import" && response.status() !== 403,
      { timeout: 60_000 },
    );
    const proof = isMobile ? page.locator("#hh-proof") : card.locator(".challenge").getByLabel("your password");
    await proof.fill(workerFixturePassword(READER()));
    await (isMobile ? page : card.locator(".challenge")).getByRole("button", { name: "confirm and carry on" }).click();
    expect((await answered).ok()).toBe(true);

    await expect(card.getByText(`brought in 1 entry from ${source.name}`)).toBeVisible({ timeout: 30_000 });
  } finally {
    await holder?.end();
    await cleanup(page, source);
    await cleanup(page, target);
  }
});

/**
 * From inside the page, POST `size` bytes of text to `path` with the session's
 * CSRF token, and report how the browser's own fetch settled within 15 s: the
 * status, the refusal code and Retry-After, or the network error it died with.
 */
async function largePostFromPage(page: Page, path: string, size: number, csrfOverride?: string) {
  const { "X-CSRF-Token": sessionToken } = await sessionHeaders(page);
  const csrfToken = csrfOverride ?? sessionToken;
  return await page.evaluate(async ({ path, size, csrfToken }) => {
    try {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: "x".repeat(size),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      return { status: response.status, code: body?.error?.code ?? null, retryAfter: response.headers.get("retry-after"), failure: null as string | null };
    } catch (error) {
      return { status: 0, code: null, retryAfter: null, failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  }, { path, size, csrfToken });
}

test("a 25 MB body sent to a busy archive route still gets its 429 in the browser", async ({ page }, testInfo) => {
  test.skip(!LARGE_BODY_PROJECTS.includes(testInfo.project.name), "the large-body refusal is proved on Firefox and Chromium on the desk");
  test.setTimeout(120_000);
  await signIn(page, "/home");

  const origin = new URL(page.url()).origin;
  const headers = { ...(await sessionHeaders(page)), cookie: await cookieHeader(page) };
  const holder = holdPreviewOpen(origin, headers);
  try {
    await holder.inFlight;
    await expect.poll(async () => {
      const status = (await fetch(`${origin}${PREVIEW_PATH}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      })).status;
      failIfHolderSettled(holder);
      return status;
    }, {
      message: "the slot is held: a small second request is refused with 429",
      timeout: 30_000,
      intervals: [250, 500, 1_000],
    }).toBe(429);

    const started = Date.now();
    const answer = await largePostFromPage(page, PREVIEW_PATH, LARGE_BODY_BYTES);

    expect(answer.failure, "the browser got an answer rather than a network error").toBeNull();
    expect(answer.status).toBe(429);
    expect(answer.code).toBe("archive_busy");
    expect(answer.retryAfter).toBe("60");
    expect(Date.now() - started).toBeLessThan(15_000);
  } finally {
    await holder.end();
    /* The server frees the slot a moment after it sees the client go; the next test must not start while it is still held. */
    await expect.poll(async () => (await fetch(`${origin}${PREVIEW_PATH}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    })).status, {
      message: "the slot is free again once the holder has ended",
      timeout: 60_000,
      intervals: [250, 500, 1_000, 2_000],
    }).not.toBe(429);
  }
});

test("a 25 MB body sent to an ordinary route gets its 413 in the browser", async ({ page }, testInfo) => {
  test.skip(!LARGE_BODY_PROJECTS.includes(testInfo.project.name), "the large-body refusal is proved on Firefox and Chromium on the desk");
  test.setTimeout(60_000);
  await signIn(page, "/home");

  const started = Date.now();
  const answer = await largePostFromPage(page, "/api/workspace/commands", LARGE_BODY_BYTES);

  expect(answer.failure, "the browser got an answer rather than a network error").toBeNull();
  expect(answer.status).toBe(413);
  expect(answer.code).toBe("request_too_large");
  expect(Date.now() - started).toBeLessThan(15_000);
});

test("a 25 MB body sent to an archive route with the wrong CSRF token still gets its 403 in the browser", async ({ page }, testInfo) => {
  test.skip(!LARGE_BODY_PROJECTS.includes(testInfo.project.name), "the large-body refusal is proved on Firefox and Chromium on the desk");
  test.setTimeout(120_000);
  await signIn(page, "/home");

  const started = Date.now();
  const answer = await largePostFromPage(page, PREVIEW_PATH, LARGE_BODY_BYTES, "not-the-session-token");

  expect(answer.failure, "the browser got an answer rather than a network error").toBeNull();
  expect(answer.status).toBe(403);
  expect(Date.now() - started).toBeLessThan(15_000);
});
