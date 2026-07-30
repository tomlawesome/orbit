# Orbit delivery orchestration and retained learning

## Purpose and authority

This runbook makes delivery coordination verifiable and makes operational
lessons durable without turning automation into an unreviewed policy author.
GitHub issues and milestones remain the live delivery source of truth. ADRs,
the v1 charter, architecture, quality strategy and protected planning remain
the durable product and engineering sources of truth.

The machine-readable policy is
`.github/orchestration-governance.json`. Adopted controls are recorded in
`docs/orchestration-controls.json`. A task may keep ephemeral coordination
state in `.agents/orchestration-state.json`; that file is local, contains no
private content and is never committed.

## Mandatory preflight

Before any mutation, delivery agent or heartbeat:

1. reads the root `AGENTS.md`, planning governance, this runbook and the
   orchestration policy;
2. records the active model and intended role;
3. validates model authority for the orchestration role and action class;
4. resolves the issue, accepted base SHA, target branch and permitted paths;
5. checks the tracked and untracked working tree without discarding unrelated
   work; and
6. runs `pnpm orchestration:check` when the repository dependencies are
   available.

The same preflight records remote access before launching or advancing
dependent work:

1. prove the GitHub connector is mounted with a live repository, issue or pull
   request call; installed plugin files or settings are not mounting evidence;
2. read the exact accepted base and delivery refs over SSH without mutation;
3. check the CLI account plus repository, issue, pull-request and Actions read
   capabilities without reading or recording credential material;
4. record each required remote action class as `available`, `unavailable` or
   `untested`, with its authenticated evidence and route;
5. route GitHub actions through the live connector first, the CLI second, and
   an explicitly user-controlled browser only as the last resort; and
6. fail closed before dependent implementation starts or advances when no
   authenticated pull-request and protected-merge path is available.

Repository ownership, an administrator label, a public read, installed
connector files or successful SSH fetch do not prove issue, pull-request,
Actions or protected-merge write authority. A successful write endpoint or a
separate authenticated capability check is required. Never ask a remote user
to put a token, password, device code, recovery code, session value or other
authentication material in chat.

All orchestration—including task launch, monitoring, sequencing,
reconciliation, blocker classification, handback acceptance, delivery
decisions and retained-learning promotion—is a hard **Sol Extra High** gate.
Protected planning, architecture, security, release, repository-setting,
product-scope and model-governance work has the same gate. Terra may read for
orientation or perform explicitly bounded mechanical analysis outside the
orchestration role, but it cannot operate the delivery loop or make status and
next-action decisions. Luna Extra High remains the default for bounded
implementation and returns control to Sol for review and delivery. A different
implementation model requires fresh user approval under `AGENTS.md`.

## Launch receipt and task-state protocol

Task creation is asynchronous. A successful creation response is a launch
receipt, not proof that the task is already queryable.

1. Record the requested model, exact base SHA, creation source, timestamp and
   returned `threadId` or `clientThreadId`.
2. Move from `planned` to `launch_pending`.
3. Resolve a client task to its real task ID through a full task listing.
   Do not pass a client ID to tools that require a real task ID.
4. Confirm the task through a full list, direct read or wait response. Record
   its real task ID, worktree, status and observation time.
5. Move to `active` only when that authoritative observation matches the
   requested model, repository, worktree and accepted base.
6. Use direct reads only for diagnosis. Use bounded task waits for ordinary
   monitoring and handback.

A missing entry in a partial, paginated, limited, stale or differently shaped
task-list response is **status unknown**. It remains `launch_pending`; it is
not evidence that creation failed. Do not create a duplicate while a launch
receipt remains unresolved unless creation itself returned a definite error
or an authoritative task record proves terminal failure.

## Delivery states and reconciliation

The only states and transitions are defined by the orchestration policy. Each
heartbeat reconciles, in order:

1. current issue and dependency state from GitHub;
2. accepted remote base and branch SHA;
3. full active-task state and generated worktree;
4. local result handoff and focused commit;
5. pull request head, reviews, required checks and merge state; and
6. the next action permitted by the dependency graph.

`handback` requires a result file and focused local commits.
`sol_review` requires independent diff, test, privacy, credential, dependency
and protected-path review. `pr_open` requires a pushed short-lived branch and
linked issue. `merged` requires the exact protected merge SHA and required
checks. A merge response or remote mutation with an ambiguous result is
re-read before retry.

Operational state may name issue numbers, public commit SHAs, task IDs,
worktree paths, safe status categories and timestamps. It must not contain
prompts, task output, credentials, provider configuration, mail/document
content, personal data, private repository enumeration or raw errors that may
carry sensitive material.

## Retained-learning loop

Automation may capture a candidate lesson when observed state contradicts the
runbook, the same recoverable failure repeats, or a high-impact control gap is
proven. The candidate records:

- a short factual summary;
- safe evidence and impact;
- the affected decision class;
- the proposed deterministic check or runbook rule; and
- whether independent work can safely continue.

Candidate capture is automatic and local. Durable adoption is never automatic.
An adopted control requires:

- at least the policy's minimum independent evidence;
- a scoped issue with outcome, limits, security and test plan;
- Sol Extra High review for protected or high-impact classes;
- a failing regression test where behaviour is executable;
- a protected pull request with the required planning attestation; and
- passing required checks.

Future tasks and heartbeats read the adopted-control ledger during preflight,
so accepted learning is applied without depending on chat memory.

## Circuit breakers and limits

Stop the affected action and preserve evidence when:

- the active model lacks authority;
- base, branch, task, worktree or remote mutation state is contradictory;
- credentials, provider access or new user authority is required;
- the action changes repository settings outside explicit issue authority;
- a product, security, architecture or release decision is unresolved;
- a destructive or irreversible action lacks an exact target and approval; or
- tests would need to be weakened or protections bypassed.

Ordinary technical failures, CI waits and incomplete implementation are not
hard blockers. Retry them through bounded, evidence-based recovery or progress
independent work that does not violate dependencies.

Automation may never self-adopt changes to product scope, architecture,
security, model governance, repository settings, protected planning, release
criteria or stable-promotion policy. Those changes always use the protected
issue and pull-request path.

## Validation

Run the canonical policy, control-ledger and example-state validation with:

```text
pnpm orchestration:check
```

Validate a current local coordination state explicitly with:

```text
node scripts/check-orchestration-governance.mjs --state .agents/orchestration-state.json
```
