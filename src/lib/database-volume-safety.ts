import { DATABASE_VOLUME_KEY, deriveComposeProjectName, readEnvironmentValue } from "./target-identity";

// Database-volume identity and safety (issue #295 slice 2), ported from
// scripts/install.sh's `volume_belongs_to_deployment` and
// `verify_database_volume_safety` (install.sh:464-586). Guarantee numbers
// below cite docs/installer-guarantees.md, Part 1 / install.sh, and are
// re-asserted by name in src/lib/database-volume-safety.test.ts.
//
// Unlike src/lib/target-identity.ts, these two bash functions make their
// decisions from a sequence of `docker` command outputs, several of them
// conditional on what an earlier call returned (e.g. the container whose
// image gets inspected depends on which container the *previous* `docker
// ps` call turned up as the sole `orbit-db`/`orbit-app` match). Precomputing
// every possible fact up front, the way config-contract.ts's
// OidcSecretFileFacts bundles independent filesystem stats, would mean
// either running docker calls nothing here uses or duplicating install.sh's
// own branching twice (once to decide which calls are needed, once inside
// this module to re-decide). Instead the *sequencing and decision* logic
// below is pure and synchronous, and each individual `docker` invocation is
// a single method on a caller-supplied adapter — the "thin adapter at the
// edge" the slice plan calls for. A production adapter shells out
// synchronously (mirroring bash's own blocking `$(docker ...)`); the parity
// test's adapter and the extracted bash both call the *same* stub `docker`
// script, so the two implementations are proven to make identical decisions
// from identical raw docker output, not just from identical pre-parsed facts.

const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/;
const IMMUTABLE_IMAGE_PATTERN = /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/;
const CANDIDATE_VOLUME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CANDIDATE_VOLUME_SUFFIX_PATTERN = /(^|_)orbit-db-data$/;

/**
 * The `docker` calls `volume_belongs_to_deployment` makes, each returning
 * trimmed stdout on success or null for any non-zero exit / spawn failure
 * (bash: `... 2>/dev/null || return 2`). Format strings are documented per
 * method so a production adapter's `docker` invocation is unambiguous.
 */
export interface VolumeOwnershipAdapter {
  /** docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}' <candidateVolume> */
  inspectVolumeLabels(candidateVolume: string): string | null;
  /** docker ps -a --filter "volume=<candidateVolume>" --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}' */
  listContainersByVolume(candidateVolume: string): string | null;
  /** docker ps -a --filter "label=com.docker.compose.project=<project>" --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}' */
  listContainersByProject(project: string): string | null;
  /** docker inspect --format '{{.Config.Image}}' <containerId> */
  inspectContainerImage(containerId: string): string | null;
}

export type VolumeOwnershipOutcome =
  | { status: "proven"; project: string }
  /** bash `return 1`: a docker fact was cleanly obtained but ownership could not be proven. */
  | { status: "not-proven" }
  /** bash `return 2`: a docker call failed, or its output failed format/bounds validation — untrusted, not just unproven. */
  | { status: "verify-error" };

function splitPipeFields(line: string, fieldCount: number): string[] {
  // Mirrors `IFS='|' read -r a b c... <<< "$line"`: the first fieldCount-1
  // vars each take one pipe-delimited field (empty string if the line has
  // fewer fields, exactly like read leaving trailing unassigned vars
  // empty), and the last var takes whatever remains verbatim, including any
  // further pipe characters — never re-split.
  const parts = line.split("|");
  const head: string[] = [];
  for (let index = 0; index < fieldCount - 1; index += 1) {
    head.push(parts[index] ?? "");
  }
  const rest = parts.length > fieldCount - 1 ? parts.slice(fieldCount - 1).join("|") : "";
  return [...head, rest];
}

/**
 * volume_belongs_to_deployment (install.sh:464-520, guarantees #13-14):
 * proves ownership of a pre-existing database volume with several
 * independent checks before trusting it — exact Compose project/volume-name
 * label match, exactly one `orbit-db` container attached to the volume in
 * that project, exactly one `orbit-app` container in that project, and that
 * container's image must be digest-pinned and match the expected image
 * exactly. All consumed docker output is bounds-checked (length caps,
 * single-line, strict field regexes) before being trusted; any ambiguity,
 * extra container, mismatched image, or malformed docker output fails
 * closed rather than being assumed safe.
 */
