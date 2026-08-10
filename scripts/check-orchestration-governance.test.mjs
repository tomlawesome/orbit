import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  validateAdoptedControls,
  validateOperationalState,
  validateOrchestrationPolicy,
} from "./check-orchestration-governance.mjs";

const SHA = "90e240a51bed89bf19d50d0819601de19a3ecc8d";

function validPolicy() {
  return {
    schemaVersion: 1,
    humanApprovalIdentifier: "Human",
    modelAuthority: {
      orchestration: ["Luna Extra High"],
      protectedPlanning: ["Sol Extra High"],
      reservedSpecialist: ["Sol Extra High"],
      mechanicalAnalysis: ["Terra Medium", "Luna Extra High", "Sol Extra High"],
    },
    routineDelivery: {
      accountableOrchestrator: "Luna Extra High",
      modelRestrictedActions: false,
      lowestCompetentModelAndEffort: true,
      avoidRework: true,
      delegatedSelfApproval: false,
      actions: [
        "product_planning",
        "product_scope",
        "roadmaps",
        "task_launch",
        "monitoring",
        "sequencing",
        "reconciliation",
        "blocker_classification",
        "handback_acceptance",
        "delivery_decisions",
        "next_actions",
        "provider_concurrency",
        "review",
        "integration",
        "publication",
        "release_execution",
        "retained_learning_promotion",
      ],
    },
    reservedSpecialist: {
      model: "Sol Extra High",
      freshUserApprovalRequired: true,
      decisionClasses: [
        "adr",
        "high_level_architecture",
        "model_governance",
        "release_policy",
        "repository_settings",
        "protected_planning",
        "requested_security_review",
      ],
      securityReviewRequiresExplicitHumanRequest: true,
      architectureScope: ["new_feature", "broad_architecture_reconsideration"],
    },
    adrGovernance: {
      specialistModel: "Sol Extra High",
      humanFinalDecision: true,
      lunaMay: ["identify", "research", "draft", "request_amendment"],
      solMustAssess: ["broader_context", "proposal_reason", "alternatives", "consequences"],
      lunaMustRespectSpecialistDecision: true,
      lunaMustPresentDecisionFaithfully: true,
      historicalRecordsImmutable: true,
      changedDecisionRequiresSupersedingAdr: true,
    },
    implementationRouting: {
      qualificationRequired: true,
      qualificationIdentity: ["provider", "model", "taskClass"],
      qualificationCriteria: [
        "correctness",
        "hidden_edge_cases",
        "scope_compliance",
        "result_honesty",
        "context_fit",
      ],
      routingSignals: ["cost", "latency", "resource_use", "capacity"],
      resourceLimits: {
        circuitBreakerOnly: true,
        overrunDisqualifiesCorrectWork: false,
        routineSessionTokenCaps: false,
        stallMonitoring: {
          signals: [
            "time_to_first_useful_output",
            "time_since_meaningful_progress",
          ],
          taskAndModelAppropriate: true,
          benefitOfDoubtBuffer: true,
          slowUsefulProgressIsNotStalled: true,
        },
      },
      evaluationPasses: {
        maximum: 5,
        basicAcceptanceBy: 3,
        fineTuningOnly: [4, 5],
        stopEarlyWhenSatisfied: true,
      },
      lowRiskImplementation: {
        taskClasses: ["low-risk-implementation", "donkey-work"],
        provider: "luna",
        model: "Luna Extra High",
        fallbackReason: "unavailable",
        unavailableProviders: ["ollama", "mistral", "claude"],
      },
      providerSelection: {
        mode: "cheapest_qualified_idle_capacity_first",
        strictSerialFallback: false,
        withinTaskLeastCostQualified: true,
        concurrency: {
          allowed: true,
          reason: "occupied_beneficial_concurrency",
          requiresCheaperProviderOccupied: true,
          requiresIndependentIssue: true,
          requiresDisjointPaths: true,
          requiresSatisfiedDependencies: true,
          requiresRecordedThroughputBenefit: true,
          prohibitsDuplicateTask: true,
          prohibitsAuthorityExpansion: true,
          maximumInFlightPullRequests: 2,
          siblingLandingImpacts: ["rebase_only", "rebase_and_revalidate"],
        },
      },
      providers: [
        { id: "ollama", requiresExactHost: true, requiresExactModel: true },
        { id: "mistral", requiresExactHost: false, requiresExactModel: true },
        { id: "claude", requiresExactHost: false, requiresExactModel: true },
        {
          id: "luna",
          requiresExactHost: false,
          requiresExactModel: true,
          lastResort: true,
        },
      ],
      fallbackReasons: [
        "unqualified",
        "unsuitable_task_class",
        "unreachable",
        "capacity_exhausted",
        "unavailable",
        "occupied_beneficial_concurrency",
      ],
      isolation: {
        exactBase: true,
        dedicatedWorktree: true,
        leastPrivilegeTools: true,
        pathAllowlist: true,
        runawayMonitoring: true,
        requiredResult: true,
        orchestratorReview: true,
      },
      delegatedAuthorities: ["implementation", "routine_delivery"],
      prohibitedAuthorities: [
        "adr",
        "protected_planning",
        "high_level_architecture",
        "model_governance",
        "release_policy",
        "repository_settings",
        "requested_security_review",
      ],
    },
    secondaryReview: {
      provider: "claude",
      minimumModel: "Claude Opus Extra High",
      freshUserApprovalRequired: true,
      authority: "advisory_only",
    },
    protectedDecisionClasses: [
      "adr",
      "high_level_architecture",
      "model_governance",
      "release_policy",
      "repository_settings",
      "protected_planning",
      "requested_security_review",
    ],
    taskStatusSources: [
      "create_thread",
      "bounded_wrapper",
      "list_threads_full",
      "read_thread",
      "wait_threads",
    ],
    remoteAccessPreflight: {
      connectorMountProof: "live_connector_call",
      sshRefProof: "ssh_exact_ref_read",
      cliReadProofs: [
        "cli_auth_status",
        "repository_read",
        "issues_read",
        "pull_requests_read",
        "actions_read",
      ],
      actionClasses: [
        "repository_read",
        "issue_read",
        "pull_request_read",
        "actions_read",
        "git_fetch",
        "git_push",
        "issue_write",
        "pull_request_write",
        "protected_merge",
      ],
      capabilityStates: ["available", "unavailable", "untested"],
      routeOrder: ["connector", "cli", "browser_user_controlled"],
      protectedWriteClasses: ["pull_request_write", "protected_merge"],
      writeEvidenceKinds: ["authenticated_write_capability", "endpoint_write_success"],
      rejectInstalledMetadataAsMountProof: true,
      rejectOwnershipOrPublicReadAsWriteProof: true,
      failClosedBeforeDependentLaunch: true,
      secretsInChat: false,
    },
    deliveryStages: [
      "planned",
      "launch_pending",
      "active",
      "handback",
      "orchestrator_review",
      "pr_open",
      "merged",
      "trusted",
      "reconciled",
      "blocked",
    ],
    terminalDeliveryStages: ["reconciled"],
    allowedTransitions: {
      planned: ["launch_pending", "blocked"],
      launch_pending: ["active", "blocked"],
      active: ["handback", "blocked"],
      handback: ["orchestrator_review", "blocked"],
      orchestrator_review: ["active", "pr_open", "blocked"],
      pr_open: ["active", "merged", "blocked"],
      merged: ["trusted", "blocked"],
      trusted: ["reconciled", "blocked"],
      reconciled: [],
      blocked: ["planned", "launch_pending", "active", "handback", "orchestrator_review", "pr_open", "merged", "trusted"],
    },
    learning: {
      automaticCandidateCapture: true,
      automaticAdoption: false,
      minimumEvidenceForAdoption: 2,
      prohibitedAutomaticClasses: [
        "adr",
        "high_level_architecture",
        "model_governance",
        "release_policy",
        "repository_settings",
        "protected_planning",
        "requested_security_review",
      ],
      legacyProtectedApprovals: [
        { model: "Claude Opus Extra High", pullRequest: 131 },
        { model: "Claude Opus Extra High", pullRequest: 136 },
        { model: "Claude Opus Extra High", pullRequest: 159 },
      ],
    },
  };
}

