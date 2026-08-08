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
next-action decisions.

Bounded implementation follows the cheapest-qualified-idle-capacity preference
in `AGENTS.md` and `.github/orchestration-governance.json`. The task state
records the selected provider, exact model, task class, qualification evidence,
exact host for local Ollama, and an evidenced reason for every cheaper provider
skipped. A cheaper provider already occupied by an independent task is an
accepted reason only when the provider-concurrency evidence in the Wave
concurrency section is complete. Every provider returns control to Sol for
review and delivery. Claude Opus-class secondary review requires fresh user
approval and remains advisory only.
Correctness, hidden-edge, scope, handback honesty and context-fit evidence
determine qualification. Cost, latency, resource observations and current
capacity inform routing. Routine token, price and turn caps are not task or
capability controls. Detect a genuine stall from task- and model-appropriate
time to first useful output or time since meaningful progress, and include a
reasonable benefit-of-the-doubt buffer before intervening. Slow useful work is
not stalled.

Qualification and tuning stop as soon as a model is satisfactory and never
exceed five passes for one representative task class. Basic acceptance is
required by pass three; passes four and five may only fine-tune an already
acceptable result.

## Launch receipt and task-state protocol

Luna task creation is asynchronous. A successful creation response is a launch
receipt, not proof that the task is already queryable. Local Ollama, Mistral and
Claude runs instead use an approved bounded wrapper whose receipt records a
local run ID; it grants no remote or orchestration authority.

1. Record the provider, exact model, task class, qualification evidence, exact
   base SHA, source and timestamp. A Luna receipt records `threadId` or
   `clientThreadId`; a wrapper receipt records its bounded `runId`.
2. Move from `planned` to `launch_pending`.
3. For Luna, resolve a client task to its real task ID through a full task listing.
   Do not pass a client ID to tools that require a real task ID.
4. Confirm Luna through a full list, direct read or wait response. Record
   its real task ID, worktree, status and observation time.
5. Confirm a wrapper run through its bounded status/result channel. Move to
   `active` only when the authoritative observation matches the provider,
   model, worktree and accepted base.
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
`sol_review` is the Sol-owned orchestration-review stage. It requires
independent diff, test, privacy, credential, dependency and protected-path
review. `pr_open` requires a pushed short-lived branch and
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
`main`, `develop`, `preview`, active `hotfix/*` branches, active task
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

Provider cost order does not force otherwise independent work to serialize.
When the cheapest qualified provider is already active, Sol may select the next
qualified provider for another ready issue only when the task record proves:

- the occupied cheaper provider's exact task, qualification evidence, issue
  and allowed paths;
- a different selected issue with exact disjoint allowed paths and satisfied
  dependencies;
- that either sibling landing first requires no more than a rebase and
  revalidation, never a change of premises or redesign;
- a concrete throughput benefit from starting now rather than waiting; and
- no more than two projected in-flight pull requests.

Concurrency never justifies escalating or duplicating the same task, using an
unqualified model, overlapping paths, broadening delegated authority or
opening a third pull request. Within each task, use the least-cost model already
qualified for that task class. Sol still reviews and integrates handbacks
sequentially.

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
