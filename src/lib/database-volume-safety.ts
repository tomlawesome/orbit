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
// install.sh `bundled_compose_project_name`: the `name:` the bundled
// docker-compose.yml declares (#999, #1239).
const BUNDLED_COMPOSE_PROJECT_NAME = "orbit";
/** The `com.docker.compose.project.working_dir` label is a path: bounded like the other labels (#1570). */
const MAXIMUM_WORKING_DIR_LENGTH = 4096;

function trimTrailingSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/**
 * The `docker` calls `volume_belongs_to_deployment` makes, each returning
 * trimmed stdout on success or null for any non-zero exit / spawn failure
 * (bash: `... 2>/dev/null || return 2`). Format strings are documented per
 * method so a production adapter's `docker` invocation is unambiguous.
 */
export interface VolumeOwnershipAdapter {
  /** docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}' <candidateVolume> */
  inspectVolumeLabels(candidateVolume: string): string | null;
  /** docker ps -a --filter "volume=<candidateVolume>" --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.compose.project.working_dir"}}' (#1570: the last field is optional) */
  listContainersByVolume(candidateVolume: string): string | null;
  /** docker ps -a --filter "label=com.docker.compose.project=<project>" --format '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.compose.project.working_dir"}}' (#1570: the last field is optional) */
  listContainersByProject(project: string): string | null;
  /** docker inspect --format '{{.Config.Image}}' <containerId> */
  inspectContainerImage(containerId: string): string | null;
  /**
   * What the installer found out about a container's `working_dir` label folder
   * (#1570): whether it exists, and its physical path (`cd` into it, `pwd -P`;
   * null when it does not exist). Null when no fact was sent for the label,
   * which is read as a folder that exists elsewhere. Optional: an adapter
   * that cannot answer behaves as one that always answers null.
   */
  inspectWorkingDir?(label: string): { exists: boolean; physical: string | null } | null;
}

/**
 * Which proof failed (#1570). `other-folder` comes first when it applies: the
 * containers were created from another deployment folder, which explains
 * the others.
 */
export type VolumeNotProvenReason =
  | "other-folder"
  | "foreign-container"
  | "no-database-container"
  | "several-database-containers"
  | "no-app-container"
  | "several-app-containers"
  | "image-mismatch";