export function evaluateVolumeOwnership(
  candidateVolume: string,
  expectedImage: string,
  adapter: VolumeOwnershipAdapter,
): VolumeOwnershipOutcome {
  const volumeLabels = adapter.inspectVolumeLabels(candidateVolume);
  if (volumeLabels === null) return { status: "verify-error" };
  if (volumeLabels.length > 256) return { status: "verify-error" };
  if (volumeLabels.includes("\n")) return { status: "verify-error" };
  const [volumeProject, volumeKey, extra] = splitPipeFields(volumeLabels, 3);
  if (
    !(
      volumeProject !== "" &&
      PROJECT_NAME_PATTERN.test(volumeProject) &&
      volumeKey === DATABASE_VOLUME_KEY &&
      candidateVolume === `${volumeProject}_${DATABASE_VOLUME_KEY}` &&
      extra === ""
    )
  ) {
    return { status: "verify-error" };
  }

  const dbContainers = adapter.listContainersByVolume(candidateVolume);
  if (dbContainers === null) return { status: "verify-error" };
  if (dbContainers.length > 65536) return { status: "verify-error" };
  let dbCount = 0;
  for (const line of dbContainers.split("\n")) {
    const [dbId, dbProject, dbService, extraField] = splitPipeFields(line, 4);
    if (dbId === "" && dbProject === "" && dbService === "" && extraField === "") continue;
    if (!(CONTAINER_ID_PATTERN.test(dbId) && dbProject === volumeProject && extraField === "")) {
      return { status: "verify-error" };
    }
    if (dbService !== "orbit-db") return { status: "not-proven" };
    dbCount += 1;
  }
  if (dbCount !== 1) return { status: "not-proven" };

  const appContainers = adapter.listContainersByProject(volumeProject);
  if (appContainers === null) return { status: "verify-error" };
  if (appContainers.length > 65536) return { status: "verify-error" };
  let appCount = 0;
  for (const line of appContainers.split("\n")) {
    const [appId, appProject, appService, extraField] = splitPipeFields(line, 4);
    if (appId === "" && appProject === "" && appService === "" && extraField === "") continue;
    if (!(CONTAINER_ID_PATTERN.test(appId) && appProject === volumeProject && extraField === "")) {
      return { status: "verify-error" };
    }
    if (appService !== "orbit-app") continue;
    appCount += 1;
    if (appCount !== 1) return { status: "not-proven" };
    const appImage = adapter.inspectContainerImage(appId);
    if (appImage === null) return { status: "verify-error" };
    if (appImage.length > 4096) return { status: "verify-error" };
    if (!IMMUTABLE_IMAGE_PATTERN.test(appImage)) return { status: "verify-error" };
    if (appImage !== expectedImage) return { status: "not-proven" };
  }
  if (appCount !== 1) return { status: "not-proven" };

  return { status: "proven", project: volumeProject };
}

/** The additional docker calls verify_database_volume_safety itself makes, beyond volume ownership. */
export interface DatabaseVolumeSafetyAdapter extends VolumeOwnershipAdapter {
  /** docker volume ls --filter "name=^<name>\$" --format '{{.Name}}' */
  listVolumesExactName(name: string): string | null;
  /** docker volume ls --filter "name=<key>" --format '{{.Name}}' */
  listVolumesByKeySubstring(key: string): string | null;
  /** docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' <name> */
  inspectVolumeProjectLabel(name: string): string | null;
}

/** Thrown wherever install.sh's verify_database_volume_safety calls `fail`. */
export class DatabaseVolumeSafetyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseVolumeSafetyRefusal";
  }
}

export interface DatabaseVolumeSafetyState {
  /** install.sh `database_volume_checked` */
  databaseVolumeChecked: boolean;
  /** install.sh `database_volume_seen` */
  databaseVolumeSeen: boolean;
  /** install.sh `database_volume_name` */
  databaseVolumeName: string;
  /** install.sh `target_was_empty` (from target-identity.ts's validateTarget) */
  targetWasEmpty: boolean;
  /** install.sh `compose_project_name_explicit` */
  composeProjectNameExplicit: boolean;
  /** install.sh `compose_project_name` */
  composeProjectName: string;
}

export interface PostgresPasswordFacts {
  isRegularNonSymlinkFile: boolean;
  mode: number | null;
}

/**
 * verify_database_volume_safety (install.sh:522-586, guarantees #15-18):
 * refuses to proceed if an existing database volume is found against an
 * otherwise-empty target (never silently attach to somebody else's
 * pre-existing database), refuses if more than one candidate volume exists
 * (never guesses which to use), and once a volume has been verified in this
 * run, re-verifies on every subsequent call that the *same* single volume
 * still exists (a TOCTOU guard). Attaching to a proven volume additionally
 * requires the preserved `postgres-password` secret file at exactly mode
 * 600. Returns the updated state (mirrors install.sh's globals); throws
 * DatabaseVolumeSafetyRefusal with install.sh's exact `fail` message
 * wherever install.sh would exit non-zero.
 *
 * `verify_database_password_preserved` (install.sh:588-595, guarantee #19,
 * comparing the live secret against the slice-1 transaction's own backup)
 * is intentionally out of scope here — it depends on
 * InstallTransaction.originalDir from src/lib/install-transaction.ts, which
 * this module has no reason to import; wiring the two together belongs to
 * the orchestration slice that drives a real installation. See
 * docs/adr-notes/295-install-port-plan.md.
 */
