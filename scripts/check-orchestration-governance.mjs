import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const canonicalPolicyUrl = new URL("../.github/orchestration-governance.json", import.meta.url);
const canonicalControlsUrl = new URL("../docs/orchestration-controls.json", import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(`Orchestration governance: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function hasExactStrings(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && expected.every((entry) => value.includes(entry));
}

function readJson(urlOrPath) {
  return JSON.parse(readFileSync(urlOrPath, "utf8"));
}

export function validateOrchestrationPolicy(policy) {
  assert(isObject(policy), "policy must be an object.");
  assert(policy.schemaVersion === 1, "unsupported policy schema version.");
  assert(isObject(policy.modelAuthority), "modelAuthority is required.");
  for (const role of ["orchestration", "protectedPlanning", "implementation", "mechanicalAnalysis"]) {
    assert(
      Array.isArray(policy.modelAuthority[role]) && policy.modelAuthority[role].every(isNonEmptyString),
      `modelAuthority.${role} must be a non-empty string array.`,
    );
  }
  assert(
    policy.modelAuthority.orchestration.length === 1
      && policy.modelAuthority.orchestration[0] === "Sol Extra High",
    "orchestration must be reserved to Sol Extra High.",
  );
  assert(
    policy.modelAuthority.protectedPlanning.length === 1
      && policy.modelAuthority.protectedPlanning[0] === "Sol Extra High",
    "protected planning must be reserved to Sol Extra High.",
  );
  assert(
    policy.modelAuthority.implementation.length === 1
      && policy.modelAuthority.implementation[0] === "Luna Extra High",
    "bounded implementation must default to Luna Extra High.",
  );
  assert(
    Array.isArray(policy.protectedDecisionClasses)
      && policy.protectedDecisionClasses.includes("protected_planning")
      && policy.protectedDecisionClasses.includes("model_governance"),
    "protected decision classes are incomplete.",
  );
  assert(
    Array.isArray(policy.taskStatusSources)
      && ["create_thread", "list_threads_full", "read_thread", "wait_threads"]
        .every((source) => policy.taskStatusSources.includes(source)),
    "task status sources are incomplete.",
  );
  const access = policy.remoteAccessPreflight;
  assert(isObject(access), "remoteAccessPreflight is required.");
  assert(
    access.connectorMountProof === "live_connector_call",
    "connector mounting must be proven by a live connector call.",
  );
  assert(
    access.sshRefProof === "ssh_exact_ref_read",
    "SSH reachability must be proven by an exact non-mutating ref read.",
  );
  assert(
    hasExactStrings(access.cliReadProofs, [
      "cli_auth_status",
      "repository_read",
      "issues_read",
      "pull_requests_read",
      "actions_read",
    ]),
    "CLI preflight proofs are incomplete.",
  );
  assert(
    hasExactStrings(access.actionClasses, [
      "repository_read",
      "issue_read",
      "pull_request_read",
      "actions_read",
      "git_fetch",
      "git_push",
      "issue_write",
      "pull_request_write",
      "protected_merge",
    ]),
    "remote action classes are incomplete.",
  );
  assert(
    hasExactStrings(access.capabilityStates, ["available", "unavailable", "untested"]),
    "remote capability states are incomplete.",
  );
  assert(
    Array.isArray(access.routeOrder)
      && access.routeOrder.join(",") === "connector,cli,browser_user_controlled",
    "remote access routing must be connector first, CLI second, and user-controlled browser last.",
  );
  assert(
    hasExactStrings(access.protectedWriteClasses, ["pull_request_write", "protected_merge"]),
    "protected write classes are incomplete.",
  );
  assert(
    hasExactStrings(access.writeEvidenceKinds, [
      "authenticated_write_capability",
      "endpoint_write_success",
    ]),
    "authenticated write evidence kinds are incomplete.",
  );
  assert(
    access.rejectInstalledMetadataAsMountProof === true,
    "installed plugin metadata must not prove connector mounting.",
  );
  assert(
    access.rejectOwnershipOrPublicReadAsWriteProof === true,
    "repository ownership or public reads must not prove write capability.",
  );
  assert(
    access.failClosedBeforeDependentLaunch === true,
    "dependent delivery must fail closed without a protected write path.",
  );
  assert(access.secretsInChat === false, "credential or session material must never enter chat.");
  assert(
    Array.isArray(policy.deliveryStages) && policy.deliveryStages.length > 0,
    "deliveryStages are required.",
  );
  assert(isObject(policy.allowedTransitions), "allowedTransitions are required.");
  for (const stage of policy.deliveryStages) {
    const transitions = policy.allowedTransitions[stage];
    assert(Array.isArray(transitions), `transitions for ${stage} are required.`);
    assert(
      transitions.every((next) => policy.deliveryStages.includes(next)),
      `transitions for ${stage} contain an unknown stage.`,
    );
  }
  assert(isObject(policy.learning), "learning policy is required.");
  assert(policy.learning.automaticCandidateCapture === true, "candidate capture must be enabled.");
  assert(policy.learning.automaticAdoption === false, "durable control adoption must require review.");
  assert(
    Number.isInteger(policy.learning.minimumEvidenceForAdoption)
      && policy.learning.minimumEvidenceForAdoption >= 2,
    "adopted controls require at least two evidence records.",
  );
  assert(
    Array.isArray(policy.learning.prohibitedAutomaticClasses)
      && policy.protectedDecisionClasses.every(
        (decisionClass) => policy.learning.prohibitedAutomaticClasses.includes(decisionClass),
      ),
    "every protected decision class must prohibit automatic adoption.",
  );
}

function authorityRole(role) {
  return {
    orchestration: "orchestration",
    protected_planning: "protectedPlanning",
    implementation: "implementation",
    mechanical_analysis: "mechanicalAnalysis",
  }[role];
}

function validateActor(actor, policy) {
  assert(isObject(actor), "actor is required.");
  assert(isNonEmptyString(actor.model), "actor.model is required.");
  const policyRole = authorityRole(actor.role);
  assert(policyRole, `unknown actor role ${String(actor.role)}.`);
  assert(
    policy.modelAuthority[policyRole].includes(actor.model),
    `${actor.model} is not authorized for ${actor.role}.`,
  );
}

function validateLaunchReceipt(receipt, policy, requestedModel, baseSha) {
  assert(isObject(receipt), "task launch receipt is required.");
  assert(policy.taskStatusSources.includes(receipt.source), "unknown launch receipt source.");
  assert(receipt.source === "create_thread", "task launch receipts must come from create_thread.");
  assert(
    isNonEmptyString(receipt.threadId) || isNonEmptyString(receipt.clientThreadId),
    "task launch receipt requires threadId or clientThreadId.",
  );
  assert(receipt.requestedModel === requestedModel, "launch receipt model does not match requested model.");
  assert(receipt.baseSha === baseSha, "launch receipt base does not match accepted delivery base.");
  assert(isTimestamp(receipt.observedAt), "task launch receipt requires an observation timestamp.");
}

function validateAuthoritativeTaskStatus(status, policy) {
  assert(isObject(status), "authoritative task status is required.");
  assert(policy.taskStatusSources.includes(status.source), "unknown task status source.");
  assert(status.source !== "create_thread", "create_thread is a receipt, not authoritative task status.");
  assert(isNonEmptyString(status.status), "task status is required.");
  assert(isTimestamp(status.observedAt), "task status requires an observation timestamp.");
}

function validateRemoteAccessPreflight(preflight, policy) {
  const access = policy.remoteAccessPreflight;
  assert(isObject(preflight), "remote access preflight is required.");
  assert(isTimestamp(preflight.observedAt), "remote access preflight requires an observation timestamp.");

  assert(isObject(preflight.connector), "connector preflight is required.");
  assert(typeof preflight.connector.mounted === "boolean", "connector mounted state is required.");
  if (preflight.connector.mounted) {
    assert(
      preflight.connector.proof === access.connectorMountProof,
      "connector mounting requires a live connector call.",
    );
  } else {
    assert(
      preflight.connector.proof === "unavailable_result",
      "an unavailable connector requires an explicit unavailable result.",
    );
  }

  assert(isObject(preflight.ssh), "SSH preflight is required.");
  assert(typeof preflight.ssh.reachable === "boolean", "SSH reachability state is required.");
  if (preflight.ssh.reachable) {
    assert(
      preflight.ssh.proof === access.sshRefProof,
      "SSH reachability requires an exact non-mutating ref read.",
    );
    assert(
      Array.isArray(preflight.ssh.refs) && preflight.ssh.refs.length > 0,
      "SSH reachability requires exact remote refs.",
    );
    for (const ref of preflight.ssh.refs) {
      assert(isObject(ref), "each SSH ref proof must be an object.");
      assert(
        typeof ref.name === "string" && /^refs\/(heads|tags)\/[^ \u0000-\u001f]+$/u.test(ref.name),
        "SSH ref proof requires an exact heads or tags ref.",
      );
      assert(isSha(ref.sha), "SSH ref proof requires an exact commit SHA.");
    }
  } else {
    assert(
      preflight.ssh.proof === "unavailable_result",
      "unavailable SSH requires an explicit unavailable result.",
    );
  }

  assert(isObject(preflight.cli), "CLI preflight is required.");
  assert(preflight.cli.checked === true, "CLI account and read capability checks are required.");
  assert(
    typeof preflight.cli.accountVerified === "boolean",
    "CLI account verification result is required.",
  );
  assert(preflight.cli.proof === "cli_auth_status", "CLI account must be checked with auth status.");
  assert(
    preflight.cli.credentialMaterialRecorded === false,
    "CLI credential material must not be recorded.",
  );
  assert(isObject(preflight.cli.readCapabilities), "CLI read capability results are required.");
  for (const capability of access.cliReadProofs.filter((proof) => proof !== "cli_auth_status")) {
    assert(
      access.capabilityStates.includes(preflight.cli.readCapabilities[capability]),
      `CLI ${capability} capability result is invalid.`,
    );
  }

  assert(isObject(preflight.browser), "browser fallback state is required.");
  assert(
    typeof preflight.browser.userControlled === "boolean",
    "browser fallback control state is required.",
  );

  assert(Array.isArray(preflight.capabilities), "remote action capabilities are required.");
  const capabilities = new Map();
  for (const capability of preflight.capabilities) {
    assert(isObject(capability), "each remote action capability must be an object.");
    assert(
      access.actionClasses.includes(capability.actionClass),
      `unknown remote action class ${String(capability.actionClass)}.`,
    );
    assert(
      !capabilities.has(capability.actionClass),
      `duplicate remote action class ${capability.actionClass}.`,
    );
    assert(
      access.capabilityStates.includes(capability.status),
      `${capability.actionClass} capability status is invalid.`,
    );
    assert(
      access.routeOrder.includes(capability.route),
      `${capability.actionClass} capability route is invalid.`,
    );
    assert(isNonEmptyString(capability.evidenceKind), `${capability.actionClass} evidence is required.`);
    if (
      capability.status === "available"
      && [
        "git_push",
        "issue_write",
        "pull_request_write",
        "protected_merge",
      ].includes(capability.actionClass)
    ) {
      assert(
        access.writeEvidenceKinds.includes(capability.evidenceKind),
        "protected write capability requires authenticated write evidence.",
      );
    }
    if (capability.status === "available" && capability.route === "browser_user_controlled") {
      assert(
        preflight.browser.userControlled === true,
        "browser fallback must remain explicitly user-controlled.",
      );
    }
    capabilities.set(capability.actionClass, capability);
  }
  assert(
    capabilities.size === access.actionClasses.length
      && access.actionClasses.every((actionClass) => capabilities.has(actionClass)),
    "every remote action class must record available, unavailable, or untested state.",
  );
  return capabilities;
}

export function validateOperationalState(state, policy) {
  validateOrchestrationPolicy(policy);
  assert(isObject(state), "operational state must be an object.");
  assert(state.schemaVersion === 1, "unsupported operational-state schema version.");
  validateActor(state.actor, policy);
  const remoteCapabilities = validateRemoteAccessPreflight(state.accessPreflight, policy);
  assert(isObject(state.delivery), "delivery state is required.");

  const delivery = state.delivery;
  assert(Number.isInteger(delivery.issue) && delivery.issue > 0, "delivery issue is required.");
  assert(
    typeof delivery.repository === "string"
      && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(delivery.repository),
    "delivery repository must use owner/name form.",
  );
  assert(policy.deliveryStages.includes(delivery.stage), "delivery stage is invalid.");
  if (delivery.previousStage) {
    assert(policy.deliveryStages.includes(delivery.previousStage), "previous delivery stage is invalid.");
    assert(
      policy.allowedTransitions[delivery.previousStage].includes(delivery.stage),
      `${delivery.previousStage} -> ${delivery.stage} is not an allowed transition.`,
    );
  }
  if (delivery.stage !== "planned") {
    assert(isSha(delivery.baseSha), "accepted base SHA is required after planning.");
    assert(isNonEmptyString(delivery.branch), "delivery branch is required after planning.");
  }

  const taskStages = new Set(["launch_pending", "active", "handback", "sol_review"]);
  const protectedWriteStages = new Set(["launch_pending", "active", "handback", "sol_review", "pr_open"]);
  if (
    policy.remoteAccessPreflight.failClosedBeforeDependentLaunch
    && protectedWriteStages.has(delivery.stage)
  ) {
    assert(
      policy.remoteAccessPreflight.protectedWriteClasses.every(
        (actionClass) => remoteCapabilities.get(actionClass)?.status === "available",
      ),
      "protected write path is unavailable; do not launch or advance dependent delivery.",
    );
  }
  if (taskStages.has(delivery.stage)) {
    assert(isObject(delivery.task), `${delivery.stage} delivery requires task state.`);
    assert(
      policy.modelAuthority.implementation.includes(delivery.task.requestedModel),
      `requested task model ${String(delivery.task.requestedModel)} is not authorized for implementation.`,
    );
    validateLaunchReceipt(
      delivery.task.launchReceipt,
      policy,
      delivery.task.requestedModel,
      delivery.baseSha,
    );
  }

  if (delivery.stage === "active") {
    assert(
      isObject(delivery.task.authoritativeStatus),
      "active delivery requires authoritative task status.",
    );
    validateAuthoritativeTaskStatus(delivery.task.authoritativeStatus, policy);
    assert(
      delivery.task.authoritativeStatus.baseSha === delivery.baseSha,
      "task base does not match accepted delivery base.",
    );
    assert(
      delivery.task.authoritativeStatus.status === "active",
      "active delivery requires an active authoritative task observation.",
    );
    assert(isNonEmptyString(delivery.task.authoritativeStatus.threadId), "active task requires threadId.");
    assert(isNonEmptyString(delivery.task.authoritativeStatus.worktree), "active task requires worktree.");
  }

  if (delivery.stage === "handback" || delivery.stage === "sol_review") {
    validateAuthoritativeTaskStatus(delivery.task.authoritativeStatus, policy);
    assert(
      delivery.task.authoritativeStatus.baseSha === delivery.baseSha,
      "task base does not match accepted delivery base.",
    );
    assert(
      ["idle", "complete", "needs_attention"].includes(delivery.task.authoritativeStatus.status),
      `${delivery.stage} requires a terminal or attention task observation.`,
    );
    assert(isNonEmptyString(delivery.resultPath), `${delivery.stage} requires a result handoff path.`);
    assert(
      Array.isArray(delivery.localCommits) && delivery.localCommits.length > 0
        && delivery.localCommits.every(isSha),
      `${delivery.stage} requires focused local commit SHAs.`,
    );
  }

  if (delivery.stage === "blocked") {
    assert(isObject(delivery.blocker), "blocked delivery requires blocker evidence.");
    if (
      delivery.blocker.kind === "inferred_absence"
      || delivery.task?.authoritativeStatus?.status === "absent"
    ) {
      throw new Error("Orchestration governance: task absence is not failure evidence; keep launch pending.");
    }
    assert(
      Array.isArray(delivery.blocker.evidence) && delivery.blocker.evidence.length > 0,
      "blocked delivery requires safe evidence.",
    );
    const immediateHardBlocks = new Set([
      "authority_required",
      "creation_error",
      "irreversible_decision",
      "provider_access_required",
      "secrets_required",
    ]);
    assert(
      immediateHardBlocks.has(delivery.blocker.kind)
        || (Number.isInteger(delivery.blocker.attempts) && delivery.blocker.attempts >= 3),
      "recoverable blockers require three evidenced attempts.",
    );
  }
}

export function validateAdoptedControls(ledger, policy) {
  validateOrchestrationPolicy(policy);
  assert(isObject(ledger), "control ledger must be an object.");
  assert(ledger.schemaVersion === 1, "unsupported control-ledger schema version.");
  assert(Array.isArray(ledger.controls), "control ledger requires controls.");
  const ids = new Set();
  for (const control of ledger.controls) {
    assert(isObject(control), "each control must be an object.");
    assert(/^ORCH-[0-9A-Z-]+$/u.test(control.id), "control id is invalid.");
    assert(!ids.has(control.id), `duplicate control id ${control.id}.`);
    ids.add(control.id);
    assert(["candidate", "adopted", "retired"].includes(control.status), `${control.id} status is invalid.`);
    assert(isNonEmptyString(control.decisionClass), `${control.id} decisionClass is required.`);
    assert(isNonEmptyString(control.summary), `${control.id} summary is required.`);
    assert(Array.isArray(control.evidence), `${control.id} evidence must be an array.`);
    if (control.automaticPromotion) {
      throw new Error(`Orchestration governance: ${control.id} automatic adoption is prohibited.`);
    }
    if (control.status === "adopted") {
      assert(
        control.evidence.length >= policy.learning.minimumEvidenceForAdoption,
        `${control.id} has insufficient evidence for adoption.`,
      );
      assert(Number.isInteger(control.issue) && control.issue > 0, `${control.id} requires an issue.`);
      assert(
        Number.isInteger(control.pullRequest) && control.pullRequest > 0,
        `${control.id} requires a pull request.`,
      );
      if (policy.protectedDecisionClasses.includes(control.decisionClass)) {
        assert(
          control.approvedByModel === "Sol Extra High",
          `${control.id} protected adoption requires Sol Extra High approval.`,
        );
      }
    }
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const policy = readJson(canonicalPolicyUrl);
  const controls = readJson(canonicalControlsUrl);
  validateOrchestrationPolicy(policy);
  validateAdoptedControls(controls, policy);

  const statePath = argumentValue("--state");
  if (statePath) validateOperationalState(readJson(statePath), policy);

  console.log(
    `Orchestration governance: policy, ${controls.controls.length} control(s)`
      + `${statePath ? " and operational state" : ""} validated.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

export { repositoryRoot };
