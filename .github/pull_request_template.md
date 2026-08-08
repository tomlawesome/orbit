## Outcome

Describe the user or operator outcome and link the issue(s) this pull request
closes.

Closes #

Ordinary issue branches start from and target `develop`. Release-train pull
requests merge `develop` into `preview`, then the accepted `preview` into
`main`. A hotfix must identify its later `develop`/`preview` reconciliation.

## Changes

-

## Risk and compatibility

- Security/authorization:
- Data/migrations:
- Operations/deployment:
- Compatibility:

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

## Planning governance

Leave the next line unchanged for implementation-only pull requests. If this
pull request changes a path protected by `.github/planning-governance.json`,
replace `Not applicable` with the authority that did the planning work:
`Sol Extra High`, or `Human` when a human owner authored or directed the
change. Never attest as an authority that did not do the work.

Planning-Model: Not applicable
