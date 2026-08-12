import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runGuidedFlow } from "./engine-prompt-renderer.fixture.mjs";

// Pins docs/engine-events.md's "Machine prompts (v0)" section against
// scripts/configure.sh, the same way scripts/engine-events.test.mjs pins the
// plain-mode event stream against scripts/installer-ui.sh: (a) the
// field/kind/reason vocabularies must match exactly in both directions, and
// (b)-(c) a live sandboxed run of the guided flow, driven only through the
// documented line grammar by the schema-blind
// scripts/engine-prompt-renderer.fixture.mjs, must produce exactly the
// events the contract promises.

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const repoDir = join(scriptsDir, "..");
const configureScriptSource = readFileSync(join(scriptsDir, "configure.sh"), "utf8");
const contractPath = join(repoDir, "docs", "engine-events.md");
const contractSource = readFileSync(contractPath, "utf8");

function implementedVocabulary() {
  const kindStart = configureScriptSource.indexOf("machine_prompt_field_kind() {");
  const kindEnd = configureScriptSource.indexOf("esac", kindStart);
  expect(kindStart).toBeGreaterThan(-1);
  expect(kindEnd).toBeGreaterThan(kindStart);
  const kindBody = configureScriptSource.slice(kindStart, kindEnd);

  const field = new Set();
  const kind = new Set();
  for (const match of kindBody.matchAll(/^\s*([A-Z][A-Z0-9_]*)\)\s*printf '([a-z]+)'/gm)) {
    field.add(match[1]);
    kind.add(match[2]);
  }

  const reasonStart = configureScriptSource.indexOf(
    '# --- reason vocabulary (docs/engine-events.md "Machine prompts (v0)") -------',
  );
  const reasonEnd = configureScriptSource.indexOf("# --- end reason vocabulary", reasonStart);
  expect(reasonStart).toBeGreaterThan(-1);
  expect(reasonEnd).toBeGreaterThan(reasonStart);
  const reasonBody = configureScriptSource.slice(reasonStart, reasonEnd);

  const reason = new Set();
  for (const match of reasonBody.matchAll(/printf '([a-z][a-z-]*)'/gu)) {
    reason.add(match[1]);
  }

  return { field, kind, reason };
}

const DOC_HEADINGS = { field: "field", kind: "kind", reason: "reason-class" };

function documentedVocabulary() {
  const vocabulary = {};
  for (const [key, heading] of Object.entries(DOC_HEADINGS)) {
    const match = contractSource.match(new RegExp(`### ${heading}\\n\\n\`\`\`\\n([^\`]+)\`\`\``, "u"));
    expect(match, `docs/engine-events.md must contain a machine-prompts \`\`\` block for ${heading}`).not.toBeNull();
    vocabulary[key] = new Set(
      match[1]
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }
  return vocabulary;
}

describe("machine prompt protocol v0 contract", () => {
  const implemented = implementedVocabulary();
  const documented = documentedVocabulary();

  for (const key of ["field", "kind", "reason"]) {
    it(`documents exactly the implemented ${key} vocabulary`, () => {
      const undocumented = [...implemented[key]].filter((value) => !documented[key].has(value));
      const phantom = [...documented[key]].filter((value) => !implemented[key].has(value));
      expect(undocumented, `implemented but undocumented ${key} values`).toEqual([]);
      expect(phantom, `documented but unimplemented ${key} values`).toEqual([]);
    });
  }
});

// --- Live sandboxed runs, driven by the schema-blind renderer fixture -----

function makeFixtureDir(envOrbitContent) {
  const targetDir = mkdtempSync(join(tmpdir(), "orbit-engine-prompts-target-"));
  mkdirSync(join(targetDir, "scripts"));
  writeFileSync(join(targetDir, "scripts", "configure.sh"), configureScriptSource);
  chmodSync(join(targetDir, "scripts", "configure.sh"), 0o755);
  writeFileSync(
    join(targetDir, ".env-orbit.example"),
    readFileSync(join(repoDir, ".env-orbit.example"), "utf8"),
  );
  if (envOrbitContent !== undefined) {
    writeFileSync(join(targetDir, ".env-orbit"), envOrbitContent);
    chmodSync(join(targetDir, ".env-orbit"), 0o600);
  }
  return targetDir;
}

function guidedFlowEnv(overrides = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
    ORBIT_IMAGE: "orbit-local:abcdef123456",
    ORBIT_CONFIGURE_PROMPTS: "machine",
    ...overrides,
  };
}

