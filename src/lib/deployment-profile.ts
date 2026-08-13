import { readEnvironmentValue } from "./target-identity";

// Deployment-profile identity (issue #295 slice 5), ported from
// scripts/install.sh's `is_valid_local_model` and `current_deployment_profile`
// (install.sh:617-661). Guarantee numbers below cite
// docs/installer-guarantees.md, Part 1 / install.sh, and are re-asserted by
// name in src/lib/deployment-profile.test.ts.
//
// `choose_deployment_profile` and `check_local_ai_capacity`
// (install.sh:623-631,684-777) — the interactive TTY wizard for *changing*
// the optional-service profile, including the host-capacity advisory and the
// separate model-download confirmation dialog (guarantee #20) — are
// intentionally not ported here. install-orchestrator.ts (this slice) always
// drives the CLI through `resolve_installer_action`'s own non-interactive
// branch (install.sh:826-841: preserve the existing profile on update,
// always "standard" on a fresh install), which is the one branch of
// `resolve_installer_action` that never calls `choose_deployment_profile` at
// all. This is not a narrowed guarantee — it is the exact behaviour
// install.sh itself already exhibits for any non-interactive invocation
// (`--plain`, or no controlling terminal) today: a non-interactive install.sh
// run can only ever produce the "standard" profile, and can never change an
// existing deployment's profile. See docs/adr-notes/295-install-port-plan.md's
// Flags section for the full reasoning and what a future slice would need to
// add (an explicit `--profile`/`--model` CLI surface plus the guarantee #20
// download-confirmation flag) to reach parity with the *interactive* branch.

const LOCAL_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

/** is_valid_local_model (install.sh:617-621). */
export function isValidLocalModel(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && LOCAL_MODEL_PATTERN.test(value);
}

export type DeploymentProfile = "standard" | "processing" | "ai" | "full";

export type CurrentDeploymentProfileResult =
  | { ok: true; profile: DeploymentProfile }
  | { ok: false };

/**
 * current_deployment_profile (install.sh:632-661, guarantee #23): requires
 * the existing `COMPOSE_PROFILES`/`TIKA_URL`/`OLLAMA_MODEL` triple to exactly
 * match one of exactly four known-good combinations; any other combination —
 * including a missing `.env-orbit` (bash: `printf 'standard'` unconditionally
 * when the file doesn't exist) is handled below, but any other malformed
 * triple — is reported as `{ ok: false }` (bash: `return 1`), the same
 * "unsupported or ambiguous" signal `resolve_installer_action` fails closed
 * on (install.sh:826-829).
 */
export function currentDeploymentProfile(targetDir: string, environmentFileExists: boolean): CurrentDeploymentProfileResult {
  if (!environmentFileExists) return { ok: true, profile: "standard" };

  const profiles = readEnvironmentValue(targetDir, "COMPOSE_PROFILES") ?? "";
  const tikaUrl = readEnvironmentValue(targetDir, "TIKA_URL") ?? "";
  const model = readEnvironmentValue(targetDir, "OLLAMA_MODEL") ?? "";

  switch (profiles) {
    case "":
      return tikaUrl === "" && model === "" ? { ok: true, profile: "standard" } : { ok: false };
    case "processing":
      return tikaUrl === "http://orbit-tika:9998" && model === "" ? { ok: true, profile: "processing" } : { ok: false };
    case "ai":
      return tikaUrl === "" && isValidLocalModel(model) ? { ok: true, profile: "ai" } : { ok: false };
    case "processing,ai":
      return tikaUrl === "http://orbit-tika:9998" && isValidLocalModel(model) ? { ok: true, profile: "full" } : { ok: false };
    default:
      return { ok: false };
  }
}

export interface ProfileSelection {
  selectedProfile: DeploymentProfile;
  profileChange: boolean;
}

/**
 * The non-interactive branch of resolve_installer_action (install.sh:826-841,
 * the only branch reached when `terminal_fd` was never opened): preserve the
 * existing profile on `update` (`profile_change` stays 0); always "standard"
 * on `install` (`profile_change=1`). See the module comment above for why
 * this is the only branch install-orchestrator.ts drives.
 */
export function resolveNonInteractiveProfileSelection(
  installerAction: "install" | "update",
  existingProfile: DeploymentProfile,
): ProfileSelection {
  if (installerAction === "install") {
    return { selectedProfile: "standard", profileChange: true };
  }
  return { selectedProfile: existingProfile, profileChange: false };
}
