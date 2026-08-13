import type { ManagedPath } from "./install-transaction";

// The fixed deployment-asset allowlist (issue #295 slice 5), transcribed
// verbatim from scripts/install.sh's `deployment_assets` / `deployment_scripts`
// array literals and the `asset_directories`/`managed_paths` derivation loop
// (install.sh:1296-1332, guarantee #45). install.sh has no function wrapping
// this — it is inline array literals and a loop in the main flow — so
// deployment-assets.test.ts byte-compares this module's constants directly
// against the array literals awk-extracted from the real script, the same
// "extraction fails loudly if renamed" discipline every parity test in this
// port uses, rather than a behavioural bash-vs-TS comparison.

/**
 * install.sh:1313-1325's deployment_assets array, in the installer's own
 * fetch order. scripts/repair.sh and scripts/engine-check.sh were added by
 * issue #383's shipping-gap fix: both are operator-facing host scripts
 * meant to run directly against a deployed target (repair.sh's own header;
 * engine-check.sh's header states it works "exactly like configure.sh/
 * repair.sh"), so omitting them here left every deployed target without
 * `bash scripts/repair.sh`/`bash scripts/engine-check.sh` ever working.
 */
export const DEPLOYMENT_ASSETS: readonly string[] = [
  "docker-compose.yml",
  "docker-compose.mail.yml",
  "docker-compose.mail-alias-rotation.yml",
  ".env-orbit.example",
  "config/tika-config.xml",
  "scripts/configure.sh",
  "scripts/installer-ui.sh",
  "scripts/configuration.sh",
  "scripts/backup.sh",
  "scripts/restore.sh",
  "scripts/repair.sh",
  "scripts/engine-check.sh",
];

/** install.sh:1326-1334's deployment_scripts array — the subset that must pass `bash -n` before being sourced/executed (guarantee #45). */
export const DEPLOYMENT_SCRIPTS: readonly string[] = [
  "scripts/configure.sh",
  "scripts/installer-ui.sh",
  "scripts/configuration.sh",
  "scripts/backup.sh",
  "scripts/restore.sh",
  "scripts/repair.sh",
  "scripts/engine-check.sh",
];

export const ENVIRONMENT_FILE = ".env-orbit";
export const SECRETS_DIRECTORY = ".orbit-secrets";

/**
 * install.sh:1333-1341's asset_directories derivation: the distinct, non-"."
 * parent directory of each asset, in order of first appearance — never
 * `readdir`-sorted, so directory-creation order matches install.sh's own.
 */
export function deriveAssetDirectories(assets: readonly string[]): string[] {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const asset of assets) {
    const slashIndex = asset.lastIndexOf("/");
    if (slashIndex < 0) continue;
    const directory = asset.slice(0, slashIndex);
    if (!seen.has(directory)) {
      seen.add(directory);
      directories.push(directory);
    }
  }
  return directories;
}

/**
 * install.sh:1342's managed_paths: every deployment asset plus the
 * environment file and secrets directory — the exact set InstallTransaction
 * (slice 1) preflights, backs up, and can roll back.
 */
export function buildManagedPaths(assets: readonly string[]): ManagedPath[] {
  return [
    ...assets.map((path): ManagedPath => ({ path, type: "file" })),
    { path: ENVIRONMENT_FILE, type: "file" },
    { path: SECRETS_DIRECTORY, type: "directory" },
  ];
}
