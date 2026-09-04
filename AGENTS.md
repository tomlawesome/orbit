# Orbit agent instructions

These repository instructions apply to every automated agent working on Orbit,
alongside the global agent instructions.

## Working model

Orbit is maintained by its human owner with AI assistants working under
direction. Architecture and security decisions are recorded in ADRs and
reviewed by the owner; the durable governance decision is
[ADR-0011](docs/adr/0011-operator-experience-as-product.md).

Orbit is Claude-delivered, so the design and architecture calls the global
rules reserve for the top model are Fable's (owner decision, 2026-08-22).
Everything else about who makes those calls, how they are labelled and how
they are routed is global; it is not repeated here.

`ai/orbit-base-image` (GitLab) is part of this project, not a sibling: standing
authorisation to raise issues and make changes there (owner, 2026-08-30).

## Where the work lives

Orbit moved to the owner's own GitLab on 2026-09-04 (#801). **`ai/orbit` on
`gitlab.tomlawson.io`, project id 49, is the source of truth**: issues,
merge requests and the CI that merges wait on. GitHub keeps the repository as
a mirror for CodeQL, secret scanning and a second CI opinion, and GHCR stays
where images are published; a red GitHub run never blocks a GitLab merge.
Issue and MR numbers are GitLab's and do not match the GitHub ones.

Every `glab` call needs the same three settings, because the default `glab`
config points at gitlab.com and `GITLAB_TOKEN` in the environment overrides
the stored credential:

    env -u GITLAB_TOKEN GLAB_CONFIG_DIR=/home/codex/.config/glab-claude \
      GITLAB_HOST=gitlab.tomlawson.io glab <command>

Codex uses its own `GLAB_CONFIG_DIR`; see the github-credentials skill. Host
lookups fail now and then, so wrap calls in two or three tries rather than
treating one failure as an answer. Pushing needs the credential helper
explicitly, because git does not read `glab`'s config:

    git -c credential.helper= -c 'credential.helper=!glab auth git-credential' \
      push gitlab <branch>

`glab issue create` has no `-F`: pass a body with `-d "$(cat file)"`. Notes go
through `glab api -X POST projects/49/issues/<iid>/notes -f body=…`.

Pipelines: an MR pipeline runs the acceptance stage automatically; a branch
pipeline leaves those jobs manual, so an MR is the only way to see the full
gate. `~/.local/bin/gl-pipeline-run ai/orbit <ref>` starts one. Cancelling a
pipeline and playing a manual job are both refused by the safety hook, as are
protected-branch and CI-variable changes: hand the owner the exact steps.
`dev`, `preview` and `main` all take push "No one", merge "Maintainers".

