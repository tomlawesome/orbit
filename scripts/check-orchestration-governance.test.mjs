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
      orchestration: ["Sol Extra High"],
      protectedPlanning: ["Sol Extra High"],
      architecture: ["Sol Extra High"],
      security: ["Sol Extra High"],
      deliverySequencing: ["Sol Extra High"],
      integration: ["Sol Extra High"],
      publication: ["Sol Extra High"],
      reconciliation: ["Sol Extra High"],
      release: ["Sol Extra High"],
      implementation: ["Claude Haiku", "Claude Sonnet", "Luna Extra High"],
      mechanicalAnalysis: [
        "Terra Medium",
        "Claude Haiku",
        "Claude Sonnet",
        "Luna Extra High",
        "Sol Extra High",
      ],
    },
    implementationDelegation: {
      preferredProvider: "claude",
      taskClasses: {
        mechanical_implementation: "Claude Haiku",
        bounded_implementation: "Claude Sonnet",
      },
      fallback: {
        model: "Luna Extra High",
        allowedReasons: ["claude_unavailable", "claude_capacity_exhausted"],
      },
      constraints: {
        protectedPlanningWriteAllowed: false,
        scopeExpansionAllowed: false,
        deliveryManagementAllowed: false,
        remoteMutationAllowed: false,
        credentialsAllowed: false,
        gitAllowed: false,
        shellAllowed: false,
        browserAllowed: false,
        mcpAllowed: false,
        allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
      },
      advisoryReview: {
        model: "Claude Opus",
        freshUserApprovalRequired: true,
        advisoryOnly: true,
        authorityTransferAllowed: false,
      },
    },
    protectedDecisionClasses: [
      "architecture",
      "model_governance",
      "product_scope",
      "release",
      "repository_settings",
      "security",
      "protected_planning",
    ],
    taskStatusSources: [
      "claude_wrapper",
      "local_result_handoff",
      "create_thread",
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
      mergeFailureDiagnosis: {
        requiredEvidence: ["target_head_ancestry", "merge_state"],
        nonAncestorClassification: "branch_out_of_date",
        mergeErrorAloneProvesAccessFailure: false,
        credentialRequestAllowedBeforeStateDiagnosis: false,
      },
      failClosedBeforeDependentLaunch: true,
      secretsInChat: false,
    },
    deliveryStages: [
      "planned",
      "launch_pending",
      "active",
      "handback",
      "sol_review",
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
      handback: ["sol_review", "blocked"],
      sol_review: ["active", "pr_open", "blocked"],
      pr_open: ["active", "merged", "blocked"],
      merged: ["trusted", "blocked"],
      trusted: ["reconciled", "blocked"],
      reconciled: [],
      blocked: ["planned", "launch_pending", "active", "handback", "sol_review", "pr_open", "merged", "trusted"],
    },
    learning: {
      automaticCandidateCapture: true,
      automaticAdoption: false,
      minimumEvidenceForAdoption: 2,
      prohibitedAutomaticClasses: [
        "architecture",
        "model_governance",
        "product_scope",
        "release",
        "repository_settings",
        "security",
        "protected_planning",
      ],
    },
  };
}

