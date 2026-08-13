import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The administration route wraps AdminManager in its own page heading.
 *
 * Playwright matches accessible names by substring, so if the page heading
 * overlaps a heading inside AdminManager, every existing administration
 * assertion resolves to two elements and fails as a strict-mode violation.
 * That is a source-level constraint, catchable here in milliseconds rather
 * than in a ten-minute browser run.
 */

const page = readFileSync(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8");
const manager = readFileSync(new URL("../src/components/admin-manager.tsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/components/dashboard.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

function headings(source) {
  return [...source.matchAll(/<h[1-6][^>]*>([^<{]+)<\/h[1-6]>/gu)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

/**
 * Playwright matches accessible names case-insensitively and with normalised
 * whitespace unless `exact` is set, so the comparison must too. Comparing
 * case-sensitively would miss exactly the collision this guard exists to catch.
 */
function overlaps(a, b) {
  const left = a.toLowerCase().replace(/\s+/gu, " ");
  const right = b.toLowerCase().replace(/\s+/gu, " ");
  return left.includes(right) || right.includes(left);
}

describe("administration heading uniqueness", () => {
  it("finds headings in both sources", () => {
    // Guards the guard: a regex that silently matches nothing would make every
    // assertion below pass vacuously.
    expect(headings(page).length).toBeGreaterThan(0);
    expect(headings(manager).length).toBeGreaterThan(0);
  });

  it("does not overlap any heading rendered inside AdminManager", () => {
    const managerHeadings = headings(manager);
    for (const pageHeading of headings(page)) {
      for (const managerHeading of managerHeadings) {
        expect(
          overlaps(pageHeading, managerHeading),
          `Page heading "${pageHeading}" overlaps AdminManager heading "${managerHeading}"`,
        ).toBe(false);
      }
    }
  });

  it("detects the overlap it exists to prevent", () => {
    // The exact failure this replaced: <h1>Instance operations</h1> against
    // AdminManager's <h3>Operations</h3>.
    expect(overlaps("Instance operations", "Operations")).toBe(true);
    expect(overlaps("Manage this Orbit instance", "Operations")).toBe(false);
    expect(overlaps("Manage this Orbit instance", "Instance administrators")).toBe(false);
  });

  it("keeps the administration surface on the persisted theme and readable heading metrics", () => {
    expect(styles).toContain(":is(.app-frame, .settings-page, .admin-page)");
    for (const attribute of [
      '"data-theme": themePreference.theme',
      '"data-text-size": themePreference.textSize',
    ]) {
      expect(page).toContain(attribute);
    }
    expect(page).toContain("usePersistedThemePreference(session?.user)");
    expect(dashboard).toContain("usePersistedThemePreference(session.user)");
    expect(dashboard).not.toContain("THEME_SESSION_HYDRATED_KEY");
    expect(page.match(/<main className="admin-page" \{\.\.\.appearanceAttributes\}>/gu)).toHaveLength(3);
    expect(page.match(/className="page-heading"/gu)).toHaveLength(2);
    expect(dashboard).toContain('<h1 className="page-heading"');
    const globalHeadingStyles = styles.match(/^h1 \{([^}]*)\}/mu)?.[1] ?? "";
    const heroHeadingStyles = styles.match(/\.hero-copy h1 \{([^}]*)\}/u)?.[1] ?? "";
    const pageHeadingStyles = styles.match(/\.page-heading \{([^}]*)\}/u)?.[1] ?? "";
    expect(globalHeadingStyles).not.toMatch(/letter-spacing:\s*-2\.8px/u);
    expect(globalHeadingStyles).not.toMatch(/line-height:\s*\.98/u);
    expect(heroHeadingStyles).toMatch(/letter-spacing:\s*-2\.8px/u);
    expect(heroHeadingStyles).toMatch(/line-height:\s*\.98/u);
    expect(pageHeadingStyles).toMatch(/line-height:\s*1\.1/u);
    expect(pageHeadingStyles).toMatch(/letter-spacing:\s*-\.9px/u);
    expect(pageHeadingStyles).toMatch(/overflow-wrap:\s*break-word/u);
  });
});
