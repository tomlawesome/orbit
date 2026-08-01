# Orbit agent instructions

These repository instructions apply to every automated agent working on Orbit.
The repository is the source of truth; chat history is not.

## Model governance

Broad product planning, architecture, security-model, systems-design, roadmap,
ADR, release-policy, engineering-baseline, integration, publication,
reconciliation and release work is reserved for **Sol Extra High**. Sol Extra
High is Orbit's sole automated orchestration and protected-planning authority.
Only Sol Extra High may materially create, edit, approve, restructure or
publish the protected planning files listed in
`.github/planning-governance.json`. A human owner remains an explicit planning
authority for work they author or direct.

Claude is the preferred bounded implementation resource. Sol chooses the least
capable suitable Claude tier: **Claude Haiku** for mechanical implementation and
**Claude Sonnet** for substantive bounded implementation. **Luna Extra High** is
the implementation fallback only when Claude is unavailable or its capacity is
exhausted. Terra may perform separately bounded mechanical analysis, but cannot
operate the delivery loop or make status or next-action decisions.

Every delegated implementation starts from an exact Sol-accepted base and a
bounded handoff naming permitted paths, protected paths, acceptance criteria,
tests and hard stop conditions. Delegated Claude work is isolated and may use
only read/search and file-edit tools; it receives no credentials and may not use
Git, GitHub, shell, browser or MCP tools, mutate remote state, edit protected
planning, manage delivery, expand scope, approve its own work or make
architecture, security, integration, publication or release decisions. Sol
independently reviews every changed line, preserves truthful authorship and
provenance, integrates accepted handbacks on a Sol-owned branch and retains all
GitHub and delivery authority.

Opus-class Claude may provide secondary review only after fresh, task-specific
user approval. Its findings are advisory evidence for Sol; review never grants
Claude approval, orchestration, protected-planning, integration or release
authority.

Pull requests that modify protected planning files must contain exactly one
accepted attestation line from `.github/planning-governance.json`:
`Planning-Model: Sol Extra High` or `Planning-Model: Human` when a human owner
authored or directed the change. Zero, duplicate, conflicting, unsupported or
otherwise ambiguous `Planning-Model:` lines fail the gate. This is a governance
control, not cryptographic proof of identity; authors must never attest as an
authority that did not do the work.

Write bounded handoffs under `.agents/handoffs/`. Handoff files are local
coordination state and are not committed. Prefer the repository's approved
Claude wrapper for Claude tasks. If Claude is unavailable or capacity-exhausted
and Luna is absent from the current subagent pool, use the Codex task launcher,
when available, for a separate Luna Extra High task. Do not ask the user to
switch the current task manually unless both delegated routes have genuinely
failed.

## Orchestration and retained learning

Before any delivery mutation, read and obey
`docs/orchestration-runbook.md` and
`.github/orchestration-governance.json`. Run
`pnpm orchestration:check` when dependencies are available.

Before attributing a protected-merge error to credentials or connector access,
prove target/head ancestry and read the current merge state. Treat a
non-ancestor head as an out-of-date delivery branch, and never request new or
broader authentication from a merge error alone.

Model authority is a preflight gate, not a review-time correction. All
orchestration—including task launch, monitoring, sequencing, reconciliation,
blocker classification, handback acceptance and retained-learning
promotion—proceeds only under Sol Extra High. Delegated implementation and
mechanical-analysis models hand control back to Sol and cannot materially
create, edit, approve, restructure or publish protected planning.

A successful asynchronous task-creation response establishes
`launch_pending`. Omission from a partial, limited, paginated, stale or
differently shaped task list never proves creation failure. Confirm the real
task ID, requested model, worktree and state through a full task listing,
direct task read or bounded task wait before advancing or retrying creation.

Capture operational contradictions as safe local candidate lessons. Durable
controls are recorded in `docs/orchestration-controls.json` only after the
evidence, issue, model-authority, regression-test, protected-PR and CI gates in
the orchestration runbook pass. Automation must never self-adopt product,
architecture, security, model-governance, repository-setting, protected
planning or release-policy changes.

## Delivery workflow

- Start from an issue with a user outcome, acceptance criteria, non-goals,
  security considerations, test plan, operational impact, and closure evidence.
- Use short-lived `codex/` branches and small pull requests. Do not work
  directly on protected branches.
- Write a failing test first for defects and testable new behaviour. Add
  characterization tests before refactors.
- Run fast checks before container and browser checks.
- Do not close an issue until its acceptance evidence is linked.
- Publish previews only after required checks pass. Stable release acceptance
  uses a preview from the matching versioned release branch. Test immutable
  image digests and promote only the accepted digest without rebuilding it.
- Never commit credentials, secrets, private keys, tokens, private documents,
  or real personal data.

## Sources of truth

- `docs/v1-charter.md`: supported product and release contract.
- `docs/architecture.md` and `docs/adr/`: current architecture and durable
  decisions.
- `docs/engineering-baseline.md`: evidence-backed capability and gap audit.
- `docs/quality-strategy.md`: test, CI, and definition-of-done policy.
- GitHub issues and milestones: delivery status and prioritisation.
- `docs/feature-register.md`: detailed product direction and constraints, not
  live delivery status.
- `docs/releasing.md`: release procedure and operator acceptance.
- `SECURITY.md`: supported-version and private vulnerability-reporting
  contract.
