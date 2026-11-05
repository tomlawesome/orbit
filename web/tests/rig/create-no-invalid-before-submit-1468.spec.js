import { expect, test } from "@playwright/test";

import { APP } from "../fidelity/pocket-states.js";
import { nameTheEntry } from "./chooser-support.js";

/*
 * #1468 test-bed defect: "The submitted data is invalid" showed above Add, on
 * the desk and the phone, as soon as a name was typed and a section picked,
 * before any submit.
 *
 * Cause: the form's dry run asks the engine at once. For a new item with a name
 * and a section but no importance the real engine throws a ZodError (#1463), and
 * the dry run's verdict (api/workspace/commands/+server.js) turns every ZodError
 * into the generic refusal "The submitted data is invalid". The fixture app only
 * parses, so it cannot say this; the test answers that one dry run as the real
 * engine does and asserts the form does not show it before submit.
 */

test.use({ reducedMotion: "reduce" });

const onPhone = () => test.info().project.name.includes("phone");

test("naming the entry and picking a section shows no 'submitted data is invalid' before submit", async ({ page }) => {
  let answered = 0;
  await page.route("**/api/workspace/commands", async (route) => {
    const body = route.request().postDataJSON() ?? {};
    if (body.dryRun === true && body.type === "item.upsert" && body.item?.title?.trim() && !body.item.importance) {
      answered += 1;
      return route.fulfill({ status: 200, json: { refusal: { code: "validation_failed", message: "The submitted data is invalid" } } });
    }
    return route.fallback();
  });
  await page.goto(`${APP}/create`, { waitUntil: "load" });
  if (onPhone()) await page.getByRole("textbox", { name: "name", exact: true }).fill("Boiler service");
  else { await page.locator("#card[data-ready]").waitFor({ state: "attached" }); await nameTheEntry(page, "Boiler service"); }
  await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
  await expect.poll(() => answered, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  await expect(page.locator("body")).not.toContainText(/submitted data is invalid/i);
});
