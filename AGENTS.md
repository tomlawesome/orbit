# Orbit agent instructions

These repository instructions apply to every automated agent working on Orbit,
alongside the global agent instructions.

## Working model

Architecture and security decisions are recorded in ADRs; the durable
governance decision is
[ADR-0011](docs/adr/0011-operator-experience-as-product.md).

`ai/orbit-base-image` (GitLab) is part of this project, not a sibling: standing
authorisation to raise issues and make changes there (owner, 2026-08-30).

## Where the work lives

Orbit moved to the owner's own GitLab on 2026-09-04 (#801). **`ai/orbit` on
`gitlab.tomlawson.io`, project id 49, is the source of truth**: issues,
merge requests and the CI that merges wait on. GitHub is a push mirror
(GitLab Settings → Repository → Mirroring, owner-managed) kept for CodeQL,
secret scanning and a second CI opinion; a red GitHub run never blocks a
GitLab merge. GHCR stays where operators pull from: `publish_gitlab` pushes
the tested image to `registry.tomlawson.io` and records its digest, and
`.github/workflows/publish-from-gitlab.yml` copies that digest to GHCR when
the mirror delivers the `preview` push -- nothing built on GitHub reaches a
registry. Issue and MR numbers are GitLab's and do not match the GitHub ones.

Every `glab` call needs the same three settings, because the default `glab`
config points at gitlab.com and `GITLAB_TOKEN` in the environment overrides
the stored credential:

    env -u GITLAB_TOKEN GLAB_CONFIG_DIR=/home/codex/.config/glab-claude \
      GITLAB_HOST=gitlab.tomlawson.io glab <command>

Codex uses its own `GLAB_CONFIG_DIR`; see the github-credentials skill. Host
lookups fail now and then, so wrap calls in two or three tries rather than
treating one failure as an answer. Pushing needs the credential helper
explicitly, because git does not read `glab`'s config -- and needs the same
env prefix on the `git` command itself:

    env -u GITLAB_TOKEN GLAB_CONFIG_DIR=/home/codex/.config/glab-claude \
      GITLAB_HOST=gitlab.tomlawson.io \
      git -c credential.helper= -c 'credential.helper=!glab auth git-credential' \
      push gitlab <branch>

The prefix is on `git`, not on the surrounding shell, because git spawns
`glab auth git-credential` as a subprocess: it reads the environment *git* was
given, not the one your `glab` calls used. Prefix the glab calls alone and the
helper falls back to the default glab config, which on this host is Codex.

Nothing fails when that happens. The push succeeds, the commits keep their real
author, and `glab api user` still answers Claude -- because it tests the api
path, not the push path. The only trace is the *pipeline's trigger user*, which
is not the merge request's author. Five branches went out as Codex on
2026-09-07 before the owner spotted it. To check a push you have just made:

    env -u GITLAB_TOKEN GLAB_CONFIG_DIR=/home/codex/.config/glab-claude \
      GITLAB_HOST=gitlab.tomlawson.io glab api projects/49/pipelines/<id> \
      | python3 -c "import json,sys; print(json.load(sys.stdin)['user']['username'])"

`glab issue create` has no `-F`: pass a body with `-d "$(cat file)"`. Notes go
through `glab api -X POST projects/49/issues/<iid>/notes -f body=…`.

Pipelines: an MR pipeline runs the acceptance stage automatically; a branch
pipeline leaves those jobs manual, so an MR is the only way to see the full
gate. `~/.local/bin/gl-pipeline-run ai/orbit <ref>` starts one. Cancelling a
pipeline and playing a manual job are refused by the safety hook here, on top
of the refusals the gitlab-first-migration skill lists.
`dev`, `preview` and `main` all take push "No one", merge "Maintainers".

