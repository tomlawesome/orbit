import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ALLOWED_KEYS } from "./config-contract";
import * as configurationMigration from "./configuration-migration";
import { parseEnvOrbitContent } from "./env-orbit-file";

// #1403 slice D3. Configuration and installer code kept only for installs
// older than the first supported release is gone: the ORBIT_SECRETS_DIR
// setting (read, refused and mounted), the deprecated SMTP_URL form, the
// removed-IMAP-key classification, the "deprecated_supported" and
// "legacy/unknown" labels, and the bare-version manifest shim. Each case
// names the file and the phrase that must stay absent. The configuration
// migration writer is not retired: it stamps every install.

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, repoRoot)), "utf8");

// Non-test sources that touched the secrets directory setting. The refusals
// and the compose interpolation and backup mounts go together or not at all.
const SECRETS_DIR_SOURCES = [
  "src/lib/config-contract.ts",
  "src/lib/configure-engine.ts",
  "src/lib/target-identity.ts",
  "src/cli/orbit.ts",
  "scripts/configure.sh",
  "scripts/install.sh",
  "scripts/backup.sh",
  "scripts/restore.sh",
  "scripts/export-recovery-bundle.sh",
  "scripts/import-recovery-bundle.sh",
  "scripts/test-backup-restore.sh",
  "scripts/test-e2e-local.sh",
  "docker-compose.yml",
  "docker-compose.kek-rotation.yml",
  "docker-compose.mail.yml",
  "compose/docker-compose.acceptance.yml",
  ".env-orbit.example",
];

describe("ORBIT_SECRETS_DIR is retired everywhere at once (#1403 D3)", () => {
  it.each(SECRETS_DIR_SOURCES)("%s does not mention ORBIT_SECRETS_DIR", (path) => {
    expect(read(path)).not.toContain("ORBIT_SECRETS_DIR");
  });

  it("is not an allowed configuration key", () => {
    expect(ALLOWED_KEYS as readonly string[]).not.toContain("ORBIT_SECRETS_DIR");
  });

  it("is refused like any other unknown key", () => {
    expect(parseEnvOrbitContent("ORBIT_SECRETS_DIR=./.orbit-secrets\n")).toMatchObject({
      ok: false,
      code: "configuration_unknown_key",
      key: "ORBIT_SECRETS_DIR",
    });
  });
});

describe("the deprecated SMTP_URL form is retired (#1403 D3)", () => {
  it.each(["SMTP_URL", "SMTP_URL_FILE"])("%s is not an allowed configuration key", (key) => {
    expect(ALLOWED_KEYS as readonly string[]).not.toContain(key);
  });

  it.each(["SMTP_URL=smtp://relay.example.invalid:587\n", "SMTP_URL_FILE=.orbit-secrets/smtp-url\n"])(
    "refuses %j as an unknown key",
    (line) => {
      expect(parseEnvOrbitContent(line)).toMatchObject({ ok: false, code: "configuration_unknown_key" });
    },
  );

  it.each([
    "src/lib/config-contract.ts",
    "src/lib/env-orbit-file.ts",
    "src/lib/configuration-migration.ts",
    "src/server/notification-worker.ts",
    ".env-orbit.example",
  ])("%s has no SMTP_URL or SMTP_URL_FILE", (path) => {
    expect(read(path)).not.toMatch(/\bSMTP_URL(_FILE)?\b/);
  });
});

describe("the removed IMAP_* key classification is retired (#1403 D3)", () => {
  it("treats a former IMAP_* key as an unknown key, not a removed one", () => {
    expect(parseEnvOrbitContent("IMAP_ENABLED=true\n")).toMatchObject({
      ok: false,
      code: "configuration_unknown_key",
      key: "IMAP_ENABLED",
    });
  });

  it.each(["src/lib/env-orbit-file.ts", "src/lib/configuration-migration.ts"])(
    "%s has no removed-key list, code or branch",
    (path) => {
      const text = read(path);
      expect(text).not.toContain("REMOVED_KEYS");
      expect(text).not.toContain("configuration_removed_key");
      expect(text).not.toContain("removed_incompatible");
    },
  );
});

describe("older-install labels are retired from the configuration engine (#1403 D3)", () => {
  it.each(["src/lib/configuration-migration.ts", "src/lib/deployment-profile.ts"])(
    "%s has no legacy/unknown label",
    (path) => {
      expect(read(path)).not.toContain("legacy/unknown");
    },
  );

  it("configuration-migration.ts has no deprecated_supported alias class", () => {
    const text = read("src/lib/configuration-migration.ts");
    expect(text).not.toContain("deprecated_supported");
    expect(text).not.toContain("DEPRECATED_SECRET_KEYS");
  });

  it("configuration-migration.ts has no v0 prior-schema conversion", () => {
    expect(read("src/lib/configuration-migration.ts")).not.toMatch(/"v0"/);
  });

  it("keeps the configuration migration writer, which stamps every install", () => {
    expect(typeof configurationMigration.migrateEnvironmentFile).toBe("function");
    expect(typeof configurationMigration.runConfigurationMigration).toBe("function");
    expect(typeof configurationMigration.installMigrateCommand).toBe("function");
    expect(configurationMigration.CONFIGURATION_ROLLBACK_SUFFIX).toBe(".orbit-config.rollback");
  });
});

describe("the bare-version release manifest shim is retired (#1403 D3)", () => {
  it("get-orbit.sh no longer strips a leading v to accept older bare manifests", () => {
    const text = read("scripts/get-orbit.sh");
    expect(text).not.toContain('version="${version#v}"');
    expect(text).not.toMatch(/older\s+manifests wrote a bare/);
  });

  it("install.sh no longer re-prefixes a bare manifest version", () => {
    const text = read("scripts/install.sh");
    expect(text).not.toContain('manifest_version="v${manifest_version#v}"');
    expect(text).not.toMatch(/older ones\s+# carried the bare/);
  });
});

describe("test harnesses stamp no ORBIT_VERSION build argument (#1403 D3)", () => {
  it.each(["scripts/test-repair-journeys.sh", "scripts/test-backup-restore.sh"])(
    "%s does not pass ORBIT_VERSION=v0.3.0",
    (path) => {
      expect(read(path)).not.toContain("ORBIT_VERSION=v0.3.0");
    },
  );
});
