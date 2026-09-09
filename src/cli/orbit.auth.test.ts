import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";

/*
 * `orbit auth recovery-link` (#912, ADR-0022 §5) end to end: spawns the real
 * CLI entry point, mirroring orbit.configure.test.ts's own spawn convention
 * rather than importing the command function directly, because the contract
 * under test is what actually reaches the process's stdout/stderr/exit code
 * — not what a mocked call graph would report.
 *
 * The usage-error cases below need no database and always run. Everything
 * else needs a real PostgreSQL — the same one `pnpm test:integration`
 * disposes of afterwards — and is skipped when DATABASE_URL is not set
 * rather than failing, so a plain `pnpm exec vitest run` of this file stays
 * green on a host with no database. The instance-authority table is a
 * singleton, so tests using it run sequentially (Vitest's default within one
 * file) and each cleans up after itself.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = fileURLToPath(new URL("./orbit.ts", import.meta.url));
const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

function runCli(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): { status: number; stdout: string; stderr: string } {
  const result = failOnProcessDeadline(spawnSync("node", [tsx, cli, ...args], {
    encoding: "utf8",
    env: options.env ?? process.env,
    ...processGuard(),
  }), { label: "runCli" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("orbit auth: usage (no database needed)", () => {
  it("an unrecognised auth subcommand exits 2 with a usage message", () => {
    const result = runCli(["auth", "bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
    expect(result.stdout).toBe("");
  });

  it("a missing subcommand exits 2 with a usage message", () => {
    const result = runCli(["auth"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
  });

  it("an extra argument exits 2 with a usage message", () => {
    const result = runCli(["auth", "recovery-link", "extra"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage");
  });
});

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("orbit auth recovery-link (real database)", () => {
  afterEach(async () => {
    const { getDb } = await import("@/db");
    const { auditLog, credentialSetupTokens, instanceAuthority, localCredentials, sessions, users } = await import("@/db/schema");
    const db = getDb();
    await db.delete(auditLog);
    await db.delete(credentialSetupTokens);
    await db.delete(sessions);
    await db.delete(instanceAuthority);
    await db.delete(localCredentials);
    await db.delete(users);
  });

  afterAll(async () => {
    const { closeDatabase } = await import("@/db");
    await closeDatabase();
  });

  it("refuses with one bounded stderr message and nothing on stdout when instance_authority is empty", () => {
    const result = runCli(["auth", "recovery-link"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    const stderrLines = result.stderr.trim().split("\n");
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0].length).toBeGreaterThan(0);
  });

  it("prints exactly one URL, revokes the primary's sessions, writes recovery_link_issued, and the link consumes like a setup token", async () => {
    const { createLocalUser, consumeSetupToken } = await import("@/server/local-credentials");
    const { getDb } = await import("@/db");
    const { auditLog, sessions } = await import("@/db/schema");
    const { createSession } = await import("@/lib/auth/session");
    const { getAuthConfig } = await import("@/lib/env");
    const { hashPassword } = await import("@/lib/auth/password");

    const primary = await createLocalUser(
      { email: `primary-${randomUUID()}@example.invalid`, displayName: "Primary Administrator" },
      { bootstrap: true },
    );
    await createSession(primary.id, getAuthConfig());
    await createSession(primary.id, getAuthConfig());

    const result = runCli(["auth", "recovery-link"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const stdoutLines = result.stdout.split("\n").filter((line) => line.length > 0);
    expect(stdoutLines).toHaveLength(1);
    const url = stdoutLines[0];
    expect(url).toMatch(new RegExp(`^${getAuthConfig().appUrl.origin}/setup/`, "u"));
    const token = decodeURIComponent(url.split("/setup/")[1]);

    const remainingSessions = await getDb().select().from(sessions).where(eq(sessions.userId, primary.id));
    expect(remainingSessions).toHaveLength(0);

    const auditRows = await getDb()
      .select({ action: auditLog.action, actorUserId: auditLog.actorUserId })
      .from(auditLog)
      .where(eq(auditLog.entityId, primary.id));
    expect(auditRows.map((row) => row.action)).toContain("recovery_link_issued");
    expect(auditRows.find((row) => row.action === "recovery_link_issued")?.actorUserId).toBe(primary.id);
    // The token never appears in any audit row.
    expect(JSON.stringify(auditRows)).not.toContain(token);

    // Consumes like any other setup token (ADR-0022 §5): single use, sets
    // the password, and reports the `recovery` purpose slice 8's own
    // consumeSetupToken already tracks.
    const outcome = await consumeSetupToken(token, await hashPassword("a-freshly-chosen-recovery-password"));
    expect(outcome.userId).toBe(primary.id);
    expect(outcome.purpose).toBe("recovery");
    expect(outcome.replaced).toBe(false);

    await expect(consumeSetupToken(token, await hashPassword("a-second-attempt"))).rejects.toMatchObject({ code: "setup_token_invalid" });
  });

  it("a 6 minute old link is setup_token_invalid, enforced by consumeSetupToken's own expiry check", async () => {
    const { createLocalUser, consumeSetupToken } = await import("@/server/local-credentials");
    const { getDb } = await import("@/db");
    const { credentialSetupTokens } = await import("@/db/schema");
    const { hashPassword } = await import("@/lib/auth/password");

    const primary = await createLocalUser(
      { email: `primary-${randomUUID()}@example.invalid`, displayName: "Primary Administrator" },
      { bootstrap: true },
    );

    const result = runCli(["auth", "recovery-link"]);
    expect(result.status).toBe(0);
    const url = result.stdout.trim();
    const token = decodeURIComponent(url.split("/setup/")[1]);

    // Back-date the token's expiry by six minutes rather than sleeping five
    // — the CLI's own five-minute TTL is already RECOVERY_TOKEN_TTL_MS,
    // proven in local-credentials.test.ts; this proves consumeSetupToken
    // refuses a link that has aged past it.
    await getDb()
      .update(credentialSetupTokens)
      .set({ expiresAt: new Date(Date.now() - 6 * 60 * 1000) })
      .where(eq(credentialSetupTokens.userId, primary.id));

    await expect(consumeSetupToken(token, await hashPassword("a-password-arriving-too-late"))).rejects.toMatchObject({ code: "setup_token_invalid" });
  });
});
