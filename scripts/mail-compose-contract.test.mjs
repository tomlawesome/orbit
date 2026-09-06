import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const mailOverlayUrl = new URL("../docker-compose.mail.yml", import.meta.url);
const rotationOverlayUrl = new URL(
  "../docker-compose.mail-alias-rotation.yml",
  import.meta.url,
);

function readOverlay(url) {
  return existsSync(url) ? readFileSync(url, "utf8").replaceAll("\r\n", "\n") : "";
}

describe("mail provider Compose overlay", () => {
  it("mounts the current SMTP secret without weakening the base deployment", () => {
    const overlay = readOverlay(mailOverlayUrl);

    expect(existsSync(mailOverlayUrl)).toBe(true);
    expect(overlay).toContain(
      "SMTP_PASSWORD_FILE: /run/orbit-secrets/orbit-smtp-password",
    );
    expect(overlay).toContain(
      "file: ${ORBIT_SECRETS_DIR:-./.orbit-secrets}/smtp-password",
    );
    expect(overlay).not.toMatch(/^\s+SMTP_PASSWORD:\s+\S+/mu);
  });

  it("carries no IMAP key: the mailbox credential is administration-surface, database-stored (ADR-0017)", () => {
    const overlay = readOverlay(mailOverlayUrl);

    expect(overlay).not.toContain("IMAP_");
  });

  it("no longer ships the retired alias-rotation overlay", () => {
    expect(existsSync(rotationOverlayUrl)).toBe(false);
  });
});
