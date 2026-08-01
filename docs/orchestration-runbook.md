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
Protected planning, architecture, security, integration, publication, release,
repository-setting, product-scope and model-governance work has the same gate.
Delegated models may read protected planning for orientation but cannot operate
the delivery loop, make status or next-action decisions, mutate GitHub or edit
protected planning.

Use Claude as the preferred bounded implementation resource. Select Claude
Haiku for mechanical implementation and Claude Sonnet for substantive bounded
implementation, then invoke the approved isolated wrapper with the exact base,
path allowlist, result path and hard stops. Use Luna Extra High only when Claude
is unavailable or capacity-exhausted, and record that fallback reason. Sol
reviews and integrates every handback. Opus-class secondary review requires
fresh task-specific user approval and remains advisory evidence only.

## Launch receipt and task-state protocol

Both delegated routes require a launch receipt. A Claude wrapper receipt records
the requested model, task class, exact base, safe local task identifier and
observation time. Its authoritative active observation comes from the wrapper;
its completed handback comes from the required local result file and focused
diff. The Luna fallback uses the asynchronous Codex task protocol below.

A successful Codex task-creation response is a launch receipt, not proof that
the task is already queryable.

1. Record the requested model, task class, exact base SHA, creation source,
   timestamp and route-specific identifier: `localTaskId` for Claude or the
   returned `threadId`/`clientThreadId` for Luna.
2. Move from `planned` to `launch_pending`.
3. For a Codex task, resolve a client task to its real task ID through a full
   task listing.
   Do not pass a client ID to tools that require a real task ID.
4. Confirm a Luna task through a full list, direct read or wait response. For
   Claude, record the wrapper's authoritative active state and require the
   configured local result handoff before completion. Record the worktree,
   status and observation time in either route.
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
6. exact post-merge target-branch validation;
7. issue acceptance, closure evidence and every declared parent outcome; and
8. the next action permitted by the dependency and milestone/wave graph.

`handback` requires a result file and focused local commits.
`sol_review` is the mandatory Sol acceptance stage. It requires independent
diff, test, privacy, credential, dependency and protected-path review of every
delegated handback. `pr_open` requires a pushed short-lived branch and
linked issue. `merged` requires the exact protected merge SHA, pull request and
target branch, but it is not terminal completion. `trusted` requires successful
target-branch checks for that exact merge SHA. `reconciled` is the only
terminal delivery state.

Before entering `reconciled`, update the delivered issue's acceptance
checklist against linked evidence, add bounded closure evidence, close it as
completed, and record one outcome for every parent declared when delivery was
planned. Each parent outcome records the child result and re-evaluates the
parent's acceptance. A genuinely incomplete parent remains open with its
precise residual acceptance; it is never bulk-closed or inferred complete from
a child title. Re-evaluate the milestone or wave gate after those parent
updates. A dependent delivery remains `planned` until every declared
dependency is `reconciled`.

After reconciliation, perform a bounded repository-hygiene pass. Confirm that
the pull request is no longer open, no generated build/test artifact or local
coordination file entered the tracked tree, and the short-lived remote head is
eligible for deletion. Delete a remote branch only after recording its exact
head SHA and merged or independently proven superseding outcome, and only with
the required explicit authority for destructive remote state. Preserve
`main`, `develop`, active `release/*` and `hotfix/*` branches, active task
branches, and any unreviewed unique commit. Local worktrees remain until their
commits and result handoffs have been accepted or safely retained.

GitHub closing keywords apply only through the repository's default-branch
semantics. A merge to another integration branch does not replace explicit
issue reconciliation. A merge response, issue mutation or other remote action
with an ambiguous result is re-read before retry.

Operational state may name issue numbers, public commit SHAs, task IDs,
public workflow run IDs and outcomes, worktree paths, bounded acceptance
summaries, safe status categories and timestamps. It must not contain prompts,
task output, credentials, provider configuration, mail/document content,
personal data, private repository enumeration or raw errors that may carry
sensitive material.

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

## Wave concurrency

Disjoint file ownership is necessary but not sufficient grounds to run slices
concurrently. Disjoint files prevent merge conflicts; they do not prevent
revalidation churn, and they do not establish whether a sibling landing first
would invalidate a slice's premises.

Each slice therefore records a concurrency assessment in the implementation
plan. A slice is concurrent when a sibling landing first requires at most a
rebase, and sequenced when it would force rework. A sequenced slice waits for a
later wave rather than running in parallel and being rewritten.

While the target branch requires up-to-date branches, keep at most two pull
requests in flight regardless of assessment. Every merge leaves every other open
pull request behind its base and forces a full revalidation, so concurrency
beyond that costs more than it returns.

## Investigating a delivery failure

A required check halts at the first blocker, so its output is never the complete
fault list. Later instances of the same mistake stay invisible until the earlier
one is corrected.

Investigate a failure as a **fault class**, not a single instance. Identify the
general shape of the mistake, then inspect the whole change for other places
that shape occurs, and correct all of them together. Record the identified class
and the scope swept in the pull request, so a reviewer sees what was checked
rather than inferring it.

Correcting only the reported instance converts one review pass into one
validation cycle per instance, and each cycle establishes nothing except that
another instance exists.

A hypothesis is not a diagnosis. Where a correction rests on an unproven cause,
say so, and prefer evidence that distinguishes causes over a change that merely
makes the symptom disappear.

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