Two runners serve this project, both on the host `gitlab-runners` (8 cores,
19 GB): the shared group runner, and a privileged project runner tagged
`orbit-build` that everything needing a Docker daemon reaches through
`.privileged_runner`. That runner is still owned by the old staging project;
#811 re-registers it under `ai/orbit` and deletes the staging project. Its
`/builds` persists between jobs, so a job that must start clean says so
(#813, and the data-root wipe in `.docker_in_job`).

Renovate replaces Dependabot on this host: `renovate.json` at the repo root,
the `renovate` job in `.gitlab-ci.yml`, and pipeline schedule 5 (`Renovate`,
Mondays 05:00 London, ref `dev`, variable `RENOVATE=true`). It runs nowhere
else; `.github/dependabot.yml` still covers GitHub Actions only.

## Delivery workflow

- Start from an issue with a user outcome, acceptance criteria, non-goals,
  security considerations, test plan, operational impact, and closure evidence.
- Write a failing test first for defects and testable new behaviour. Add
  characterization tests before refactors.
- Run fast checks before container and browser checks.
- Do not close an issue until its acceptance evidence is linked.
- Publish previews only after required checks pass on the protected `preview`
  lane. Test immutable image digests, verify the exact preview source through
  `main`, and promote only the accepted digest without rebuilding it.
- Nothing promotes to `main` before v1.3.0; #547 holds that promotion. So
  `main` stays at v1.2.0 and is expected to be far behind. A Dependabot alert
  or stale pin on `main` is not work: check `dev` first, and if `dev` is
  already fixed the alert clears when v1.3.0 ships. Do not propose a promotion
  as available work.

## Harnesses that already exist

Check the list before building a test rig or handing a check to the owner.

- `scripts/test-all.sh` — backend suite then e2e (`ORBIT_SKIP_E2E` skips e2e)
- `scripts/test-backend.sh` — static analysis and the fast Vitest suite
- `scripts/test-frontend.sh` — Playwright against a running instance
- `pnpm --filter orbit-web fidelity` — the v19 visual gate: stands up the
  adapter-node build and the mockup host, compares 17 screens against the
  committed baselines. In CI it runs pinned to the Playwright image the
  baselines were proven against; run it locally the same way if a diff
  disagrees
- `scripts/test-integration.mjs` — integration suite against a real database
- `scripts/test-e2e-local.sh` — local stack with disposable OIDC and GreenMail
  sidecars, then Playwright
- `scripts/test-install-acceptance.sh` — real fresh install to a healthy
  `/api/health`, asserting `docs/installer-guarantees.md`; OIDC discovery is a
  fixture, so no provider credentials are needed
- `scripts/test-install-bootstrap.sh` — the documented operator path: fetches
  `install.sh` over the network from a branch, pipes it to bash, and proves the
  channel tag resolved to the digest the registry serves right now. Real
  network and registry; only OIDC discovery is redirected, to the `tests/oidc`
  sidecar. Non-interactive path only; `--red` proves the digest assertion fires
- `scripts/test-backup-restore.sh` — backup and restore acceptance drill
- `scripts/test-repair-journeys.sh` — live repair journeys: installs a real
  stack, breaks it, and proves `repair.sh` recovers it (`--list` shows which
  journeys are live and which are still absent)
- `scripts/test-malware-scanner.sh` — ClamAV detection
- `scripts/test-tika-processor.mjs` — Tika document extraction
- `scripts/installer-simulation.sh` — installer command centre UI, no Docker
- `scripts/install-test-browser.sh` — one-time headless browser download
- `scripts/preview-lane-preflight.sh` — preview-lane preflight checks
- `scripts/validate-compose-config.sh` — Compose configuration validation
- `scripts/ci/*.sh` — the container validation sequence, one script per
  workflow step, so GitHub Actions and the GitLab pipeline run the same checks
  rather than two paraphrases of them (#801). Inputs are environment
  variables; `$GITHUB_OUTPUT` and `$GITHUB_ENV` are written only when set
- `scripts/acceptance-mailbox.mjs` — mailbox acceptance record for a digest
- `scripts/sidecar-pins.mjs` — sidecar pin freshness: `check` reports drift
  between compose and policy, a moved tag, and stale packages inside a current
  pin (`--offline` is the drift axis alone, `--red` proves it fires); `sync`
  re-pins both places after a Dependabot bump

## Traps when running things locally

Ten known ways to lose an afternoon, or worse. The first two have open issues;
until those land, this is the procedure.

**Never run `pnpm db:generate`.** `drizzle/meta/` holds snapshots only up to
0004 while the journal has 28 entries, so `drizzle-kit generate` diffs against
a stale snapshot and emits a migration that recreates almost the whole schema.
It looks like success. Hand-write the migration in the style of
`drizzle/0027_instance_authority.sql`, add the journal entry by hand, and
update both `tests/integration/support/migration-fixture.ts` and
`tests/integration/migrations.test.ts`. See #535.

**Compose commands attach to whatever project `.env-orbit` names.**
`COMPOSE_PROJECT_NAME` lives in that file, so
`docker compose --env-file .env-orbit ...` adopts that project and its named
volumes from any checkout or worktree, and the fixed `container_name` pins in
`docker-compose.yml` stop a second stack coexisting. Pass an explicit `-p` for
anything disposable, confirm isolation with
`docker inspect orbit-postgres --format '{{index .Config.Labels "com.docker.compose.project"}}'`
before trusting it, and never run `docker compose down --volumes` against a
project you did not create. See #536.

**Never drive a pty test by closing its own stdin.** `spawnSync({ input })`
closes stdin as soon as the string is written, which under `script` closes the
pty master and makes the next read return EOF instead of blocking — so a widget
that tells a timeout from a read error takes the wrong branch, and the test
either races or silently never exercises what it claims. Keep stdin open for
the life of the child, as `runPty` in `scripts/installer-simulation.test.mjs`
and `runPtyInterrupted` in `scripts/installer-ui.test.mjs` both now do. This
has been diagnosed twice: #510/#512, then again in #552.

**A pty driver's deadline belongs to `scripts/pty-deadline.mjs`.** A child
killed for running out of time has no exit status, so a driver that hands the
result to an exit-code assertion fails with `expected null to be 130` and names
the wrong fault — the child never exited at all. Take the deadline and the
failure from that module rather than writing another timer; a `spawn`-based
driver must reject rather than resolve, and its tests declare
`PTY_TEST_TIMEOUT_MS` so Vitest's 5s default does not speak first. See #595.

**A Compose `file:` secret is a bind mount of an inode, not of a path.** Edit
the file in place and every running container sees it at once; *replace* it --
`mktemp` + `mv`, `tar -x`, `rsync` -- and each container keeps reading the old
file for as long as it keeps running. A plain `docker restart` re-resolves the
mount. This is not academic: repair's rotation lands the new password by rename
precisely so a half-written secret is impossible, which left the database
container reading a spent copy and made repair diagnose its own successful
rotation as failed. Postgres itself never notices, because it reads that file
once at initdb and authenticates from its own catalogue afterwards. See #629.

**Add `ci: acceptance` to a merge request touching schema, migrations or server
code.** Without it the integration and compose jobs skip and the merge request
still reports green.

**`scripts/test-backup-restore.sh` seeds its own state with SQL and nothing
else drives it.** A dropped column passes every unit and integration check and
fails only the compose smoke test — grep it before changing a schema.

**An install run from inside a worktree rewires the main checkout.** pnpm
treats the main checkout as a workspace member to link, so its `node_modules`
fills with symlinks into `.claude/worktrees/<name>/`, and the `orbit` workspace
link disappears. Nothing dangles while that worktree exists, so the checkout
looks healthy until someone removes it. Never run `pnpm install` with a
worktree as the working directory. To check:
`find node_modules web/node_modules -type l -lname '*worktrees*'` must be
empty. Repair is `CI=true pnpm install` from the main checkout root, which
breaks every other session's builds while it runs — agree a window first. See
#784.

**A red compose smoke job can be hiding the next failure.** Its steps run in
one job and it stops at the first, so fixing that step reveals what was behind
it rather than turning the job green — the favicon 404 hid nine e2e failures
all of 2026-09-03. Read the whole job before reporting what a branch needs.

**Never hand-write a control-character range in a regular expression.** The
escapes are what break. Lose them and the intended "control characters or
backslash" collapses into a range running from space to backslash, matching
most ordinary characters — so a path sanitiser rejects every real path, or the
reverse, and no test notices unless it covers the boundary. Scan the string
explicitly instead, as `isApplicationRelative` in
`web/src/routes/login/+page.svelte` does, and give it cases for the empty
string, a protocol-relative `//` and a backslash.

## The demo stack is disposable

The demo deployment (`docker-compose.demo.yml`) carries only test data, so
nothing in it is worth preserving. Do not spend time or tokens keeping an old
demo image or its database alive: if it will not start, rebuild it from current
`dev` and current versions of everything it depends on, rather than repairing
it.

## An issue naming `src/app/` may describe a deleted surface

The v19 rebuild (#411) replaces `src/app/` with `web/` and carries nothing
over, so check the files an issue names against `web/` before picking it up.
Where they have no equivalent there, close it as superseded by #411 rather
than fix a surface that will not ship (#566, #300, 2026-09-01).

## Sources of truth

- `docs/v1-charter.md`: supported product and release contract.
- `docs/architecture.md` and `docs/adr/`: current architecture and durable
  decisions.
- `docs/implementation-plan.md`: the phased roadmap.
- Issues, milestones and labels live on GitLab (`ai/orbit`, project 49), and
  that issue list is the delivery-status surface (owner, 2026-09-04). The
  [GitHub roadmap board](https://github.com/users/tomlawesome/projects/4) is
  retired: it and the GitHub issues are frozen at the 2026-09-04 import, so a
  status read from either is stale. Milestones are capability slices (M0
  onwards), each a coherent outcome with a definition of done; a version
  release moment gets its own milestone holding only its promote-to-main
  issue, and an empty version milestone is a deliberate placeholder for the
  next release rather than clutter (owner, 2026-08-23 and 2026-09-01). Every
  issue carries a milestone. The board's per-issue Status, Priority and Risk
  fields have no GitLab equivalent and were not recreated; #814 holds the
  question of whether anything replaces them.
- `docs/engineering-baseline.md`: evidence-backed capability and gap audit.
- `docs/quality-strategy.md`: test, CI, and definition-of-done policy.
- `docs/feature-register.md`: detailed product direction and constraints, not
  live delivery status.
- `docs/releasing.md`: release procedure and operator acceptance.
- `SECURITY.md`: supported-version and private vulnerability-reporting
  contract.
