import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1403 slice D5. Documentation that described code or releases kept only
 * for older installs is retired. Each case names a document and a distinctive
 * phrase (or heading) that must stay out of it, so a legitimate mention
 * elsewhere does not trip it. ADRs keep their history and are not searched.
 * The real external fact that survives is that the v1.0 to v1.2 tags were
 * retracted, so the releasing guide keeps a short note saying so.
 */

const read = (rel) => readFileSync(resolve(__dirname, "../../", rel), "utf8").replaceAll("\r\n", "\n");

describe("retired installer-guarantees sections (#1403 D5)", () => {
  const text = read("docs/installer-guarantees.md");

  it("has no section for the deleted scripts/configuration.sh", () => {
    expect(text).not.toMatch(/^## configuration\.sh /mu);
    expect(text).not.toContain("`scripts/configuration.sh` no longer exists");
  });

  it("has no section for the deleted generate-vapid.mjs", () => {
    expect(text).not.toMatch(/^## generate-vapid\.mjs /mu);
  });

  it("no longer catalogues the removed IMAP key refusal or the deprecated secret aliases", () => {
    expect(text).not.toContain("configuration_removed_key");
    expect(text).not.toContain("Legacy/deprecated secret key aliases");
  });
});

describe("releasing guide drops the v1.x narrative (#1403 D5)", () => {
  const text = read("docs/releasing.md");

  it("has no 'Version tags in GHCR start at v0.3.0' section, or a pointer to it", () => {
    expect(text).not.toContain("Version tags in GHCR start at v0.3.0");
  });

  it("no longer tells the story of the dropped version tag", () => {
    expect(text).not.toContain("6952f35");
    expect(text).not.toContain("feat(release): automate preview versions and lanes");
    expect(text).not.toContain("the only version tag an operator");
  });

  it("no longer records the retracted releases' digests", () => {
    expect(text).not.toContain("sha256:92fb79336d997139002f94c52fd4767787767cc293147c12bbcfc25362a9237d");
    expect(text).not.toContain("sha256:35ad7cea14f835b8e5b350faa0fcf711cbf95c517a2bad26f5fe72795a8aeb12");
  });

  it("keeps the short note that the v1.0 to v1.2 tags were retracted", () => {
    expect(text).toMatch(/^## Supported install targets$/mu);
    expect(text).toMatch(/retracted[^]{0,80}v1\.0[^]{0,40}v1\.2/u);
  });
});

describe("other retired passages (#1403 D5)", () => {
  it("authentication.md no longer promises direct-value secrets stay readable 'for upgrade compatibility'", () => {
    const text = read("docs/authentication.md");
    expect(text).not.toContain("remains readable for upgrade compatibility");
  });

  it("administrator-operations.md has no SMTP_URL or ORBIT_SECRETS_DIR rows", () => {
    const text = read("docs/administrator-operations.md");
    expect(text).not.toMatch(/\bSMTP_URL(_FILE)?\b/u);
    expect(text).not.toContain("ORBIT_SECRETS_DIR");
  });

  it("engine-events.md has no note on the imap group's move, and no ORBIT_SECRETS_DIR mount rule", () => {
    const text = read("docs/engine-events.md");
    expect(text).not.toContain('`imap` moved from "Optional groups" to "App-managed groups"');
    expect(text).not.toContain("ORBIT_SECRETS_DIR");
  });

  it("quality-strategy.md has no due-next lines", () => {
    const text = read("docs/quality-strategy.md");
    expect(text).not.toContain("due-next");
  });
});
