import { expect } from "@playwright/test";

/*
 * #1463: the Add form's required importance row, picked. Desk: a radiogroup
 * named "Importance" whose radios are named low / normal / high (P's tiles).
 * Phone: a group named "Importance" of three buttons (P's chips, aria-pressed).
 * Only the visible form's group counts, so the helper is the same for both.
 */

/** @param {import("@playwright/test").Page} page */
const onPhone = (page) => (page.viewportSize()?.width ?? 1280) < 700;

/** @param {import("@playwright/test").Page} page */
export const importanceGroup = (page) =>
  onPhone(page)
    ? page.getByRole("group", { name: "Importance" })
    : page.getByRole("radiogroup", { name: "Importance" });

/** The control for one level in the Add form. @param {import("@playwright/test").Page} page @param {"low" | "normal" | "high"} level */
export const importanceControl = (page, level) =>
  importanceGroup(page).getByRole(onPhone(page) ? "button" : "radio", { name: level, exact: true });

/** Pick a level on the Add form and wait until it reads as chosen. @param {import("@playwright/test").Page} page @param {"low" | "normal" | "high"} [level] */
export async function pickImportance(page, level = "normal") {
  const control = importanceControl(page, level);
  await control.click();
  await expect(control).toHaveAttribute(onPhone(page) ? "aria-pressed" : "aria-checked", "true");
}
