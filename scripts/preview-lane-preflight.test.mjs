import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const preflight = readFileSync(
  new URL("./preview-lane-preflight.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const composeValidation = readFileSync(
  new URL("./validate-compose-config.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

describe("preview-lane local preflight", () => {
  it("isolates generated configuration from the developer checkout", () => {
    expect(preflight).toContain("mktemp -d");
    expect(preflight).toContain("git ls-files --cached --others --exclude-standard");
    expect(preflight).toContain("GIT_WORK_TREE");
    expect(preflight).toContain("bash scripts/configure.sh");
    expect(preflight).toContain("bash scripts/validate-compose-config.sh");
    expect(preflight).toContain("trap cleanup EXIT");
    expect(preflight).not.toContain("docker compose up");
    expect(preflight).not.toMatch(/claude|mistral|ollama pull/iu);
  });

  it("calculates and validates the same release identity used by CI", () => {
    expect(preflight).toContain("node scripts/calculate-version.mjs --channel");
    expect(preflight).toContain("git rev-parse HEAD");
    expect(preflight).toContain("ORBIT_VERSION");
    expect(preflight).toContain("ORBIT_REVISION");
    expect(composeValidation).toContain("invalid ORBIT_VERSION");
    expect(composeValidation).toContain("invalid ORBIT_REVISION");
  });

  it("validates every supported Compose combination and processing boundary", () => {
    const expectedOverlays = [
      "docker-compose.build.yml",
      "docker-compose.acceptance.yml",
      "docker-compose.mail.yml",
      "docker-compose.mail-alias-rotation.yml",
    ];
    for (const overlay of expectedOverlays) {
      expect(composeValidation).toContain(overlay);
    }
    expect(composeValidation).toContain("--profile processing --profile ai");
    expect(composeValidation).toContain('networks["orbit-document-processing"].internal == true');
    expect(composeValidation).toContain('services["orbit-clamav"].networks');
    expect(composeValidation).toContain("docker compose version");
    expect(composeValidation).toContain("command -v jq");
  });

  it("never publishes, pushes, attests, or starts services", () => {
    const scripts = `${preflight}\n${composeValidation}`;
    expect(scripts).not.toMatch(/docker (?:push|login)|gh attestation|docker compose up/iu);
    expect(scripts).not.toContain("packages: write");
  });
});