function activeState() {
  return {
    schemaVersion: 1,
    actor: {
      model: "Luna Extra High",
      role: "orchestration",
    },
    accessPreflight: {
      observedAt: "2026-07-30T06:25:00.000Z",
      connector: {
        mounted: true,
        proof: "live_connector_call",
      },
      ssh: {
        reachable: true,
        proof: "ssh_exact_ref_read",
        refs: [
          {
            name: "refs/heads/release/architecture-consolidation-rc",
            sha: SHA,
          },
        ],
      },
      cli: {
        checked: true,
        accountVerified: false,
        proof: "cli_auth_status",
        credentialMaterialRecorded: false,
        readCapabilities: {
          repository_read: "unavailable",
          issues_read: "unavailable",
          pull_requests_read: "unavailable",
          actions_read: "unavailable",
        },
      },
      browser: {
        userControlled: true,
      },
      capabilities: [
        {
          actionClass: "repository_read",
          status: "available",
          route: "connector",
          evidenceKind: "live_connector_call",
        },
        {
          actionClass: "issue_read",
          status: "available",
          route: "connector",
          evidenceKind: "live_connector_call",
        },
        {
          actionClass: "pull_request_read",
          status: "available",
          route: "connector",
          evidenceKind: "live_connector_call",
        },
        {
          actionClass: "actions_read",
          status: "available",
          route: "connector",
          evidenceKind: "live_connector_call",
        },
        {
          actionClass: "git_fetch",
          status: "available",
          route: "cli",
          evidenceKind: "ssh_exact_ref_read",
        },
        {
          actionClass: "git_push",
          status: "available",
          route: "cli",
          evidenceKind: "endpoint_write_success",
        },
        {
          actionClass: "issue_write",
          status: "available",
          route: "connector",
          evidenceKind: "authenticated_write_capability",
        },
        {
          actionClass: "pull_request_write",
          status: "available",
          route: "connector",
          evidenceKind: "endpoint_write_success",
        },
        {
          actionClass: "protected_merge",
          status: "available",
          route: "connector",
          evidenceKind: "authenticated_write_capability",
        },
      ],
    },
    delivery: {
      issue: 74,
      repository: "tomlawesome/orbit",
      baseSha: SHA,
      branch: "codex/issue-74-orchestration-learning",
      stage: "active",
      previousStage: "launch_pending",
      dependencies: [],
      parentIssues: [],
      task: {
        provider: "luna",
        requestedModel: "Luna Extra High",
        taskClass: "low-risk-implementation",
        qualification: {
          status: "qualified",
          provider: "luna",
          model: "Luna Extra High",
          taskClass: "low-risk-implementation",
          evidenceId: "repository-governance-baseline",
        },
        skippedProviders: [
          { provider: "ollama", reason: "unavailable", evidenceId: "provider:ollama-unavailable" },
          { provider: "mistral", reason: "unavailable", evidenceId: "provider:mistral-unavailable" },
          { provider: "claude", reason: "unavailable", evidenceId: "provider:claude-unavailable" },
        ],
        launchReceipt: {
          source: "create_thread",
          clientThreadId: "client-new-thread:fake-launch-receipt",
          requestedModel: "Luna Extra High",
          baseSha: SHA,
          observedAt: "2026-07-30T06:30:00.000Z",
        },
        authoritativeStatus: {
          source: "list_threads_full",
          status: "active",
          threadId: "019fb1bd-b148-79f1-982f-23a3c8695090",
          worktree: "C:\\fake\\orbit-worktree",
          baseSha: SHA,
          observedAt: "2026-07-30T06:40:00.000Z",
        },
      },
    },
  };
}

