# Release record template

Copy this file to `docs/releases/vX.Y.Z.md` before step 1 of
[docs/releasing.md](../releasing.md), replace every `<...>`, and commit it on
`dev` with `git commit -s`. See "The signed release record" in the guide
for what each line must say, and keep one `step N:` line per numbered step of
"What you do, in short", in the guide's order. A step says one of:

- `done: <link or job id>`
- `not-needed: <the owner decision that says so>`
- `after-merge` (the step comes after this promotion)

An empty value or a `<...>` placeholder fails the check.

---

version: vX.Y.Z
guide-blob: <git rev-parse HEAD:docs/releasing.md>
guide-commit: <git log -1 --format=%H -- docs/releasing.md>

step 1: after-merge
step 2: after-merge
step 3: after-merge
step 4: after-merge
step 5: after-merge
step 6: after-merge

Signed-off-by: <Name> <<email>>