export type VolumeOwnershipOutcome =
  | { status: "proven"; project: string }
  /**
   * bash `return 1`: a docker fact was cleanly obtained but ownership could
   * not be proven. `folder` names the other folder (other-folder); `service`
   * the service that mounts the volume without being orbit-db, and `container`
   * that container's id (foreign-container).
   */
  | { status: "not-proven"; reason: VolumeNotProvenReason; folder?: string; service?: string; container?: string }
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
  updateFolder?: string | readonly string[],
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

  // #1570: the folder the containers were created from (their
  // `com.docker.compose.project.working_dir` label, the optional fourth
  // field), when it is not the one the update runs in. It is the first
  // reason given: containers of another folder explain every other proof
  // failing, and the operator's one step is to run the update there.
  // The update folder may be given as several spellings of one folder (its
  // physical and its logical path); another folder is one that matches none.
  const folderSpellings = updateFolder === undefined ? [] : typeof updateFolder === "string" ? [updateFolder] : updateFolder;
  const ownFolders = folderSpellings.length === 0 ? undefined : folderSpellings.map(trimTrailingSlashes);
  // A label is also this folder when its physical path is one of them; a label
  // naming a folder that no longer exists is a deployment that was moved or
  // renamed, not another folder, and the other proofs decide.
  const otherFolder = (workingDir: string): string | undefined => {
    if (ownFolders === undefined || workingDir === "" || ownFolders.includes(trimTrailingSlashes(workingDir))) return undefined;
    const folder = adapter.inspectWorkingDir?.(workingDir) ?? null;
    if (folder !== null && (!folder.exists || (folder.physical !== null && ownFolders.includes(trimTrailingSlashes(folder.physical))))) return undefined;
    return workingDir;
  };
  const inOtherFolder = (folder: string): VolumeOwnershipOutcome => ({ status: "not-proven", reason: "other-folder", folder });

  const dbContainers = adapter.listContainersByVolume(candidateVolume);
  if (dbContainers === null) return { status: "verify-error" };
  if (dbContainers.length > 65536) return { status: "verify-error" };
  let appContainers: string | null | undefined;
  /** A failed proof, unless another folder's container explains it; reads what has not been read yet, and only on this failure path. */
  const notProven = (reason: VolumeNotProvenReason, service?: string, container?: string): VolumeOwnershipOutcome => {
    if (ownFolders !== undefined) {
      if (appContainers === undefined) appContainers = adapter.listContainersByProject(volumeProject);
      for (const [listing, onlyService] of [[dbContainers, undefined], [appContainers, "orbit-app"]] as const) {
        for (const line of (listing ?? "").split("\n")) {
          const [id, project, containerService, workingDir] = splitPipeFields(line, 4);
          if (!CONTAINER_ID_PATTERN.test(id) || project !== volumeProject || workingDir.length > MAXIMUM_WORKING_DIR_LENGTH) continue;
          if (onlyService !== undefined && containerService !== onlyService) continue;
          const folder = otherFolder(workingDir);
          if (folder !== undefined) return inOtherFolder(folder);
        }
      }
    }
    return {
      status: "not-proven",
      reason,
      ...(service === undefined ? {} : { service }),
      ...(container === undefined ? {} : { container }),
    };
  };
  let dbCount = 0;
  for (const line of dbContainers.split("\n")) {
    const [dbId, dbProject, dbService, workingDir] = splitPipeFields(line, 4);
    if (dbId === "" && dbProject === "" && dbService === "" && workingDir === "") continue;
    if (!(CONTAINER_ID_PATTERN.test(dbId) && dbProject === volumeProject && workingDir.length <= MAXIMUM_WORKING_DIR_LENGTH)) {
      return { status: "verify-error" };
    }
    const folder = otherFolder(workingDir);
    if (folder !== undefined) return inOtherFolder(folder);
    if (dbService !== "orbit-db") return notProven("foreign-container", dbService, dbId);
    dbCount += 1;
  }
  if (dbCount === 0) return notProven("no-database-container");
  if (dbCount !== 1) return notProven("several-database-containers");

  appContainers ??= adapter.listContainersByProject(volumeProject);
  if (appContainers === null) return { status: "verify-error" };
  if (appContainers.length > 65536) return { status: "verify-error" };
  let appCount = 0;
  for (const line of appContainers.split("\n")) {
    const [appId, appProject, appService, workingDir] = splitPipeFields(line, 4);
    if (appId === "" && appProject === "" && appService === "" && workingDir === "") continue;
    if (!(CONTAINER_ID_PATTERN.test(appId) && appProject === volumeProject && workingDir.length <= MAXIMUM_WORKING_DIR_LENGTH)) {
      return { status: "verify-error" };
    }
    if (appService !== "orbit-app") continue;
    const folder = otherFolder(workingDir);
    if (folder !== undefined) return inOtherFolder(folder);
    appCount += 1;
    if (appCount !== 1) return notProven("several-app-containers");
    const appImage = adapter.inspectContainerImage(appId);
    if (appImage === null) return { status: "verify-error" };
    if (appImage.length > 4096) return { status: "verify-error" };
    if (!IMMUTABLE_IMAGE_PATTERN.test(appImage)) return { status: "verify-error" };
    if (appImage !== expectedImage) return notProven("image-mismatch");
  }
  if (appCount !== 1) return notProven("no-app-container");

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

/**
 * The Compose project a volume's labels name, when they read cleanly as an
 * Orbit database volume of a project other than `ownProject`; undefined
 * otherwise (unreadable, malformed, or this project's own).
 */
function anotherProjectsLabel(volume: string, ownProject: string, adapter: VolumeOwnershipAdapter): string | undefined {
  const labels = adapter.inspectVolumeLabels(volume);
  if (labels === null || labels.length > 256 || labels.includes("\n")) return undefined;
  const [project, key, extra] = splitPipeFields(labels, 3);
  if (!PROJECT_NAME_PATTERN.test(project) || key !== DATABASE_VOLUME_KEY || extra !== "") return undefined;
  if (volume !== `${project}_${DATABASE_VOLUME_KEY}` || project === ownProject) return undefined;
  return project;
}