function activeState() {
  return {
    schemaVersion: 1,
    actor: {
      model: "Sol Extra High",
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
        requestedModel: "Claude Sonnet",
        taskClass: "bounded_implementation",
        launchReceipt: {
          source: "claude_wrapper",
          localTaskId: "claude-issue-74-example",
          requestedModel: "Claude Sonnet",
          baseSha: SHA,
          observedAt: "2026-07-30T06:30:00.000Z",
        },
        authoritativeStatus: {
          source: "claude_wrapper",
          status: "active",
          localTaskId: "claude-issue-74-example",
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

describe("orchestration governance", () => {
  it("accepts the canonical authority, transition, and learning policy", () => {
    expect(() => validateOrchestrationPolicy(validPolicy())).not.toThrow();
  });

  it("rejects Terra orchestration work before any mutation", () => {
    const state = activeState();
    state.actor.model = "Terra Medium";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /Terra Medium is not authorized for orchestration/u,
    );
  });

  it("rejects Opus-class Claude as an orchestration authority", () => {
    const state = activeState();
    state.actor.model = "Claude Opus";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /Claude Opus is not authorized for orchestration/u,
    );
  });

  it("rejects Claude implementation models acting as orchestration", () => {
    const state = activeState();
    state.actor.model = "Claude Sonnet";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /Claude Sonnet is not authorized for orchestration/u,
    );
  });

  it("requires every protected automated authority to remain Sol Extra High", () => {
    const policy = validPolicy();
    policy.modelAuthority.integration.push("Claude Opus");
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /integration must be reserved to Sol Extra High/u,
    );
  });

  it("requires Claude to be the preferred bounded implementation provider", () => {
    const policy = validPolicy();
    policy.implementationDelegation.preferredProvider = "codex";
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /Claude must be the preferred implementation provider/u,
    );
  });

  it("requires wrapper and handoff status sources for preferred Claude work", () => {
    const policy = validPolicy();
    policy.taskStatusSources = policy.taskStatusSources.filter(
      (source) => source !== "claude_wrapper",
    );
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /task status sources are incomplete/u,
    );
  });

  it("uses the least suitable Claude tier for each bounded task class", () => {
    const mechanical = activeState();
    mechanical.delivery.task.taskClass = "mechanical_implementation";
    mechanical.delivery.task.requestedModel = "Claude Haiku";
    mechanical.delivery.task.launchReceipt.requestedModel = "Claude Haiku";
    expect(() => validateOperationalState(mechanical, validPolicy())).not.toThrow();

    const mismatched = activeState();
    mismatched.delivery.task.taskClass = "mechanical_implementation";
    expect(() => validateOperationalState(mismatched, validPolicy())).toThrow(
      /mechanical_implementation must use preferred model Claude Haiku/u,
    );
  });

  it("requires Claude completion to return through the local result handoff", () => {
    const state = activeState();
    state.delivery.stage = "handback";
    state.delivery.previousStage = "active";
    state.delivery.resultPath = ".agents/results/issue-74.md";
    state.delivery.localCommits = [SHA];
    state.delivery.task.authoritativeStatus.source = "local_result_handoff";
    state.delivery.task.authoritativeStatus.status = "complete";
    expect(() => validateOperationalState(state, validPolicy())).not.toThrow();

    state.delivery.task.authoritativeStatus.source = "wait_threads";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /Claude handback requires local_result_handoff/u,
    );
  });

  it("permits Luna only for an evidenced Claude availability or capacity fallback", () => {
    const state = activeState();
    state.delivery.task.requestedModel = "Luna Extra High";
    state.delivery.task.launchReceipt.requestedModel = "Luna Extra High";
    state.delivery.task.launchReceipt.source = "create_thread";
    state.delivery.task.launchReceipt.clientThreadId = "client-new-thread:fake-launch-receipt";
    delete state.delivery.task.launchReceipt.localTaskId;
    state.delivery.task.authoritativeStatus.source = "list_threads_full";
    state.delivery.task.authoritativeStatus.threadId = "019fb1bd-b148-79f1-982f-23a3c8695090";
    delete state.delivery.task.authoritativeStatus.localTaskId;
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /Luna fallback requires an allowed reason/u,
    );

    state.delivery.task.fallbackReason = "claude_capacity_exhausted";
    expect(() => validateOperationalState(state, validPolicy())).not.toThrow();

    state.delivery.task.fallbackReason = "user_preference";
    expect(() => validateOperationalState(state, validPolicy())).toThrow(
      /Luna fallback requires an allowed reason/u,
    );
  });

  it("keeps Opus review advisory, task-approved, and authority-neutral", () => {
    const policy = validPolicy();
    expect(policy.implementationDelegation.advisoryReview).toEqual({
      model: "Claude Opus",
      freshUserApprovalRequired: true,
      advisoryOnly: true,
      authorityTransferAllowed: false,
    });
    expect(policy.modelAuthority.orchestration).not.toContain("Claude Opus");
    expect(policy.modelAuthority.protectedPlanning).not.toContain("Claude Opus");
    expect(() => validateOrchestrationPolicy(policy)).not.toThrow();
  });

  it("keeps delegated Claude implementation isolated from protected and remote tools", () => {
    const policy = validPolicy();
    policy.implementationDelegation.constraints.remoteMutationAllowed = true;
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /delegated implementation must not mutate remote state/u,
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

  it("requires ancestry and merge-state evidence before diagnosing protected-merge access", () => {
    const policy = validPolicy();
    policy.remoteAccessPreflight.mergeFailureDiagnosis.requiredEvidence = ["merge_error"];
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /protected-merge diagnosis requires exact target\/head ancestry and merge-state evidence/u,
    );
  });

  it("does not let an out-of-date branch trigger a credential request", () => {
    const policy = validPolicy();
    policy.remoteAccessPreflight.mergeFailureDiagnosis.credentialRequestAllowedBeforeStateDiagnosis = true;
    expect(() => validateOrchestrationPolicy(policy)).toThrow(
      /credential requests must wait for delivery-state diagnosis/u,
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

  it("accepts protected adoption only from Sol, a human owner, or explicit Sol ratification", () => {
    const ledgerWith = (approvedByModel, ratifiedByModel) => ({
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
          pullRequest: 114,
          approvedByModel,
          ...(ratifiedByModel ? { ratifiedByModel } : {}),
        },
      ],
    });
    expect(() => validateAdoptedControls(ledgerWith("Human"), validPolicy())).not.toThrow();
    expect(() => validateAdoptedControls(ledgerWith("Sol Extra High"), validPolicy())).not.toThrow();
    expect(() => validateAdoptedControls(ledgerWith("Claude Opus Extra High"), validPolicy()))
      .toThrow(/requires current Sol Extra High or Human approval/u);
    expect(
      () => validateAdoptedControls(
        ledgerWith("Claude Opus Extra High", "Sol Extra High"),
        validPolicy(),
      ),
    ).not.toThrow();
  });

  it("requires retired protected controls to preserve provenance and record Sol retirement", () => {
    const controls = {
      schemaVersion: 1,
      controls: [{
        id: "ORCH-TEST",
        status: "retired",
        decisionClass: "model_governance",
        summary: "Historic peer-pipeline control retained as superseded evidence.",
        automaticPromotion: false,
        evidence: ["historic policy", "superseding owner decision"],
        issue: 113,
        pullRequest: 114,
        approvedByModel: "Human",
        retirement: {
          issue: 173,
          reason: "Superseded by Sol-owned orchestration with bounded Claude delegation.",
          approvedByModel: "Sol Extra High",
        },
      }],
    };
    expect(() => validateAdoptedControls(controls, validPolicy())).not.toThrow();
    delete controls.controls[0].retirement;
    expect(() => validateAdoptedControls(controls, validPolicy())).toThrow(
      /retired protected control requires retirement evidence/u,
    );
  });

  it("keeps protected governance prose aligned with Sol-owned delegation", () => {
    const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
    const runbook = readFileSync(
      new URL("../docs/orchestration-runbook.md", import.meta.url),
      "utf8",
    );
    const implementationPlan = readFileSync(
      new URL("../docs/implementation-plan.md", import.meta.url),
      "utf8",
    );
    const deliveryAdr = readFileSync(
      new URL("../docs/adr/0002-evidence-driven-delivery.md", import.meta.url),
      "utf8",
    );
    const template = readFileSync(
      new URL("../.github/pull_request_template.md", import.meta.url),
      "utf8",
    );
    const combined = `${agents}\n${runbook}\n${implementationPlan}\n${deliveryAdr}\n${template}`;

    expect(combined).not.toMatch(/peer agent pipeline|equivalent authority tiers/iu);
    expect(combined).not.toContain("Planning-Model: Claude Opus Extra High");
    expect(combined).not.toMatch(/implementation subagents default to Luna Extra High/iu);
    expect(implementationPlan).not.toContain("may run three disjoint Luna Extra High tasks");
    expect(deliveryAdr).toContain("ADR-0009");
    expect(agents).toContain("sole automated orchestration");
    expect(agents).toContain("Claude Haiku");
    expect(agents).toContain("Claude Sonnet");
    expect(agents).toContain("Luna Extra High");
    expect(runbook).toContain("fresh task-specific user approval");
    expect(template).toContain("exactly one");
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
  });
});