function reconciledState() {
  const state = activeState();
  state.delivery.stage = "reconciled";
  state.delivery.previousStage = "trusted";
  state.delivery.merge = {
    pullRequest: 75,
    sha: SHA,
    targetBranch: "develop",
    observedAt: "2026-07-30T07:00:00.000Z",
  };
  state.delivery.trustedValidation = {
    branch: "develop",
    sha: SHA,
    conclusion: "success",
    observedAt: "2026-07-30T07:20:00.000Z",
    checks: [
      {
        name: "Validate Orbit and publish previews",
        runId: 123456789,
        conclusion: "success",
      },
      {
        name: "CodeQL",
        runId: 123456790,
        conclusion: "success",
      },
    ],
  };
  state.delivery.reconciliation = {
    issue: {
      number: 74,
      acceptanceChecklist: "reviewed_complete",
      acceptanceCriteria: [
        {
          criterion: "Launch receipts remain launch-pending until authoritatively confirmed.",
          met: true,
          evidence: ["Regression test for the absent-from-list case.", "Merged PR #75."],
        },
      ],
      closureEvidence: [
        "PR #75 merged at the recorded SHA.",
        "Trusted develop validation passed for the same SHA.",
      ],
      state: "closed",
      stateReason: "completed",
      observedAt: "2026-07-30T07:25:00.000Z",
    },
    parents: [],
    milestoneReevaluated: true,
  };
  return state;
}

