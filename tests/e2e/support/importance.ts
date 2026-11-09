import { expect, type Page } from "@playwright/test";

/*
 * #1463: pick the Add form's required importance. Desk: a radiogroup named
 * "Importance" with radios low / normal / high. Phone: a group named
 * "Importance" with three buttons (aria-pressed).
 */
export async function pickImportance(page: Page, level: "low" | "normal" | "high" = "normal") {
  const phone = (page.viewportSize()?.width ?? 1280) < 700;
  const group = phone ? page.getByRole("group", { name: "Importance" }) : page.getByRole("radiogroup", { name: "Importance" });
  const control = group.getByRole(phone ? "button" : "radio", { name: level, exact: true });
  await control.click();
  await expect(control).toHaveAttribute(phone ? "aria-pressed" : "aria-checked", "true");
}