Two runners serve this project, both on the host `gitlab-runners` (32 cores,
48 GB): the shared group runner, and runner 8, a privileged project runner
owned by `ai/orbit` and tagged `orbit-build`, that everything needing a
Docker daemon reaches through `.privileged_runner` (#811). Its `/builds`
persists between jobs, so a job that must start clean says so (#813, and the
data-root wipe in `.docker_in_job`).

A push starts a pipeline only on `dev`, `preview`, `main` and `hotfix/*`; a
working branch is tested by its merge request, so open the MR straight after
the first push (#829). `gl-pipeline-run` still starts one on any branch.

Renovate replaces Dependabot on this host: `renovate.json` at the repo root,
the `renovate` job in `.gitlab-ci.yml`, and pipeline schedule 5 (`Renovate`,
Mondays 05:00 London, ref `dev`, variable `RENOVATE=true`). It runs nowhere
else and covers GitHub Actions too; `.github/dependabot.yml` is gone. It
deliberately excludes the Orbit base image (`renovate.json`'s
`matchPackageNames` entry says why); `base_image_repin` below owns that one.

The `base_image_repin` job (#708) detects the pinned Orbit base image being
behind and opens a merge request re-pinning it, sourced from
`ai/orbit-base-image`'s own `publish` job artifact rather than an
independently resolved tag. It needs its own schedule (variable
`BASE_IMAGE_REPIN=true`). It never rebuilds anything, never pushes to
`dev`/`preview`/`main`, and never merges; it pushes
`chore/base-image-repin` and opens or refreshes one merge request from it.

Reading that artifact needs no stored credential (investigated on #708,
2026-09-06 -- a group-wide `ai` token was the first cut and was narrowed
once cross-project job-token access turned out to cover artifact downloads):
the job's own `CI_JOB_TOKEN` does it, because `ai/orbit-base-image`'s CI/CD
job token allowlist (Settings > CI/CD > Job token permissions > **CI/CD job
token allowlist** > Add) names `ai/orbit`, and the user the schedule runs as
already has at least Reporter access to `ai/orbit-base-image` -- job-token
cross-project reads need both the allowlist entry and that membership.
Create the schedule under the same user as `renovate` and
`sidecar_pin_freshness` (currently `Claude`, already Maintainer on
`ai/orbit-base-image`) and the membership half needs nothing further.
Pushing the branch and opening the merge request still needs a stored
token, since `CI_JOB_TOKEN`'s Merge Requests API access is read-only:
`BASE_REPIN_TOKEN`, a project access token on `ai/orbit` ONLY (`api` scope,
Developer role) -- see the job's comment in `.gitlab-ci.yml` for why a
group token or a second project token were not adopted.

## Delivery workflow

- Run fast checks before container and browser checks: this project's
  container and browser suites cost minutes each, and the fast suite catches
  most of what they would.
- Nothing promotes to `main` before v1.3.0; #547 holds that promotion. So
  `main` stays at v1.2.0 and is expected to be far behind. A Renovate-flagged
  stale pin on `main` is not work: check `dev` first, and if `dev` is already
  fixed it clears when v1.3.0 ships. Do not propose a promotion as available
  work.

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
  sidecar. Non-interactive path only; `--red` proves the digest assertion
  fires. Runs two ways (#724): weekly, via the `install_bootstrap` job in
  `.gitlab-ci.yml` (maintenance stage, `INSTALL_BOOTSTRAP=true`) — `--red`
  then the green run, both in that one job; and green-only, via
  `verify_bootstrap` in `.github/workflows/publish-from-gitlab.yml`, right
  after that workflow's `publish` job moves GHCR's `preview` tag — the
  publication path that can actually invalidate what the harness asserts
- `scripts/test-backup-restore.sh` — backup and restore acceptance drill
- `scripts/test-repair-journeys.sh` — live repair journeys: installs a real
  stack, breaks it, and proves `repair.sh` recovers it (`--list` shows which
  journeys are live and which are still absent)
- `scripts/test-malware-scanner.sh` — ClamAV detection
- `scripts/test-secret-scan.sh` — proves the `gitleaks` CI job's full-history
  scan actually fires: plants a synthetic secret in a throwaway `mktemp -d`
  git repo (never committed to Orbit) and asserts detection and redaction
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
  re-pins both places after a Renovate bump
- `scripts/ci/repin-base-image.sh` — base image freshness (#708): compares
  the Dockerfile pin to ai/orbit-base-image's published-digest.txt artifact
  and, on a mismatch, re-pins every location and opens a merge request;
  `--red` proves the comparison fires, `--dry-run` stops before any commit,
  push or merge-request call

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

## Anything the owner must look at is hosted, never a file path

The owner cannot open files on this VM. A mockup is served from an
`nginx:alpine` container with a published port (the standing pattern —
`docker run -d --name orbit-<issue>-review -p <port>:80 -v <dir>:/usr/share/nginx/html:ro nginx:alpine`),
and a built screen is the demo stack (`bash scripts/build-container.sh`, then
`docker compose -p orbit-demo --env-file .env-orbit -f docker-compose.yml
-f docker-compose.mail.yml -f docker-compose.acceptance.yml
-f docker-compose.demo.yml up -d` with `DEMO_HOST`, `ORBIT_IMAGE`,
`ORBIT_BIND_ADDRESS=127.0.0.1`, `ORBIT_PORT=3001` set). Hand over clickable
`https://<DEMO_HOST>:3443/<route>` links plus the one-time self-signed cert
warning on `:3443` and `:4443`. A screenshot or fidelity baseline is
supporting evidence, not the review: sign-off is on the running code
(owner, 2026-09-05, #474).

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
  status read from either is stale. The board's per-issue Status, Priority and
  Risk fields have no GitLab equivalent and nothing replaces them (owner,
  2026-09-04, #814): the milestone says what is scheduled and open/closed
  says what is done.
- `docs/engineering-baseline.md`: evidence-backed capability and gap audit.
- `docs/quality-strategy.md`: test, CI, and definition-of-done policy.
- `docs/feature-register.md`: detailed product direction and constraints, not
  live delivery status.
- `docs/releasing.md`: release procedure and operator acceptance.
- `SECURITY.md`: supported-version and private vulnerability-reporting
  contract.