function concurrentProviderState() {
  const state = activeState();
  state.delivery.issue = 157;
  state.delivery.branch = "codex/issue-157-concurrency-test";
  state.delivery.task = {
    provider: "claude",
    requestedModel: "Claude Sonnet",
    taskClass: "bounded-ordinary-implementation",
    qualification: {
      status: "qualified",
      provider: "claude",
      model: "Claude Sonnet",
      taskClass: "bounded-ordinary-implementation",
      evidenceId: "global-registry:claude-sonnet",
    },
    skippedProviders: [
      { provider: "ollama", reason: "unqualified", evidenceId: "global-registry:ollama" },
      {
        provider: "mistral",
        reason: "occupied_beneficial_concurrency",
        evidenceId: "run:mistral-issue-185",
      },
    ],
    concurrencyAssessment: {
      selectedAllowedPaths: ["scripts/concurrency-contract.test.mjs"],
      occupiedTasks: [
        {
          provider: "mistral",
          issue: 185,
          taskId: "bounded-wrapper:mistral-issue-185",
          qualificationEvidenceId: "global-registry:mistral-medium-high",
          allowedPaths: ["src/instrumentation.ts", "src/instrumentation-node.ts"],
        },
      ],
      dependenciesSatisfied: true,
      siblingLandingImpact: "rebase_and_revalidate",
      expectedThroughputBenefit: "The independent test slice progresses while Mistral owns the instrumentation slice.",
      projectedInFlightPullRequests: 2,
    },
    launchReceipt: {
      source: "bounded_wrapper",
      runId: "claude-issue-157",
      requestedModel: "Claude Sonnet",
      baseSha: SHA,
      observedAt: "2026-07-30T06:30:00.000Z",
    },
    authoritativeStatus: {
      source: "bounded_wrapper",
      runId: "claude-issue-157",
      status: "active",
      worktree: "/tmp/orbit-issue-157-claude",
      baseSha: SHA,
      observedAt: "2026-07-30T06:40:00.000Z",
    },
  };
  return state;
}

