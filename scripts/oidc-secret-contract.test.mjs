import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const entrypoint = readFileSync(new URL("./container-entrypoint.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const environmentExample = readFileSync(new URL("../.env-orbit.example", import.meta.url), "utf8").replaceAll("\r\n", "\n");

function serviceBlock(name) {
  const start = compose.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`Service ${name} is not declared`);
  const rest = compose.slice(start + 1);
  const nextSibling = rest.search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/u);
  return nextSibling < 0 ? rest : rest.slice(0, nextSibling);
}

describe("file-backed OIDC client secret contract", () => {
  it("mounts the persistent host file into the application without a direct Compose value", () => {
    expect(serviceBlock("orbit-app")).toContain("      - orbit-oidc-client-secret");
    expect(compose).toContain(
      "orbit-oidc-client-secret:\n    file: ${ORBIT_SECRETS_DIR:-./.orbit-secrets}/oidc-client-secret",
    );
    expect(compose).not.toMatch(/^\s+OIDC_CLIENT_SECRET:\s+\S+/mu);
  });

  it("uses one canonical private runtime path in operator configuration", () => {
    expect(environmentExample).toContain(
      "# OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
    );
    expect(environmentExample).not.toContain(
      "OIDC_CLIENT_SECRET_FILE=/run/secrets/orbit-oidc-client-secret",
    );
  });

  it("skips only the unselected empty OIDC placeholder before retaining the generic empty-secret failure", () => {
    expect(entrypoint).toContain(
      '[ "$secret_name" = "orbit-oidc-client-secret" ] && [ "$secret_size" -eq 0 ] &&',
    );
    expect(entrypoint).toContain('[ -z "${OIDC_CLIENT_SECRET_FILE:-}" ]; then');
    expect(entrypoint).toContain('[ "$secret_size" -gt 0 ] ||\n    fail "refusing an empty secret"');
  });
});
