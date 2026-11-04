import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { seedHouseholdInBrowser, signIn } from "./support/signed-in";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #838: the smoke journey's one live proof that extraction reaches the real
 * Tika sidecar (`scripts/ci/create-test-configuration.sh` turns the
 * `processing` profile on for this stack). `chromium-synthetic.pdf` renders
 * real, font-encoded page text through actual Chromium print-to-PDF -- not
 * something a stub parser could echo back. The route never returns extracted
 * text to the client (item-document-inspection.ts wipes it after building
 * suggestions), so `extracted: true`, reachable only through a real round
 * trip to Tika, is the strongest signal its contract exposes.
 *
 * `orbit-tika` has no host port and no Compose healthcheck, so `up --wait`
 * does not itself wait for it; this polls the real event instead of a guess.
 */
const HOUSEHOLD = "Extraction Proving Ground";
const FIXTURE_PATH = resolve(__dirname, "../support/fixtures/chromium-synthetic.pdf");

const households = householdRegister();

test("a real PDF uploaded through the product is extracted by the real Tika sidecar", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "API-only proof; nothing here differs by viewport");
  test.setTimeout(90_000);

  /* #1080: the sweep's hard delete is an instance-admin power. */
  await signIn(page);
  const household = households.track(await seedHouseholdInBrowser(page, HOUSEHOLD));

  try {
    const bytes = readFileSync(FIXTURE_PATH);
    const headers = { ...(await sessionHeaders(page)), "x-orbit-filename": encodeURIComponent("chromium-synthetic.pdf") };
    const url = `/api/households/${household.id}/item-document-inspection`;

    await expect
      .poll(
        async () => {
          const response = await page.request.post(url, { headers, data: bytes });
          if (!response.ok()) return `http_${response.status()}`;
          const body = (await response.json()) as { extracted: boolean; message?: string };
          return body.extracted ? "extracted" : (body.message ?? "not_extracted");
        },
        { timeout: 60_000, intervals: [5_000] },
      )
      .toBe("extracted");
  } finally {
    await households.sweep(page);
  }
});
