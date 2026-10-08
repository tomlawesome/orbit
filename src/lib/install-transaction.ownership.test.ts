import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The install transaction runs inside the engine one-off as the image's root
// since #1212, so on rootful Docker everything it creates would be
// root-owned and the operator could no longer read their own .env-orbit.
// Every path it creates is handed to the operator (#1210 D5,
// src/lib/host-ownership.ts); this records each hand-over.

const handedOver: string[] = [];
vi.mock("./host-ownership", () => ({
  applyHostOwnership: (path: string) => {
    handedOver.push(path);
  },
}));

const { InstallTransaction } = await import("./install-transaction");

let targetDir: string;
beforeEach(() => {
  targetDir = mkdtempSync(join(tmpdir(), "orbit-install-tx-owner-"));
  handedOver.length = 0;
});
afterEach(() => {
  rmSync(targetDir, { recursive: true, force: true });
});

describe("InstallTransaction hands what it creates to the host operator (#1212, #1210 D5)", () => {
  it("covers the staging and rollback areas, staged files, their new parents, created directories and the commit marker", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://orbit.example.invalid\n", { mode: 0o600 });
    const transaction = InstallTransaction.begin(targetDir, [
      { path: ".env-orbit", type: "file" },
      { path: "scripts/configure.sh", type: "file" },
    ]);
    const staging = relative(targetDir, transaction.stagingDir);
    transaction.ensureManagedDirectory("scripts");
    transaction.writeStagedFile("scripts/configure.sh", "#!/usr/bin/env bash\n", 0o644);
    transaction.commitMove("scripts/configure.sh", "file");
    transaction.writeStagedFile(".env-orbit", "APP_URL=https://orbit.example.invalid\nX=1\n");
    transaction.commitMove(".env-orbit", "file");
    transaction.commit();
    const committedMarker = join(transaction.stagingDir, "committed");
    expect(readFileSync(committedMarker, "utf8")).toBe("");
    transaction.dispose();

    const seen = handedOver.map((path) => relative(targetDir, path));
    expect(seen).toEqual(
      expect.arrayContaining([
        ".orbit-engine.lock",
        staging,
        `${staging}/rollback`,
        `${staging}/rollback/original`,
        `${staging}/rollback/original/.env-orbit`,
        "scripts",
        `${staging}/scripts`,
        `${staging}/scripts/configure.sh`,
        `${staging}/.env-orbit`,
        `${staging}/committed`,
      ]),
    );
  });
});