export function verifyDatabaseVolumeSafety(
  targetDir: string,
  requestedComposeProjectName: string | undefined,
  fallbackBasename: string,
  state: DatabaseVolumeSafetyState,
  postgresPasswordFacts: PostgresPasswordFacts,
  adapter: DatabaseVolumeSafetyAdapter,
): DatabaseVolumeSafetyState {
  if (state.databaseVolumeChecked) {
    if (!state.databaseVolumeSeen) return state;
    const volumeList = adapter.listVolumesExactName(state.databaseVolumeName);
    if (volumeList === null) {
      throw new DatabaseVolumeSafetyRefusal(
        "Could not verify the existing Orbit database volume; refusing to start Compose.",
      );
    }
    if (!(volumeList === state.databaseVolumeName && !volumeList.includes("\n"))) {
      throw new DatabaseVolumeSafetyRefusal(
        "The existing Orbit database volume changed during installation; refusing to start Compose.",
      );
    }
    return state;
  }

  const derived = deriveComposeProjectName(targetDir, requestedComposeProjectName, fallbackBasename);
  let nextState: DatabaseVolumeSafetyState = {
    ...state,
    composeProjectName: derived.composeProjectName,
    composeProjectNameExplicit: derived.explicit,
  };

  const volumeList = adapter.listVolumesByKeySubstring(DATABASE_VOLUME_KEY);
  if (volumeList === null) {
    throw new DatabaseVolumeSafetyRefusal(
      "Could not verify the existing Orbit database volume; refusing to start Compose.",
    );
  }
  if (volumeList.length > 1048576) {
    throw new DatabaseVolumeSafetyRefusal(
      "Could not verify the existing Orbit database volume; refusing to start Compose.",
    );
  }

  const candidates: string[] = [];
  for (const volume of volumeList.split("\n")) {
    if (volume === "") continue;
    if (!volume.endsWith(DATABASE_VOLUME_KEY)) continue;
    if (!(CANDIDATE_VOLUME_NAME_PATTERN.test(volume) && CANDIDATE_VOLUME_SUFFIX_PATTERN.test(volume))) {
      throw new DatabaseVolumeSafetyRefusal(
        "Could not verify the existing Orbit database volume; refusing to start Compose.",
      );
    }
    candidates.push(volume);
  }

  if (candidates.length === 0) {
    return { ...nextState, databaseVolumeChecked: true };
  }
  if (nextState.targetWasEmpty) {
    throw new DatabaseVolumeSafetyRefusal(
      "An existing Orbit database volume requires a recognized deployment with its preserved database credentials; refusing to start Compose.",
    );
  }
  if (candidates.length !== 1) {
    throw new DatabaseVolumeSafetyRefusal(
      "Multiple Orbit database volumes were found; refusing to start Compose until exactly one recognized deployment can be proven.",
    );
  }

  const oldImage = readEnvironmentValue(targetDir, "ORBIT_IMAGE");
  if (oldImage === undefined || !IMMUTABLE_IMAGE_PATTERN.test(oldImage)) {
    throw new DatabaseVolumeSafetyRefusal(
      "Could not verify the existing Orbit database volume ownership; refusing to start Compose.",
    );
  }

  const candidateVolume = candidates[0];
  const ownership = evaluateVolumeOwnership(candidateVolume, oldImage, adapter);

  if (ownership.status === "not-proven") {
    throw new DatabaseVolumeSafetyRefusal(
      "Could not prove that the existing Orbit database volume belongs to this Orbit deployment; refusing to start Compose.",
    );
  }
  if (ownership.status === "verify-error") {
    throw new DatabaseVolumeSafetyRefusal(
      "Could not verify the existing Orbit database volume ownership; refusing to start Compose.",
    );
  }

  const discoveredProject = adapter.inspectVolumeProjectLabel(candidateVolume);
  if (discoveredProject === null || !PROJECT_NAME_PATTERN.test(discoveredProject)) {
    throw new DatabaseVolumeSafetyRefusal(
      "Could not verify the existing Orbit database volume ownership; refusing to start Compose.",
    );
  }
  if (nextState.composeProjectNameExplicit && nextState.composeProjectName !== discoveredProject) {
    throw new DatabaseVolumeSafetyRefusal(
      "The configured Docker Compose project does not match the recognized database volume; refusing to start Compose.",
    );
  }
  // install.sh:573 only assigns compose_project_name here — it deliberately
  // never sets compose_project_name_explicit=1 on this path; the flag keeps
  // whatever derive_compose_project_name (guarantee #12) already gave it
  // earlier in this same call (1 only if a configured-file or requested
  // name was involved, 0 if the fallback working-directory basename was
  // used). Setting it here was an early mistake in this port, caught by
  // database-volume-safety.parity.test.ts's byte-for-byte comparison
  // against the real script's globals after a successful attach.
  nextState = { ...nextState, composeProjectName: discoveredProject };

  if (!(postgresPasswordFacts.isRegularNonSymlinkFile && postgresPasswordFacts.mode === 0o600)) {
    throw new DatabaseVolumeSafetyRefusal(
      "An existing Orbit database volume requires the preserved POSTGRES_PASSWORD_FILE; refusing to start Compose.",
    );
  }

  return {
    ...nextState,
    databaseVolumeChecked: true,
    databaseVolumeSeen: true,
    databaseVolumeName: candidateVolume,
  };
}