describe("orchestration governance", () => {
  it("accepts the canonical authority, transition, and learning policy", () => {
    expect(() => validateOrchestrationPolicy(validPolicy())).not.toThrow();
  });

  it("routes low-risk implementation and donkey work to Luna after unavailable-provider evidence", () => {
    const policy = validPolicy();
    expect(() => validateOperationalState(activeState(), policy)).not.toThrow();

    const state = activeState();
    state.delivery.task.taskClass = "donkey-work";
    state.delivery.task.qualification.taskClass = "donkey-work";
    state.delivery.task.launchReceipt.requestedModel = "Luna Extra High";
    expect(() => validateOperationalState(state, policy)).not.toThrow();
  });

  it("rejects low-risk implementation routed to a provider other than Luna", () => {
    const state = activeState();
    state.delivery.task.provider = "claude";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /low-risk implementation must use Luna Extra High/u,
    );
  });

  it("requires unavailable evidence for every skipped low-risk provider", () => {
    const state = activeState();
    state.delivery.task.skippedProviders[1].reason = "unqualified";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /low-risk implementation fallback must record unavailable/u,
    );
  });

  it("rejects Terra orchestration work before any mutation", () => {
    const state = activeState();
    state.actor.model = "Terra Medium";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /Terra Medium is not authorized for orchestration/u,
    );
  });

  it("rejects Claude orchestration and protected-planning authority", () => {
    const state = activeState();
    state.actor.model = "Claude Opus Extra High";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /Claude Opus Extra High is not authorized for orchestration/u,
    );
  });

  it("accepts a bounded, freshly approved Sol specialist request", () => {
    const state = activeState();
    state.reservedSpecialist = {
      model: "Sol Extra High",
      role: "reserved_specialist",
      decisionClass: "adr",
      boundedRequest: "Assess ADR-0011 context, alternatives, and consequences.",
      status: "complete",
      userApproval: {
        approved: true,
        observedAt: "2026-08-10T18:30:00.000Z",
      },
    };
    expect(() => validateOperationalState(state, validPolicy())).not.toThrow();
  });

  it("rejects a Sol specialist request without fresh task-specific approval", () => {
    const state = activeState();
    state.reservedSpecialist = {
      model: "Sol Extra High",
      role: "reserved_specialist",
      decisionClass: "model_governance",
      boundedRequest: "Change the orchestration authority matrix.",
      status: "requested",
      userApproval: { approved: false, observedAt: "2026-08-10T18:30:00.000Z" },
    };
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /fresh task-specific user approval/u,
    );
  });

  it("rejects a security review not explicitly requested by the human", () => {
    const state = activeState();
    state.reservedSpecialist = {
      model: "Sol Extra High",
      role: "reserved_specialist",
      decisionClass: "requested_security_review",
      boundedRequest: "Review the authentication callback.",
      status: "requested",
      explicitHumanRequest: false,
      userApproval: { approved: true, observedAt: "2026-08-10T18:30:00.000Z" },
    };
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /security review invocation requires an explicit human request/u,
    );
  });

  it("rejects a routing order that does not put qualified local Ollama first and Luna last", () => {
    const policy = validPolicy();
    policy.implementationRouting.providers = [
      policy.implementationRouting.providers[1],
      policy.implementationRouting.providers[0],
      policy.implementationRouting.providers[2],
      policy.implementationRouting.providers[3],
    ];
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /implementation provider order/u,
    );
  });

  it("rejects strict provider serialization when qualified capacity can run beneficially in parallel", () => {
    const policy = validPolicy();
    policy.implementationRouting.providerSelection.strictSerialFallback = true;
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /provider selection must permit bounded cost-aware concurrency/u,
    );
  });

  it("accepts an evidenced higher-cost provider for a disjoint issue while cheaper capacity is occupied", () => {
    expect(() => validateOperationalState(concurrentProviderState(), validPolicy())).not.toThrow();
  });

  it("rejects beneficial-concurrency routing without the occupied-task assessment", () => {
    const state = concurrentProviderState();
    delete state.delivery.task.concurrencyAssessment;
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /beneficial provider concurrency requires an assessment/u,
    );
  });

  it("rejects provider concurrency whose changed paths overlap", () => {
    const state = concurrentProviderState();
    state.delivery.task.concurrencyAssessment.selectedAllowedPaths = ["src/instrumentation.ts"];
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /concurrent implementation paths must be disjoint/u,
    );
  });

  it("rejects provider concurrency for the same issue", () => {
    const state = concurrentProviderState();
    state.delivery.task.concurrencyAssessment.occupiedTasks[0].issue = state.delivery.issue;
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /concurrent implementation must own an independent issue/u,
    );
  });

  it("rejects provider concurrency when a sibling would change the selected slice's premises", () => {
    const state = concurrentProviderState();
    state.delivery.task.concurrencyAssessment.siblingLandingImpact = "premises_change";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /concurrent sibling impact must remain bounded/u,
    );
  });

  it("rejects provider concurrency beyond the two-pull-request integration cap", () => {
    const state = concurrentProviderState();
    state.delivery.task.concurrencyAssessment.projectedInFlightPullRequests = 3;
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /projected in-flight pull requests must match the concurrent task set and remain within the cap/u,
    );
  });

  it("rejects a projected pull-request count that understates the concurrent task set", () => {
    const state = concurrentProviderState();
    state.delivery.task.skippedProviders.unshift({
      provider: "ollama",
      reason: "occupied_beneficial_concurrency",
      evidenceId: "run:ollama-issue-184",
    });
    state.delivery.task.skippedProviders.splice(1, 1);
    state.delivery.task.concurrencyAssessment.occupiedTasks.unshift({
      provider: "ollama",
      issue: 184,
      taskId: "bounded-wrapper:ollama-issue-184",
      qualificationEvidenceId: "global-registry:ollama-desktop",
      allowedPaths: ["scripts/ollama-contract.mjs"],
    });
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /projected in-flight pull requests must match the concurrent task set and remain within the cap/u,
    );
  });

  it("rejects an implementation selection without exact qualification evidence", () => {
    const state = activeState();
    state.delivery.task.qualification.status = "pending";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /qualified implementation evidence/u,
    );
  });

  it("rejects policy that disqualifies correct work solely for a resource-limit overrun", () => {
    const policy = validPolicy();
    policy.implementationRouting.resourceLimits.overrunDisqualifiesCorrectWork = true;
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /resource limits must remain circuit breakers/u,
    );
  });

  it("rejects heuristic session-token caps as routine implementation controls", () => {
    const policy = validPolicy();
    policy.implementationRouting.resourceLimits.routineSessionTokenCaps = true;
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /routine token caps must remain disabled/u,
    );
  });

  it("requires time-based stall monitoring to include a benefit-of-the-doubt buffer", () => {
    const policy = validPolicy();
    policy.implementationRouting.resourceLimits.stallMonitoring.benefitOfDoubtBuffer = false;
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /stall monitoring must be time-based, task-appropriate, and buffered/u,
    );
  });

  it("rejects model evaluation beyond the five-pass qualification boundary", () => {
    const policy = validPolicy();
    policy.implementationRouting.evaluationPasses.maximum = 6;
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /model evaluation must stop by pass five/u,
    );
  });

  it("requires evidence for every cheaper provider skipped before a fallback", () => {
    const state = activeState();
    state.delivery.task.skippedProviders = state.delivery.task.skippedProviders.slice(1);
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /earlier implementation provider/u,
    );
  });

  it("retains implementation qualification evidence through reconciliation", () => {
    const state = reconciledState();
    delete state.delivery.task.qualification;
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /qualified implementation evidence/u,
    );
  });

  it("requires an exact host identity for qualified local Ollama work", () => {
    const state = activeState();
    state.delivery.task = {
      ...state.delivery.task,
      provider: "ollama",
      requestedModel: "qwen2.5-coder:14b-instruct-q4_K_M",
      taskClass: "bounded-implementation",
      skippedProviders: [],
      qualification: {
        status: "qualified",
        provider: "ollama",
        model: "qwen2.5-coder:14b-instruct-q4_K_M",
        taskClass: "bounded-implementation",
        evidenceId: "global-registry:ollama-desktop",
      },
    };
    state.delivery.task.launchReceipt.requestedModel = state.delivery.task.requestedModel;
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /exact host identity/u,
    );

    state.delivery.task.host = "192.168.254.246";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /non-Luna implementation must use a bounded wrapper receipt/u,
    );
    state.delivery.task.launchReceipt = {
      source: "bounded_wrapper",
      runId: "ollama-evaluation-run",
      requestedModel: state.delivery.task.requestedModel,
      baseSha: SHA,
      observedAt: "2026-07-30T06:30:00.000Z",
    };
    state.delivery.task.authoritativeStatus.source = "bounded_wrapper";
    state.delivery.task.authoritativeStatus.runId = "ollama-evaluation-run";
    expect(() => validateOperationalState(state, validPolicy())).not.toThrow();
  });

  it("requires Luna to remain the default orchestrator", () => {
    const policy = validPolicy();
    policy.modelAuthority.orchestration.push("Claude Opus Extra High");
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /default orchestration must remain assigned to Luna Extra High/u,
    );
  });

  it("reserves only the owner-approved specialist decision classes to Sol", () => {
    const policy = validPolicy();
    policy.reservedSpecialist.decisionClasses.push("product_scope");
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /Sol specialist decision classes must match the reserved authority matrix/u,
    );
  });

  it("keeps routine delivery model-open under Luna accountability", () => {
    const policy = validPolicy();
    policy.routineDelivery.modelRestrictedActions = true;
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /routine delivery must remain model-open under Luna accountability/u,
    );
  });

  it("requires explicit human request before a Sol security review", () => {
    const policy = validPolicy();
    policy.reservedSpecialist.securityReviewRequiresExplicitHumanRequest = false;
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /security review must require an explicit human request/u,
    );
  });

  it("enforces the human-final ADR workflow", () => {
    const policy = validPolicy();
    policy.adrGovernance.humanFinalDecision = false;
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /ADR governance must keep Sol specialist assessment and the human final decision/u,
    );
  });

  it("requires an authoritative active-task observation after launch", () => {
    const state = activeState();
    state.delivery.task.authoritativeStatus = null;
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /active delivery requires authoritative task status/u,
    );
  });

  it("rejects a task whose observed base does not match the accepted base", () => {
    const state = activeState();
    state.delivery.task.authoritativeStatus.baseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /task base does not match accepted delivery base/u,
    );
  });

  it("keeps a missing task-list result launch-pending instead of inferring failure", () => {
    const state = activeState();
    state.delivery.stage = "blocked";
    state.delivery.previousStage = "launch_pending";
    state.delivery.task.authoritativeStatus = {
      source: "list_threads_full",
      status: "absent",
      observedAt: "2026-07-30T06:40:00.000Z",
    };
    state.delivery.blocker = {
      kind: "inferred_absence",
      attempts: 1,
      evidence: ["task did not appear in one list response"],
    };
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /task absence is not failure evidence/u,
    );
  });

  it("requires live connector, exact SSH ref, and credential-safe CLI preflight evidence", () => {
    const state = activeState();
    state.accessPreflight.connector.proof = "installed_plugin_files";
    state.accessPreflight.ssh.refs = [];
    state.accessPreflight.cli.credentialMaterialRecorded = true;
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /live connector call/u,
    );
  });

  it("rejects ownership or public-read evidence as proof of protected write access", () => {
    const state = activeState();
    const pullRequestWrite = state.accessPreflight.capabilities.find(
      ({ actionClass }) => actionClass === "pull_request_write",
    );
    pullRequestWrite.evidenceKind = "repository_owner_or_public_read";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /protected write capability requires authenticated write evidence/u,
    );
  });

  it("fails closed before dependent launch when no protected write path is available", () => {
    const state = activeState();
    for (const capability of state.accessPreflight.capabilities) {
      if (["pull_request_write", "protected_merge"].includes(capability.actionClass)) {
        capability.status = "unavailable";
        capability.evidenceKind = "unavailable_result";
      }
    }
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /protected write path is unavailable/u,
    );
  });

  it("requires an explicit user-controlled browser fallback", () => {
    const state = activeState();
    const issueWrite = state.accessPreflight.capabilities.find(
      ({ actionClass }) => actionClass === "issue_write",
    );
    issueWrite.route = "browser_user_controlled";
    state.accessPreflight.browser.userControlled = false;
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /browser fallback must remain explicitly user-controlled/u,
    );
  });

  it("rejects impossible delivery transitions", () => {
    const state = activeState();
    state.delivery.previousStage = "planned";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /planned -> active is not an allowed transition/u,
    );
  });

  it("rejects a policy that treats merge as terminal completion", () => {
    const policy = validPolicy();
    policy.terminalDeliveryStages = ["merged"];
    policy.allowedTransitions.merged = [];
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /reconciled must be the only terminal delivery stage/u,
    );
  });

  it("requires exact protected merge evidence before trusted validation", () => {
    const state = activeState();
    state.delivery.stage = "merged";
    state.delivery.previousStage = "pr_open";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /merged delivery requires exact merge evidence/u,
    );
  });

  it("requires trusted target-branch checks for reconciliation", () => {
    const state = reconciledState();
    delete state.delivery.trustedValidation;
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /trusted delivery requires exact target-branch validation/u,
    );
  });

  it("rejects reconciliation with an incomplete acceptance review", () => {
    const state = reconciledState();
    state.delivery.reconciliation.issue.acceptanceChecklist = "reviewed_incomplete";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /acceptance checklist must be reviewed complete/u,
    );
  });

  it("rejects a reviewed-complete claim that itemises no acceptance criterion", () => {
    const state = reconciledState();
    delete state.delivery.reconciliation.issue.acceptanceCriteria;
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /must itemise every acceptance criterion/u,
    );
  });

  it("rejects an empty itemisation rather than treating it as complete", () => {
    const state = reconciledState();
    state.delivery.reconciliation.issue.acceptanceCriteria = [];
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /must itemise every acceptance criterion/u,
    );
  });

  it("rejects reconciliation while any itemised criterion is unmet", () => {
    const state = reconciledState();
    state.delivery.reconciliation.issue.acceptanceCriteria.push({
      criterion: "Parser interactions are recorded.",
      met: false,
      evidence: ["not yet implemented"],
    });
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /every acceptance criterion must be met/u,
    );
  });

  it("rejects an itemised criterion asserted without its own evidence", () => {
    const state = reconciledState();
    state.delivery.reconciliation.issue.acceptanceCriteria[0].evidence = [];
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /each acceptance criterion requires its own evidence/u,
    );
  });

  it("requires an outcome for every declared parent issue", () => {
    const state = reconciledState();
    state.delivery.parentIssues = [22];
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /every declared parent issue requires one reconciliation outcome/u,
    );
  });

  it("accepts a reconciled child whose parent remains open with precise residual acceptance", () => {
    const state = reconciledState();
    state.delivery.parentIssues = [22];
    state.delivery.reconciliation.parents = [{
      issue: 22,
      childOutcomeRecorded: true,
      acceptanceReevaluated: true,
      state: "open",
      residualAcceptance: [
        "Stable release promotion remains pending exact-digest release acceptance.",
      ],
      observedAt: "2026-07-30T07:25:00.000Z",
    }];
    expect(() => validateOperationalState(state, validPolicy())).not.toThrow();
  });

  it("rejects dependent delivery advancement before dependencies are reconciled", () => {
    const state = activeState();
    state.delivery.dependencies = [{
      issue: 22,
      stage: "trusted",
      observedAt: "2026-07-30T06:20:00.000Z",
    }];
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /dependencies must be reconciled before delivery advances/u,
    );
  });

  it("rejects automatic adoption and under-evidenced controls", () => {
    const controls = {
      schemaVersion: 1,
      controls: [
        {
          id: "ORCH-TEST",
          status: "adopted",
          decisionClass: "protected_planning",
          summary: "Unsafe automatic policy change",
          automaticPromotion: true,
          evidence: ["one observation"],
          issue: 74,
          pullRequest: 75,
          approvedByModel: "Sol Extra High",
        },
      ],
    };
    expect(() => validateAdoptedControls(controls, validPolicy())).toThrow(
      /automatic adoption is prohibited/u,
    );
  });

  it("accepts verified active delivery and reviewed controls", () => {
    const controls = {
      schemaVersion: 1,
      controls: [
        {
          id: "ORCH-001",
          status: "adopted",
          decisionClass: "protected_planning",
          summary: "Verify launches through authoritative task state.",
          automaticPromotion: false,
          evidence: ["creation receipt", "authoritative active task observation"],
          issue: 74,
          pullRequest: 75,
          approvedByModel: "Sol Extra High",
        },
      ],
    };
    expect(() => validateOperationalState(activeState(), validPolicy())).not.toThrow();
    expect(() => validateAdoptedControls(controls, validPolicy())).not.toThrow();
  });

  it("accepts current Sol or human approval and only enumerated historical Claude approvals", () => {
    const ledgerWith = (approvedByModel, pullRequest = 114) => ({
      schemaVersion: 1,
      controls: [
        {
          id: "ORCH-TEST",
          status: "adopted",
          decisionClass: "model_governance",
          summary: "Admit a second agent pipeline with equivalent authority tiers.",
          automaticPromotion: false,
          evidence: ["owner-directed policy change", "protected pull request with passing checks"],
          issue: 113,
          pullRequest,
          approvedByModel,
        },
      ],
    });
    expect(() => validateAdoptedControls(ledgerWith("Human"), validPolicy())).not.toThrow();
    expect(() => validateAdoptedControls(ledgerWith("Sol Extra High"), validPolicy()))
      .not.toThrow();
    expect(() => validateAdoptedControls(
      ledgerWith("Claude Opus Extra High", 131),
      validPolicy(),
    )).not.toThrow();
    expect(() => validateAdoptedControls(ledgerWith("Claude Opus Extra High"), validPolicy()))
      .toThrow(/requires approval by a protected-planning authority or Human/u);
    expect(() => validateAdoptedControls(ledgerWith("Claude Sonnet Extra High"), validPolicy()))
      .toThrow(/requires approval by a protected-planning authority or Human/u);
  });

  it("validates the repository policy, ledger, and example state together", () => {
    const policy = JSON.parse(
      readFileSync(new URL("../.github/orchestration-governance.json", import.meta.url), "utf8"),
    );
    const controls = JSON.parse(
      readFileSync(new URL("../docs/orchestration-controls.json", import.meta.url), "utf8"),
    );
    const state = JSON.parse(
      readFileSync(new URL("../docs/examples/orchestration-state.example.json", import.meta.url), "utf8"),
    );
    expect(() => validateOrchestrationPolicy(policy)).not.toThrow();
    expect(() => validateAdoptedControls(controls, policy)).not.toThrow();
    expect(() => validateOperationalState(state, policy)).not.toThrow();

    const controlStatus = new Map(controls.controls.map((control) => [control.id, control.status]));
    for (const retired of ["ORCH-002", "ORCH-003", "ORCH-011", "ORCH-012"]) {
      expect(controlStatus.get(retired)).toBe("retired");
    }
  });
});