/** Thrown wherever install.sh's verify_database_volume_safety calls `fail`. */
export class DatabaseVolumeSafetyRefusal extends Error {
  /**
   * `reason` (#1570) names the proof that failed; `action` is the next
   * action the failure outcome carries. Both are set when ownership was not
   * proven: running the same command again cannot change any of those facts,
   * so the action is never "retry".
   */
  constructor(
    message: string,
    readonly reason?: VolumeNotProvenReason,
    readonly action?: string,
  ) {
    super(message);
    this.name = "DatabaseVolumeSafetyRefusal";
  }
}

/** The action vocabulary's word for a failure no retry can clear (docs/engine-events.md, `abort`). */
const NOT_PROVEN_ACTION = "abort";

/**
 * One plain message per failed proof (#1570): the fact that did not match
 * and what the operator can do about it. It never suggests a Compose
 * command: run in the wrong folder, one recreated a database container from
 * an old compose file.
 */
function notProvenMessage(
  outcome: Extract<VolumeOwnershipOutcome, { status: "not-proven" }>,
  volume: string,
  updateFolder: string | readonly string[] | undefined,
): string {
  const refusing = "refusing to start Compose.";
  switch (outcome.reason) {
    case "other-folder":
      return `The running Orbit containers for the database volume ${volume} were created from another folder, ${outcome.folder}, not from ${typeof updateFolder === "string" ? updateFolder : (updateFolder?.at(-1) ?? "the folder this update runs in")}; ${refusing} Run the update in ${outcome.folder}, the folder that owns them.`;
    case "foreign-container": {
      // A plain docker-run container has no service label; its id is the only name it has.
      const mounter = outcome.service === "" ? `container ${outcome.container}, which has no Compose service label,` : `a container of service "${outcome.service}"`;
      return `Could not prove that the Orbit database volume ${volume} belongs to this deployment: ${mounter} mounts it, and only orbit-db may; ${refusing} Check which container that is (docker ps -a --filter volume=${volume}) and stop or remove it if it is not part of this deployment, then run the update again.`;
    }
    // A deployment taken down keeps its volume and loses both containers: the one step back is to start it again from its own folder, in words, never as a Compose command.
    case "no-database-container":
      return `Could not prove that the Orbit database volume ${volume} belongs to this deployment: no orbit-db container uses it; ${refusing} If you took this deployment's containers down, start the deployment again from the folder it was installed in, so that its orbit-db container mounts the volume, then run the update again. If the volume is left over from a deployment you removed, this folder cannot update onto it; do not remove the volume until you are sure its database is not needed.`;
    case "several-database-containers":
      return `Could not prove that the Orbit database volume ${volume} belongs to this deployment: more than one orbit-db container uses it; ${refusing} Check which orbit-db container is the live one (docker ps -a --filter volume=${volume}), remove the others, then run the update again.`;
    case "no-app-container":
      return `Could not prove that the Orbit database volume ${volume} belongs to this deployment: its Compose project has no orbit-app container; ${refusing} If you took this deployment's containers down, or removed the application container, start the deployment again from the folder it was installed in, then run the update again.`;
    case "several-app-containers":
      return `Could not prove that the Orbit database volume ${volume} belongs to this deployment: its Compose project has more than one orbit-app container; ${refusing} Check which orbit-app container is the live one, remove the others, then run the update again.`;
    case "image-mismatch":
      return `Could not prove that the Orbit database volume ${volume} belongs to this deployment: the running orbit-app was started from a different build than the ORBIT_IMAGE that .env-orbit names; ${refusing} Compare the running orbit-app container's image with ORBIT_IMAGE in .env-orbit, then run the update again once they name the same build.`;
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
  /** install.sh `compose_project_name_provisional` (#999) */
  composeProjectNameProvisional: boolean;
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
 * `updateFolder` (#1570) is the folder the update runs in; containers whose
 * `working_dir` label names another folder are refused as such.
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
  updateFolder?: string | readonly string[],
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
    composeProjectNameProvisional: derived.provisional,
  };

  // #1239: the projects this install may end up using. Before the bundled
  // compose file is staged the name is only the directory-based guess; once
  // staged it is replaced by that file's own `name:` (#999). Both are checked
  // now so the later re-derivation cannot reach a volume this preflight never
  // looked at.
  const scopeProjects = [nextState.composeProjectName];
  if (nextState.composeProjectNameProvisional) scopeProjects.push(BUNDLED_COMPOSE_PROJECT_NAME);

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
    // #1239: a fresh install is only blocked by the volume it would itself
    // attach to, <this install's Compose project>_orbit-db-data. Other
    // stacks' volumes are skipped silently. An existing deployment keeps the
    // broad search: its project may be a renamed one that only the volume's
    // labels can prove.
    if (nextState.targetWasEmpty && !scopeProjects.some((project) => volume === `${project}_${DATABASE_VOLUME_KEY}`)) {
      continue;
    }
    if (!(CANDIDATE_VOLUME_NAME_PATTERN.test(volume) && CANDIDATE_VOLUME_SUFFIX_PATTERN.test(volume))) {
      throw new DatabaseVolumeSafetyRefusal(
        "Could not verify the existing Orbit database volume; refusing to start Compose.",
      );
    }
    candidates.push(volume);
  }

  // #1261: an update whose project name is known (its own .env-orbit, or the
  // operator's COMPOSE_PROJECT_NAME) skips a volume labelled with another
  // Compose project that the ownership proof does not tie to this
  // deployment: it is another stack's -- a second deployment, a leftover
  // e2e run -- and could never be attached here anyway, since a different
  // project would refuse below. Everything else still counts: a volume
  // whose labels cannot be read, one the proof does tie to this deployment's
  // image (a genuinely ambiguous pair refuses as before), and every volume
  // while the project name is only a guess, when a renamed project is
  // provable by its labels alone.
  const expectedImage = readEnvironmentValue(targetDir, "ORBIT_IMAGE");
  if (!nextState.targetWasEmpty && nextState.composeProjectNameExplicit && expectedImage !== undefined && IMMUTABLE_IMAGE_PATTERN.test(expectedImage)) {
    const ownProject = nextState.composeProjectName;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const labelledProject = anotherProjectsLabel(candidates[index], ownProject, adapter);
      if (labelledProject === undefined) continue;
      if (evaluateVolumeOwnership(candidates[index], expectedImage, adapter).status === "proven") continue;
      candidates.splice(index, 1);
    }
  }

  if (candidates.length === 0) {
    return { ...nextState, databaseVolumeChecked: true };
  }
  if (nextState.targetWasEmpty) {
    // O1-S3: names the volume and the exact removal command, mirroring
    // install.sh's own fail() text exactly (candidates joined with a single
    // space, matching bash's "${candidates[*]}" under the default IFS) —
    // the normal case this now reaches is a volume a prior interruption's
    // own failure path could not remove, since on a fresh install nothing
    // else could have created it.
    const candidateList = candidates.join(" ");
    throw new DatabaseVolumeSafetyRefusal(
      `An existing Orbit database volume (${candidateList}) requires a recognized deployment with its preserved database credentials; refusing to start Compose. If this is leftover from a previous failed install rather than a deployment you want to keep, remove it first: docker volume rm -- ${candidateList}`,
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
  const ownership = evaluateVolumeOwnership(candidateVolume, oldImage, adapter, updateFolder);

  if (ownership.status === "not-proven") {
    throw new DatabaseVolumeSafetyRefusal(
      notProvenMessage(ownership, candidateVolume, updateFolder),
      ownership.reason,
      NOT_PROVEN_ACTION,
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
  // The project that owns the recognised volume is the deployment's real
  // identity, so it is never provisional: install.sh:659 clears the flag on
  // exactly this path, so that the later re-derivation (#999) cannot replace
  // a proven owner with the compose file's declared name and address a
  // project this host has not got.
  nextState = { ...nextState, composeProjectName: discoveredProject, composeProjectNameProvisional: false };

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