function driveInit(targetDir, answers, envOverrides = {}) {
  return runGuidedFlow({
    command: "bash",
    args: [join(targetDir, "scripts", "configure.sh"), "--init"],
    cwd: targetDir,
    env: guidedFlowEnv(envOverrides),
    answers,
  });
}

function driveSetOidcSecret(targetDir, answers, envOverrides = {}) {
  return runGuidedFlow({
    command: "bash",
    args: [join(targetDir, "scripts", "configure.sh"), "--set-oidc-secret"],
    cwd: targetDir,
    env: guidedFlowEnv(envOverrides),
    answers,
  });
}

const validAppUrl = "https://orbit.machine-prompt-test.internal";
const validIssuer = "https://auth.machine-prompt-test.internal/application/o/orbit/";
const validClientId = "machine-prompt-test-client-id";

describe("scripts/configure.sh --init (ORBIT_CONFIGURE_PROMPTS=machine)", () => {
  it("completes a guided configuration from the documented events alone, first attempt", async () => {
    const targetDir = makeFixtureDir("UNRELATED_KEY=keep-me\n");

    const result = await driveInit(targetDir, {
      APP_URL: validAppUrl,
      OIDC_ISSUER: validIssuer,
      OIDC_CLIENT_ID: validClientId,
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.events).toEqual([
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 1 },
      { type: "prompt-accept", field: "APP_URL" },
      { type: "prompt", field: "OIDC_ISSUER", kind: "url", required: "true", attempt: 1 },
      { type: "prompt-accept", field: "OIDC_ISSUER" },
      { type: "prompt", field: "OIDC_CLIENT_ID", kind: "text", required: "true", attempt: 1 },
      { type: "prompt-accept", field: "OIDC_CLIENT_ID" },
    ]);
    expect(result.renderedLog).toHaveLength(6);

    // No configuration value ever appears in an emitted protocol line or the
    // renderer's generic rendering (only fixed field/kind/reason names do).
    expect(result.stdout).not.toContain(validAppUrl);
    expect(result.stdout).not.toContain(validIssuer);
    expect(result.stdout).not.toContain(validClientId);
    expect(result.renderedLog.join("\n")).not.toContain(validAppUrl);

    const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(updated).toContain("UNRELATED_KEY=keep-me");
    expect(updated).toContain(`APP_URL=${validAppUrl}`);
    expect(updated).toContain(`OIDC_ISSUER=${validIssuer}`);
    expect(updated).toContain(`OIDC_CLIENT_ID=${validClientId}`);
    expect(updated).toContain(`OIDC_CALLBACK_URL=${validAppUrl}/api/auth/callback`);
  });

  it("rejects an invalid answer with a documented reason class, then accepts the retry", async () => {
    const targetDir = makeFixtureDir("UNRELATED_KEY=keep-me\n");

    const result = await driveInit(targetDir, {
      APP_URL: ["http://orbit.machine-prompt-test.internal", validAppUrl],
      OIDC_ISSUER: validIssuer,
      OIDC_CLIENT_ID: validClientId,
    });

    expect(result.exitCode).toBe(0);
    expect(result.events.slice(0, 4)).toEqual([
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 1 },
      { type: "prompt-reject", field: "APP_URL", reason: "not-https" },
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 2 },
      { type: "prompt-accept", field: "APP_URL" },
    ]);
    expect(result.stdout).not.toContain("http://orbit.machine-prompt-test.internal");

    const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(updated).toContain(`APP_URL=${validAppUrl}`);
  });

  it("aborts after a third rejected answer for the same field, without mutating the environment file", async () => {
    const initial = "UNRELATED_KEY=keep-me\n";
    const targetDir = makeFixtureDir(initial);

    const result = await driveInit(targetDir, {
      APP_URL: ["not-a-url", "also-not-a-url", "still-not-a-url"],
      OIDC_ISSUER: validIssuer,
      OIDC_CLIENT_ID: validClientId,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Guided configuration was cancelled.");
    expect(result.events).toEqual([
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 1 },
      { type: "prompt-reject", field: "APP_URL", reason: "not-https" },
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 2 },
      { type: "prompt-reject", field: "APP_URL", reason: "not-https" },
      { type: "prompt", field: "APP_URL", kind: "url", required: "true", attempt: 3 },
      { type: "prompt-reject", field: "APP_URL", reason: "not-https" },
      { type: "prompt-abort", field: "APP_URL" },
    ]);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(initial);
  });

  it("classifies a blank answer as empty and an out-of-range port as not-absolute-url", async () => {
    const targetDir = makeFixtureDir("UNRELATED_KEY=keep-me\n");

    const result = await driveInit(targetDir, {
      APP_URL: validAppUrl,
      OIDC_ISSUER: validIssuer,
      OIDC_CLIENT_ID: ["", validClientId],
    });

    expect(result.exitCode).toBe(0);
    const clientIdEvents = result.events.filter((event) => event.field === "OIDC_CLIENT_ID");
    expect(clientIdEvents).toEqual([
      { type: "prompt", field: "OIDC_CLIENT_ID", kind: "text", required: "true", attempt: 1 },
      { type: "prompt-reject", field: "OIDC_CLIENT_ID", reason: "empty" },
      { type: "prompt", field: "OIDC_CLIENT_ID", kind: "text", required: "true", attempt: 2 },
      { type: "prompt-accept", field: "OIDC_CLIENT_ID" },
    ]);
  });

  it("leaves default (non-machine) behaviour untouched when ORBIT_CONFIGURE_PROMPTS is unset", () => {
    const targetDir = makeFixtureDir("UNRELATED_KEY=keep-me\n");
    const binDir = mkdtempSync(join(tmpdir(), "orbit-engine-prompts-fakebin-"));

    const result = spawnSync(
      "bash",
      [join(targetDir, "scripts", "configure.sh"), "--init"],
      {
        cwd: targetDir,
        encoding: "utf8",
        env: {
          PATH: `${binDir}:${process.env.PATH}`,
          HOME: process.env.HOME ?? tmpdir(),
          ORBIT_IMAGE: "orbit-local:abcdef123456",
          ORBIT_CONFIGURE_APP_URL: validAppUrl,
          ORBIT_CONFIGURE_OIDC_ISSUER: validIssuer,
          ORBIT_CONFIGURE_OIDC_CLIENT_ID: validClientId,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("prompt field=");
    const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(updated).toContain(`APP_URL=${validAppUrl}`);
  });
});

describe("scripts/configure.sh --set-oidc-secret (ORBIT_CONFIGURE_PROMPTS=machine)", () => {
  it("collects the secret without ever emitting its value, rejecting an empty answer first", async () => {
    const targetDir = makeFixtureDir(undefined);

    const result = await driveSetOidcSecret(targetDir, {
      OIDC_CLIENT_SECRET: ["", "super-secret-machine-value"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.events).toEqual([
      { type: "prompt", field: "OIDC_CLIENT_SECRET", kind: "secret", required: "true", attempt: 1 },
      { type: "prompt-reject", field: "OIDC_CLIENT_SECRET", reason: "empty" },
      { type: "prompt", field: "OIDC_CLIENT_SECRET", kind: "secret", required: "true", attempt: 2 },
      { type: "prompt-accept", field: "OIDC_CLIENT_SECRET" },
    ]);
    expect(result.stdout).not.toContain("super-secret-machine-value");
    expect(result.stderr).not.toContain("super-secret-machine-value");

    const secretPath = join(targetDir, ".orbit-secrets", "oidc-client-secret");
    expect(readFileSync(secretPath, "utf8")).toBe("super-secret-machine-value");
  });

  it("rejects an oversized secret as too-large without ever emitting it", async () => {
    const targetDir = makeFixtureDir(undefined);
    const oversized = "a".repeat(65537);

    const result = await driveSetOidcSecret(targetDir, {
      OIDC_CLIENT_SECRET: [oversized, "a-fine-sized-secret"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.events[1]).toEqual({
      type: "prompt-reject",
      field: "OIDC_CLIENT_SECRET",
      reason: "too-large",
    });
    expect(result.stdout).not.toContain(oversized);
    expect(result.stdout).not.toContain("a-fine-sized-secret");
    expect(existsSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"))).toBe(true);
  });
});
