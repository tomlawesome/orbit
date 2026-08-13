import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for the #383 deep-review finding at dashboard.tsx:8
// (home route statically importing ~115KB of settings/modal-only source
// that never renders on first paint). This is a source-level guard rather
// than a bundle-size assertion — vitest doesn't run the Next/Turbopack
// bundler, so the thing we can actually pin here is "these components stay
// behind next/dynamic() and never regress back to a static value import."
const source = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");

// Settings-only (rendered only when `mode === "settings"`, see
// renderSettingsContent) and modal-only (rendered only behind boolean state
// that starts `false`) components that issue #383 moved off the home
// route's static import graph.
const dynamicOnly = [
  "HouseholdSettings",
  "PortableArchiveManager",
  "ImapInbox",
  "MemberManager",
  "ItemEditor",
  "ItemDetail",
  "NotificationCenter",
  "HouseholdOnboarding",
];

describe("dashboard.tsx code-splitting (issue #383)", () => {
  it("imports next/dynamic", () => {
    expect(source).toMatch(/^import dynamic from "next\/dynamic";$/m);
  });

  it.each(dynamicOnly)("declares %s via next/dynamic, not a static value import", (name) => {
    // A static value import would look like `import { Name, ... } from "@/components/...";`
    // (or `import { Name as ... }`). Only a `type`-only import of the same
    // name is allowed to remain, for prop/input types.
    const staticValueImport = new RegExp(`^import\\s*\\{[^}]*(?<!type )\\b${name}\\b[^}]*\\}\\s*from\\s*"@/components/`, "m");
    expect(source).not.toMatch(staticValueImport);

    const dynamicDeclaration = new RegExp(`const ${name} = dynamic\\(`);
    expect(source).toMatch(dynamicDeclaration);
  });

  it("keeps the two known-exception components as static imports (documented, not a regression)", () => {
    // FirstRunWizard can render on the very first paint for a fresh
    // instance, and HouseholdRecoveryPrompt shares a module with the
    // settings-only HouseholdRecovery, which is already forced into the
    // home bundle by HouseholdRecoveryPrompt's own static, unconditional
    // import — dynamic-importing just one export of that module buys
    // nothing. See the #383 fix notes for the full reasoning.
    expect(source).toMatch(/^import \{ FirstRunWizard, type HouseholdSetupInput \} from "@\/components\/first-run-wizard";$/m);
    expect(source).toMatch(/^import \{ HouseholdRecovery, HouseholdRecoveryPrompt \} from "@\/components\/household-recovery";$/m);
  });

  it("gives every ssr:false dynamic import a boolean-gated modal, not the settings route", () => {
    const modalOnly = ["ItemEditor", "ItemDetail", "NotificationCenter", "HouseholdOnboarding"];
    for (const name of modalOnly) {
      const declaration = new RegExp(`const ${name} = dynamic\\([^;]*\\{ ssr: false \\}\\);`, "s");
      expect(source).toMatch(declaration);
    }

    // The settings-only components must stay SSR-able (default ssr: true) —
    // /settings renders them unconditionally on first paint.
    const settingsOnly = ["HouseholdSettings", "PortableArchiveManager", "ImapInbox", "MemberManager"];
    for (const name of settingsOnly) {
      const declaration = new RegExp(`const ${name} = dynamic\\(\\(\\) => import\\("@/components/[a-z-]+"\\)\\.then\\(\\(mod\\) => mod\\.${name}\\)\\);`);
      expect(source).toMatch(declaration);
    }
  });
});
