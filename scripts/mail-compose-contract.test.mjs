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

describe("mail provider Compose overlays", () => {
  it("mounts current SMTP, IMAP, and alias secrets without weakening the base deployment", () => {
    const overlay = readOverlay(mailOverlayUrl);

    expect(existsSync(mailOverlayUrl)).toBe(true);
    expect(overlay).toContain(
      "SMTP_PASSWORD_FILE: /run/orbit-secrets/orbit-smtp-password",
    );
    expect(overlay).toContain(
      "IMAP_PASSWORD_FILE: /run/orbit-secrets/orbit-imap-password",
    );
    expect(overlay).toContain(
      "IMAP_ALIAS_CURRENT_SECRET_FILE: /run/orbit-secrets/orbit-imap-alias-current-secret",
    );
    expect(overlay).toContain(
      "file: ${ORBIT_SECRETS_DIR:-./.orbit-secrets}/smtp-password",
    );
    expect(overlay).toContain(
      "file: ${ORBIT_SECRETS_DIR:-./.orbit-secrets}/imap-password",
    );
    expect(overlay).toContain(
      "file: ${ORBIT_SECRETS_DIR:-./.orbit-secrets}/imap-alias-current-secret",
    );
    expect(overlay).not.toMatch(/^\s+SMTP_PASSWORD:\s+\S+/mu);
    expect(overlay).not.toMatch(/^\s+IMAP_PASSWORD:\s+\S+/mu);
    expect(overlay).not.toMatch(/^\s+IMAP_ALIAS_CURRENT_SECRET:\s+\S+/mu);
  });

  it("mounts the previous alias key only through the bounded rotation overlay", () => {
    const mailOverlay = readOverlay(mailOverlayUrl);
    const rotationOverlay = readOverlay(rotationOverlayUrl);

    expect(existsSync(rotationOverlayUrl)).toBe(true);
    expect(mailOverlay).not.toContain("IMAP_ALIAS_PREVIOUS_SECRET_FILE");
    expect(rotationOverlay).toContain(
      "IMAP_ALIAS_PREVIOUS_SECRET_FILE: /run/orbit-secrets/orbit-imap-alias-previous-secret",
    );
    expect(rotationOverlay).toContain(
      "file: ${ORBIT_SECRETS_DIR:-./.orbit-secrets}/imap-alias-previous-secret",
    );
    expect(rotationOverlay).not.toMatch(
      /^\s+IMAP_ALIAS_PREVIOUS_SECRET:\s+\S+/mu,
    );
  });
});
