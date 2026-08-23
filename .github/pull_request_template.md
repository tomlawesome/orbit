## Outcome

Describe the user or operator outcome and link the issue(s) this pull request
closes.

Closes #

Ordinary issue branches start from and target `dev`. Release-train pull
requests merge `dev` into `preview`, then the accepted `preview` into
`main`. A hotfix must identify its later `dev`/`preview` reconciliation.

## Changes

-

## Risk and compatibility

- Security/authorization:
- Data/migrations:
- Operations/deployment:
- Compatibility:

## Operational observability

Describe the bounded operational evidence for this change. For `changed`, fill
all four entries with concise event/state, failure/recovery, privacy/redaction,
and operator-documentation impact details. For no operational impact, explain
the specific reason after the declaration below. Use exactly one declaration
line; do not leave placeholders in a submitted pull request.
The changed declaration is `Observability-Impact: changed`; the none
declaration below must replace its placeholder with a specific reason.

- Operational event/state: <what operators should observe, including fixed classification and action>
- Failure/recovery: <failure and recovery evidence>
- Privacy/redaction: <what is excluded or redacted, including negative-test evidence>
- Operator-documentation impact: <changed documentation, or why none is needed>

> Reviewer note: Logs describe transient operational events; the audit trail records durable security or business actions; public health is a content-free readiness contract; and the authenticated admin UI presents bounded corrective diagnostics. They are distinct surfaces, and one must not be treated as a substitute for another.

Observability-Impact: none — <specific reason>

## Validation

- [ ] Acceptance criteria are covered.
- [ ] Relevant negative and failure-path tests pass.
- [ ] Fast local checks pass.
- [ ] Container/browser checks are delegated to CI where required.
- [ ] Documentation and operational guidance reflect the change.
- [ ] The diff contains no credentials, personal data, debug output, or
      unrelated files.
- [ ] Generated build/test artifacts and local coordination files are absent
      from the tracked diff.
- [ ] No unmerged unique work must remain on the short-lived head branch; it
      may be deleted after protected merge and reconciliation.
