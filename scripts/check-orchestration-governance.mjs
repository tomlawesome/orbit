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

function isRepositoryPath(value) {
  return isNonEmptyString(value)
    && !value.startsWith("/")
    && !value.split("/").includes("..");
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
  assert(
    isNonEmptyString(policy.humanApprovalIdentifier),
    "humanApprovalIdentifier is required.",
  );
  assert(isObject(policy.modelAuthority), "modelAuthority is required.");
  for (const role of ["orchestration", "protectedPlanning", "mechanicalAnalysis"]) {
    assert(
      Array.isArray(policy.modelAuthority[role]) && policy.modelAuthority[role].every(isNonEmptyString),
      `modelAuthority.${role} must be a non-empty string array.`,
    );
  }
  assert(
    hasExactStrings(policy.modelAuthority.orchestration, ["Sol Extra High"]),
    "orchestration must remain reserved to Sol Extra High.",
  );
  assert(
    hasExactStrings(policy.modelAuthority.protectedPlanning, ["Sol Extra High"]),
    "protected planning must remain reserved to Sol Extra High.",
  );

  const routing = policy.implementationRouting;
  assert(isObject(routing), "implementationRouting is required.");
  assert(routing.qualificationRequired === true, "implementation qualification must be mandatory.");
  assert(
    hasExactStrings(routing.qualificationIdentity, ["provider", "model", "taskClass"]),
    "implementation qualification must identify provider, model and task class.",
  );
  assert(
    hasExactStrings(routing.qualificationCriteria, [
      "correctness",
      "hidden_edge_cases",
      "scope_compliance",
      "result_honesty",
      "context_fit",
    ]),
    "implementation qualification criteria are incomplete.",
  );
  assert(
    hasExactStrings(routing.routingSignals, ["cost", "latency", "resource_use", "capacity"]),
    "implementation routing signals are incomplete.",
  );
  assert(
    isObject(routing.resourceLimits)
      && routing.resourceLimits.circuitBreakerOnly === true
      && routing.resourceLimits.overrunDisqualifiesCorrectWork === false,
    "resource limits must remain circuit breakers and must not disqualify otherwise correct work.",
  );
  assert(
    routing.resourceLimits.routineSessionTokenCaps === false,
    "routine token caps must remain disabled; task completion and correctness govern implementation.",
  );
  const stallMonitoring = routing.resourceLimits.stallMonitoring;
  assert(
    isObject(stallMonitoring)
      && hasExactStrings(stallMonitoring.signals, [
        "time_to_first_useful_output",
        "time_since_meaningful_progress",
      ])
      && stallMonitoring.taskAndModelAppropriate === true
      && stallMonitoring.benefitOfDoubtBuffer === true
      && stallMonitoring.slowUsefulProgressIsNotStalled === true,
    "stall monitoring must be time-based, task-appropriate, and buffered before intervention.",
  );
  assert(
    isObject(routing.evaluationPasses)
      && routing.evaluationPasses.maximum === 5
      && routing.evaluationPasses.basicAcceptanceBy === 3
      && Array.isArray(routing.evaluationPasses.fineTuningOnly)
      && routing.evaluationPasses.fineTuningOnly.join(",") === "4,5"
      && routing.evaluationPasses.stopEarlyWhenSatisfied === true,
    "model evaluation must stop by pass five, require basic acceptance by pass three, and reserve passes four and five for fine tuning.",
  );
  const providerSelection = routing.providerSelection;
  const providerConcurrency = providerSelection?.concurrency;
  assert(
    isObject(providerSelection)
      && providerSelection.mode === "cheapest_qualified_idle_capacity_first"
      && providerSelection.strictSerialFallback === false
      && providerSelection.withinTaskLeastCostQualified === true
      && isObject(providerConcurrency)
      && providerConcurrency.allowed === true
      && providerConcurrency.reason === "occupied_beneficial_concurrency"
      && providerConcurrency.requiresCheaperProviderOccupied === true
      && providerConcurrency.requiresIndependentIssue === true
      && providerConcurrency.requiresDisjointPaths === true
      && providerConcurrency.requiresSatisfiedDependencies === true
      && providerConcurrency.requiresRecordedThroughputBenefit === true
      && providerConcurrency.prohibitsDuplicateTask === true
      && providerConcurrency.prohibitsAuthorityExpansion === true
      && providerConcurrency.maximumInFlightPullRequests === 2
      && hasExactStrings(providerConcurrency.siblingLandingImpacts, [
        "rebase_only",
        "rebase_and_revalidate",
      ]),
    "provider selection must permit bounded cost-aware concurrency while preserving least-cost within-task routing.",
  );
  assert(Array.isArray(routing.providers), "implementation providers are required.");
  const providerIds = routing.providers.map((provider) => provider?.id);
  assert(
    providerIds.join(",") === "ollama,mistral,claude,luna",
    "implementation provider order must be qualified Ollama, Mistral, Claude, then Luna.",
  );
  for (const provider of routing.providers) {
    assert(isObject(provider), "each implementation provider must be an object.");
    assert(provider.requiresExactModel === true, `${provider.id} must require an exact model identity.`);
    assert(
      typeof provider.requiresExactHost === "boolean",
      `${provider.id} must declare whether an exact host identity is required.`,
    );
  }
  assert(
    routing.providers[0].requiresExactHost === true
      && routing.providers.slice(1).every((provider) => provider.requiresExactHost === false),
    "only local Ollama routing requires an exact host identity.",
  );
  assert(
    routing.providers.at(-1).lastResort === true,
    "Luna must remain the last-resort implementation provider.",
  );
  assert(
    hasExactStrings(routing.fallbackReasons, [
      "unqualified",
      "unsuitable_task_class",
      "unreachable",
      "capacity_exhausted",
      "occupied_beneficial_concurrency",
    ]),
    "implementation fallback reasons are incomplete.",
  );
  assert(isObject(routing.isolation), "implementation isolation controls are required.");
  for (const control of [
    "exactBase",
    "dedicatedWorktree",
    "leastPrivilegeTools",
    "pathAllowlist",
    "runawayMonitoring",
    "requiredResult",
    "solReview",
  ]) {
    assert(routing.isolation[control] === true, `implementation isolation requires ${control}.`);
  }
  assert(
    hasExactStrings(routing.delegatedAuthorities, ["implementation"]),
    "delegated providers may hold implementation authority only.",
  );
  assert(
    hasExactStrings(routing.prohibitedAuthorities, [
      "orchestration",
      "protected_planning",
      "architecture",
      "security",
      "integration",
      "publication",
      "release",
    ]),
    "delegated-provider authority prohibitions are incomplete.",
  );
  assert(isObject(policy.secondaryReview), "secondaryReview is required.");
  assert(
    policy.secondaryReview.provider === "claude"
      && policy.secondaryReview.minimumModel === "Claude Opus Extra High"
      && policy.secondaryReview.freshUserApprovalRequired === true
      && policy.secondaryReview.authority === "advisory_only",
    "Claude secondary review must require fresh approval and remain advisory only.",
  );
  assert(
    Array.isArray(policy.protectedDecisionClasses)
      && policy.protectedDecisionClasses.includes("protected_planning")
      && policy.protectedDecisionClasses.includes("model_governance"),
    "protected decision classes are incomplete.",
  );
  assert(
    Array.isArray(policy.taskStatusSources)
      && ["create_thread", "bounded_wrapper", "list_threads_full", "read_thread", "wait_threads"]
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
  assert(
    hasExactStrings(policy.terminalDeliveryStages, ["reconciled"]),
    "reconciled must be the only terminal delivery stage.",
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
  assert(
    policy.deliveryStages.includes("merged")
      && policy.deliveryStages.includes("trusted")
      && policy.deliveryStages.includes("reconciled")
      && policy.allowedTransitions.merged.includes("trusted")
      && policy.allowedTransitions.trusted.includes("reconciled")
      && policy.allowedTransitions.reconciled.length === 0,
    "delivery completion must progress from merged through trusted to reconciled.",
  );
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
  assert(
    Array.isArray(policy.learning.legacyProtectedApprovals)
      && policy.learning.legacyProtectedApprovals.length === 3
      && [131, 136, 159].every((pullRequest) => policy.learning.legacyProtectedApprovals.some(
        (approval) => approval?.model === "Claude Opus Extra High"
          && approval.pullRequest === pullRequest,
      )),
    "legacy Claude protected approvals must be limited to PRs 131, 136 and 159.",
  );
}

function authorityRole(role) {
  return {
    orchestration: "orchestration",
    protected_planning: "protectedPlanning",
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

function validateImplementationTask(task, policy, issue) {
  const routing = policy.implementationRouting;
  assert(isObject(task), "implementation task state is required.");
  assert(isNonEmptyString(task.provider), "implementation provider is required.");
  assert(isNonEmptyString(task.requestedModel), "implementation model is required.");
  assert(isNonEmptyString(task.taskClass), "implementation task class is required.");

  const providerIndex = routing.providers.findIndex((provider) => provider.id === task.provider);
  assert(providerIndex >= 0, `unknown implementation provider ${String(task.provider)}.`);
  const provider = routing.providers[providerIndex];

  assert(isObject(task.qualification), "qualified implementation evidence is required.");
  assert(
    task.qualification.status === "qualified"
      && task.qualification.provider === task.provider
      && task.qualification.model === task.requestedModel
      && task.qualification.taskClass === task.taskClass
      && isNonEmptyString(task.qualification.evidenceId),
    "qualified implementation evidence must match the exact provider, model and task class.",
  );
  if (provider.requiresExactHost) {
    assert(
      isNonEmptyString(task.host),
      "qualified local Ollama work requires an exact host identity.",
    );
  }

  assert(Array.isArray(task.skippedProviders), "skipped implementation providers are required.");
  const expectedEarlier = routing.providers.slice(0, providerIndex).map((entry) => entry.id);
  assert(
    task.skippedProviders.length === expectedEarlier.length,
    "every earlier implementation provider requires explicit fallback evidence.",
  );
  for (const [index, skipped] of task.skippedProviders.entries()) {
    assert(
      isObject(skipped)
        && skipped.provider === expectedEarlier[index]
        && routing.fallbackReasons.includes(skipped.reason)
        && isNonEmptyString(skipped.evidenceId),
      "every earlier implementation provider requires ordered, evidenced fallback status.",
    );
  }

  const concurrencyReason = routing.providerSelection.concurrency.reason;
  const concurrentlyOccupied = task.skippedProviders.filter(
    (skipped) => skipped.reason === concurrencyReason,
  );
  if (concurrentlyOccupied.length === 0) {
    assert(
      task.concurrencyAssessment === undefined,
      "a concurrency assessment requires an occupied cheaper provider.",
    );
    return;
  }

  const assessment = task.concurrencyAssessment;
  assert(isObject(assessment), "beneficial provider concurrency requires an assessment.");
  assert(
    Array.isArray(assessment.selectedAllowedPaths)
      && assessment.selectedAllowedPaths.length > 0
      && assessment.selectedAllowedPaths.every(isRepositoryPath)
      && new Set(assessment.selectedAllowedPaths).size === assessment.selectedAllowedPaths.length,
    "beneficial provider concurrency requires unique selected-task paths.",
  );
  assert(
    Array.isArray(assessment.occupiedTasks)
      && assessment.occupiedTasks.length === concurrentlyOccupied.length,
    "every occupied cheaper provider requires one concurrent task record.",
  );

  const selectedPaths = new Set(assessment.selectedAllowedPaths);
  const occupiedPaths = new Set();
  for (const [index, occupied] of assessment.occupiedTasks.entries()) {
    assert(
      isObject(occupied)
        && occupied.provider === concurrentlyOccupied[index].provider
        && Number.isInteger(occupied.issue)
        && occupied.issue > 0
        && isNonEmptyString(occupied.taskId)
        && isNonEmptyString(occupied.qualificationEvidenceId)
        && Array.isArray(occupied.allowedPaths)
        && occupied.allowedPaths.length > 0
        && occupied.allowedPaths.every(isRepositoryPath)
        && new Set(occupied.allowedPaths).size === occupied.allowedPaths.length,
      "each occupied cheaper provider requires exact task, qualification and path evidence.",
    );
    assert(
      occupied.issue !== issue,
      "concurrent implementation must own an independent issue.",
    );
    for (const path of occupied.allowedPaths) {
      assert(
        !selectedPaths.has(path) && !occupiedPaths.has(path),
        "concurrent implementation paths must be disjoint.",
      );
      occupiedPaths.add(path);
    }
  }

  const concurrencyPolicy = routing.providerSelection.concurrency;
  assert(
    assessment.dependenciesSatisfied === true,
    "concurrent implementation requires satisfied dependencies.",
  );
  assert(
    concurrencyPolicy.siblingLandingImpacts.includes(assessment.siblingLandingImpact),
    "concurrent sibling impact must remain bounded.",
  );
  assert(
    isNonEmptyString(assessment.expectedThroughputBenefit),
    "beneficial provider concurrency requires a recorded throughput benefit.",
  );
  assert(
    Number.isInteger(assessment.projectedInFlightPullRequests)
      && assessment.projectedInFlightPullRequests >= 2
      && assessment.projectedInFlightPullRequests === assessment.occupiedTasks.length + 1
      && assessment.projectedInFlightPullRequests <= concurrencyPolicy.maximumInFlightPullRequests,
    "projected in-flight pull requests must match the concurrent task set and remain within the cap.",
  );
}

function validateLaunchReceipt(receipt, policy, task, baseSha) {
  assert(isObject(receipt), "task launch receipt is required.");
  assert(policy.taskStatusSources.includes(receipt.source), "unknown launch receipt source.");
  if (task.provider === "luna") {
    assert(receipt.source === "create_thread", "Luna implementation must use a create_thread receipt.");
    assert(
      isNonEmptyString(receipt.threadId) || isNonEmptyString(receipt.clientThreadId),
      "task launch receipt requires threadId or clientThreadId.",
    );
  } else {
    assert(
      receipt.source === "bounded_wrapper",
      "non-Luna implementation must use a bounded wrapper receipt.",
    );
    assert(isNonEmptyString(receipt.runId), "bounded wrapper receipt requires a runId.");
  }
  assert(
    receipt.requestedModel === task.requestedModel,
    "launch receipt model does not match requested model.",
  );
  assert(receipt.baseSha === baseSha, "launch receipt base does not match accepted delivery base.");
  assert(isTimestamp(receipt.observedAt), "task launch receipt requires an observation timestamp.");
}

function validateAuthoritativeTaskStatus(status, policy) {
  assert(isObject(status), "authoritative task status is required.");
  assert(policy.taskStatusSources.includes(status.source), "unknown task status source.");
  assert(status.source !== "create_thread", "create_thread is a receipt, not authoritative task status.");
  if (status.source === "bounded_wrapper") {
    assert(isNonEmptyString(status.runId), "bounded wrapper status requires a runId.");
  }
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
  assert(Array.isArray(delivery.dependencies), "delivery dependencies must be declared.");
  const dependencyIssues = new Set();
  for (const dependency of delivery.dependencies) {
    assert(isObject(dependency), "each delivery dependency must be an object.");
    assert(
      Number.isInteger(dependency.issue) && dependency.issue > 0,
      "each delivery dependency requires an issue.",
    );
    assert(!dependencyIssues.has(dependency.issue), `duplicate delivery dependency ${dependency.issue}.`);
    dependencyIssues.add(dependency.issue);
    assert(isTimestamp(dependency.observedAt), "each delivery dependency requires an observation timestamp.");
    if (delivery.stage !== "planned") {
      assert(
        dependency.stage === "reconciled",
        "dependencies must be reconciled before delivery advances.",
      );
    }
  }
  assert(Array.isArray(delivery.parentIssues), "delivery parent issues must be declared.");
  assert(
    delivery.parentIssues.every((issue) => Number.isInteger(issue) && issue > 0)
      && new Set(delivery.parentIssues).size === delivery.parentIssues.length,
    "delivery parent issues must be unique positive integers.",
  );

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
  if (delivery.task !== undefined) {
    validateImplementationTask(delivery.task, policy, delivery.issue);
  }
  if (taskStages.has(delivery.stage)) {
    assert(isObject(delivery.task), `${delivery.stage} delivery requires task state.`);
    validateLaunchReceipt(
      delivery.task.launchReceipt,
      policy,
      delivery.task,
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
    if (delivery.task.authoritativeStatus.source !== "bounded_wrapper") {
      assert(isNonEmptyString(delivery.task.authoritativeStatus.threadId), "active Luna task requires threadId.");
    }
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

  const mergedStages = new Set(["merged", "trusted", "reconciled"]);
  if (mergedStages.has(delivery.stage)) {
    assert(isObject(delivery.merge), "merged delivery requires exact merge evidence.");
    assert(
      Number.isInteger(delivery.merge.pullRequest) && delivery.merge.pullRequest > 0,
      "merge evidence requires a pull request.",
    );
    assert(isSha(delivery.merge.sha), "merge evidence requires an exact merge SHA.");
    assert(isNonEmptyString(delivery.merge.targetBranch), "merge evidence requires a target branch.");
    assert(isTimestamp(delivery.merge.observedAt), "merge evidence requires an observation timestamp.");
  }

  const trustedStages = new Set(["trusted", "reconciled"]);
  if (trustedStages.has(delivery.stage)) {
    assert(
      isObject(delivery.trustedValidation),
      "trusted delivery requires exact target-branch validation.",
    );
    assert(
      delivery.trustedValidation.branch === delivery.merge.targetBranch
        && delivery.trustedValidation.sha === delivery.merge.sha,
      "trusted validation must match the exact merge SHA and target branch.",
    );
    assert(
      delivery.trustedValidation.conclusion === "success",
      "trusted target-branch validation must succeed.",
    );
    assert(
      isTimestamp(delivery.trustedValidation.observedAt),
      "trusted validation requires an observation timestamp.",
    );
    assert(
      Array.isArray(delivery.trustedValidation.checks)
        && delivery.trustedValidation.checks.length > 0,
      "trusted validation requires successful check evidence.",
    );
    for (const check of delivery.trustedValidation.checks) {
      assert(isObject(check), "each trusted check must be an object.");
      assert(isNonEmptyString(check.name), "each trusted check requires a name.");
      assert(Number.isInteger(check.runId) && check.runId > 0, "each trusted check requires a run ID.");
      assert(check.conclusion === "success", "every trusted check must succeed.");
    }
  }

  if (delivery.stage === "reconciled") {
    assert(
      remoteCapabilities.get("issue_write")?.status === "available",
      "issue reconciliation requires an authenticated issue-write path.",
    );
    assert(isObject(delivery.reconciliation), "reconciled delivery requires reconciliation evidence.");
    const issue = delivery.reconciliation.issue;
    assert(isObject(issue), "reconciliation requires issue evidence.");
    assert(issue.number === delivery.issue, "reconciliation issue must match delivery issue.");
    assert(
      issue.acceptanceChecklist === "reviewed_complete",
      "acceptance checklist must be reviewed complete.",
    );
    // A summary flag can be asserted from memory. Requiring each criterion to
    // be itemised with its own evidence makes "reviewed complete" auditable
    // rather than assertable, and fails closed when the itemisation is absent.
    assert(
      Array.isArray(issue.acceptanceCriteria) && issue.acceptanceCriteria.length > 0,
      "reconciliation must itemise every acceptance criterion.",
    );
    for (const criterion of issue.acceptanceCriteria) {
      assert(isObject(criterion), "each acceptance criterion must be an object.");
      assert(
        isNonEmptyString(criterion.criterion),
        "each acceptance criterion must record the criterion it accounts for.",
      );
      assert(
        criterion.met === true,
        "every acceptance criterion must be met before reconciliation.",
      );
      assert(
        Array.isArray(criterion.evidence)
          && criterion.evidence.length > 0
          && criterion.evidence.every(isNonEmptyString),
        "each acceptance criterion requires its own evidence.",
      );
    }
    assert(
      Array.isArray(issue.closureEvidence)
        && issue.closureEvidence.length > 0
        && issue.closureEvidence.every(isNonEmptyString),
      "reconciliation requires bounded closure evidence.",
    );
    assert(
      issue.state === "closed" && issue.stateReason === "completed",
      "reconciled delivery issue must be closed as completed.",
    );
    assert(isTimestamp(issue.observedAt), "issue reconciliation requires an observation timestamp.");
    assert(
      delivery.reconciliation.milestoneReevaluated === true,
      "reconciliation must re-evaluate the milestone or wave gate.",
    );
    assert(Array.isArray(delivery.reconciliation.parents), "parent reconciliation outcomes are required.");
    const parentOutcomes = new Map();
    for (const parent of delivery.reconciliation.parents) {
      assert(isObject(parent), "each parent reconciliation outcome must be an object.");
      assert(
        Number.isInteger(parent.issue) && parent.issue > 0,
        "each parent reconciliation outcome requires an issue.",
      );
      assert(!parentOutcomes.has(parent.issue), `duplicate parent reconciliation ${parent.issue}.`);
      assert(
        parent.childOutcomeRecorded === true && parent.acceptanceReevaluated === true,
        "parent reconciliation must record the child outcome and re-evaluate acceptance.",
      );
      assert(["open", "closed"].includes(parent.state), "parent reconciliation state is invalid.");
      assert(isTimestamp(parent.observedAt), "parent reconciliation requires an observation timestamp.");
      if (parent.state === "open") {
        assert(
          Array.isArray(parent.residualAcceptance)
            && parent.residualAcceptance.length > 0
            && parent.residualAcceptance.every(isNonEmptyString),
          "an open parent requires precise residual acceptance.",
        );
      }
      parentOutcomes.set(parent.issue, parent);
    }
    assert(
      parentOutcomes.size === delivery.parentIssues.length
        && delivery.parentIssues.every((parentIssue) => parentOutcomes.has(parentIssue)),
      "every declared parent issue requires one reconciliation outcome.",
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
        const legacyApproval = policy.learning.legacyProtectedApprovals.some(
          (approval) => approval.model === control.approvedByModel
            && approval.pullRequest === control.pullRequest,
        );
        assert(
          policy.modelAuthority.protectedPlanning.includes(control.approvedByModel)
            || control.approvedByModel === policy.humanApprovalIdentifier
            || legacyApproval,
          `${control.id} protected adoption requires approval by a protected-planning authority or ${policy.humanApprovalIdentifier}.`,
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
