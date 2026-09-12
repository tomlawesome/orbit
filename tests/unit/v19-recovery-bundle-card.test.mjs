import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #968 (slice 1 of #966): the persistent "no recovery bundle exported" card
 * on the administration screen. Owner ruling, 2026-09-10: "enforced means it
 * persists, not that it blocks" — not dismissible while the condition is
 * true, never a modal, never blocks use of the instance. Follows #956's
 * rotation-card composition exactly, as the third card in that family
 * (#941 added the other two) — proved the way v19-metadata-status.test.mjs
 * proves its own cards: against the file that ships, since web/'s own tests
 * are Playwright and this suite has no Svelte runner.
 */

const ADMINISTRATION = readFileSync(
  new URL("../../web/src/routes/administration/+page.svelte", import.meta.url),
  "utf8",
);
const ADMIN_GUIDE = readFileSync(new URL("../../docs/administrator-operations.md", import.meta.url), "utf8");

describe("the administration screen's recovery-bundle card", () => {
  it("earns zero pixels once a bundle is recorded, and renders in the #956/#941 card family otherwise", () => {
    expect(ADMINISTRATION).toContain("{#if view.recoveryBundle && !view.recoveryBundle.exported}");
    expect(ADMINISTRATION).toContain("<h2>No recovery bundle exported</h2>");
    const block = ADMINISTRATION.slice(
      ADMINISTRATION.indexOf("{#if view.recoveryBundle && !view.recoveryBundle.exported}"),
      ADMINISTRATION.indexOf("<h2>People</h2>"),
    );
    expect(block).toContain('class="card wide rotation"');
    // No buttons and not dismissible: the owner's "persists, not blocks" ruling.
    expect(block).not.toContain("<button");
    expect(block).not.toContain("dismiss");
  });

  it("says what is lost, the two-part custody, and points at the administrator guide", () => {
    const block = ADMINISTRATION.slice(
      ADMINISTRATION.indexOf("<h2>No recovery bundle exported</h2>"),
      ADMINISTRATION.indexOf("<h2>People</h2>"),
    );
    const prose = block.replace(/\s+/g, " ");
    expect(prose).toContain("every document, all encrypted metadata");
    expect(prose).toContain("every stored address");
    expect(block).toContain("orbit backup");
    expect(block).toContain("orbit export-recovery-bundle");
    expect(prose).toContain("Exporting a recovery bundle");
    // No key or database mechanic reaches this member-facing-adjacent card either.
    expect(block).not.toMatch(/DOCUMENT_KEK|key-encryption key/);
  });

  it("re-arms after a rotation, in the same words the card and the guide both use", () => {
    const sentence = "a bundle wrapped under the previous key can no longer recover the current one";
    expect(ADMINISTRATION.replace(/\s+/g, " ")).toContain(sentence);
    expect(ADMIN_GUIDE.replace(/\s+/g, " ")).toContain(sentence);
  });

  it("explains the two-part custody in the administrator guide in the card's own words (done-when criterion)", () => {
    const phrase =
      "the bundle file on storage separate from this instance, and its passphrase in a password manager or on paper — never both together";
    const cardCustody = ADMINISTRATION
      .slice(ADMINISTRATION.indexOf("<h2>No recovery bundle exported</h2>"), ADMINISTRATION.indexOf("<h2>People</h2>"))
      .replace(/\s+/g, " ");
    const guideCustody = ADMIN_GUIDE
      .slice(ADMIN_GUIDE.indexOf("## Exporting a recovery bundle"), ADMIN_GUIDE.indexOf("## Restoring the document key-encryption key"))
      .replace(/\s+/g, " ");
    expect(cardCustody).toContain(phrase);
    expect(guideCustody).toContain(phrase);
  });

  it("adds a guide section the installer's completion instruction can actually point at", () => {
    expect(ADMIN_GUIDE).toContain("## Exporting a recovery bundle");
    expect(ADMIN_GUIDE).toContain("orbit backup");
    expect(ADMIN_GUIDE).toContain("orbit export-recovery-bundle <backup.tar>");
  });
});
