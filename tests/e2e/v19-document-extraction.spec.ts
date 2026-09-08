import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { settleArrival } from "./support/arrival";

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

async function seedHousehold(page: Page, name: string): Promise<{ id: string; name: string }> {
  return await page.evaluate(async (householdName) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const householdId = crypto.randomUUID();
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP",
          memberCount: 1, canManage: true, onboardingComplete: true,
          sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      }),
    });
    if (!response.ok) throw new Error(`household.create failed: ${response.status}`);
    return { id: householdId, name: householdName };
  }, name);
}

const households = householdRegister();

test("a real PDF uploaded through the product is extracted by the real Tika sidecar", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "API-only proof; nothing here differs by viewport");
  test.setTimeout(90_000);

  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await settleArrival(page);
  const household = households.track(await seedHousehold(page, HOUSEHOLD));

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
