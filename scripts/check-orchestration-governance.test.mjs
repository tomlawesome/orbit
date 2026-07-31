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
    modelAuthority: {
      orchestration: ["Sol Extra High"],
      protectedPlanning: ["Sol Extra High"],
      implementation: ["Luna Extra High"],
      mechanicalAnalysis: ["Terra Medium", "Luna Extra High", "Sol Extra High"],
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
    taskStatusSources: ["create_thread", "list_threads_full", "read_thread", "wait_threads"],
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
        requestedModel: "Luna Extra High",
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
