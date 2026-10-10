# Orbit agent instructions

These instructions apply to every automated agent working on Orbit, alongside
the global agent instructions. Procedure lives in scripts, reasoning in ADRs and
docs; this file keeps project rules and one-line traps.

## Working model

Architecture and security decisions are recorded in ADRs; the governance
decision is [ADR-0011](docs/adr/0011-operator-experience-as-product.md).

**One project, not siblings** ([ADR-0036](docs/adr/0036-the-orbit-family-is-one-project.md);
recorded as an exception in `~/.config/agents/EXCEPTIONS.md`).
Orbit, `ai/orbit-base-image`, `ai/orbit-launcher` (project 50) and
`ai/orbit-site` (project 57) are one project in four repositories. When one
needs something from another, or something there is not working, act on it
without asking: file the issue, tell that session. Anything describing Orbit to
the public (a feature claim, an install step, a screenshot) belongs on the site,
so check it when Orbit's behaviour changes. The launcher and site point here for
this rule.

Non-commercial data and dependencies are acceptable here
([ADR-0037](docs/adr/0037-non-commercial-data-and-dependencies-acceptable.md)).

## Where the work lives

**`ai/orbit` on `gitlab.tomlawson.io`, project 49, is the source of truth**:
issues, milestones, merge requests and the CI that merges wait on. GitHub is a
owner-managed push mirror (CodeQL, secret scanning, a second CI opinion); a red GitHub run
never blocks a GitLab merge, and its frozen issues are stale. Issue and MR
numbers are GitLab's. Operators pull from GHCR; GitLab publishes there
(`docs/releasing.md`).

- Credentials, the `glab` and `git push` incantations: the github-credentials
  skill. Host lookups fail now and then, so retry two or three times before
  treating one failure as an answer.
- **Check the pipeline's trigger user after a push.** If the `git` command lacks
  the same env prefix as the `glab` calls, the push goes out as Codex, the api
  still answers Claude, and only `glab api projects/49/pipelines/<id>` (`.user`)
  shows it.
- `glab issue create` has no `-F`: pass the body with `-d "$(cat file)"`. Notes:
  `glab api -X POST projects/49/issues/<iid>/notes -f body=…`.
- What a pipeline runs, the `ci: acceptance` and `ci: rerun` labels, reuse,
  runners and Renovate: `docs/quality-strategy.md` ("Who starts a pipeline")
  and [ADR-0028](docs/adr/0028-ci-reuse-keyed-on-tested-artefact.md). Release
  status is the milestone and `docs/releasing.md`.
- A Renovate-flagged stale pin on `main` is not work: `main` is expected to be
  far behind. Check `dev`.

## Delivery rules

- Run fast checks before container and browser checks; those suites cost
  minutes each and the fast suite catches most of what they would.
- Build every feature and fix for both the desk and the phone (pocket) layouts,
  or say in the issue why one is left out. Before closing, check both: the code
  for each, and a browser test on a desktop and a mobile project (owner,
  2026-10-07; #1059, #1298, #1243).
- The demo stack (`compose/docker-compose.demo.yml`) is disposable test data:
  if it will not start, rebuild from current `dev` rather than repair it.
- The owner cannot open files on this VM. Anything to review is hosted and
  handed over as a clickable link; sign-off is on running code, not a
  screenshot (`scripts/dev/test-bed.sh` header has the how).
- Mockups and review screenshots use the app's default theme (after dark).
- An internal test harness (labelling, evaluation page, debug view) is not
  product UX: build it the ordinary way, no top-model design call.

## Extraction rules

Read #992 and [docs/extraction-method.md](docs/extraction-method.md) before
touching `src/server/documents/extraction-*`.

- Every field gets its own copy of every stage (sieve, tagging, chooser);
  duplication is expected, not a defect.
- Scanning rules state a fact about household paper in general; a rule naming
  one page's heading word or layout is a tune and stays out.
- The unseen hold-out documents are locked by `~/agent-hooks/holdout-gate.py`:
  never read them or run an eval with `--misses` or `--answers`; score them and
  read the score line. A hold-out author writes `ORBIT_HOLDOUT_AUTHOR=1` in the
  command text itself (an exported variable is not seen by the hook), and has
  then spent the right to tune on that set.
- Collected documents stay out of the repository; counts and score lines travel.
- Runs that ask the model go inside a container on
  `orbit_orbit-document-processing`: `scripts/corpus/stages-rerun.sh '<command>'`
  (from the host `orbit-ollama` does not resolve and the run scores 0%).
- Every scored eval run is logged in `docs/experiments/extraction.json` the same
  session (`node scripts/experiment-log.mjs record …`).

## Harnesses that already exist

Check [docs/testing.md](docs/testing.md#local-harnesses) before building a test
rig or handing a check to the owner. It lists each script; the rules that matter:

- Suites: `scripts/test-all.sh` (backend then e2e; `ORBIT_SKIP_E2E` skips e2e),
  `test-backend.sh` (static analysis and the fast suite), `test-frontend.sh`
  (Playwright against a running instance), `test-integration.mjs` (real
  database), `pnpm --filter orbit-web fidelity` (the visual gate).
- Stacks: `test-e2e-local.sh` (disposable local stack, then Playwright;
  `--keep` and `--reuse PROJECT` re-run one spec cheaply),
  `test-install-acceptance.sh` (fresh install to healthy),
  `test-install-bootstrap.sh`, `test-repair-journeys.sh`,
  `test-backup-restore.sh` (`--own-stack` locally), `dev/test-bed.sh` (demo and
  owner-review bed), `cleanup-stacks.sh` (lists and removes `orbit*` projects).
- Pins: `sidecar-pins.mjs` (`check`, `sync`), `ci/repin-base-image.sh`,
  `bump-launcher-pin.sh`.
- WebKit runs on this host only inside the CI Playwright image;
  `test-e2e-local.sh` does that itself. Run a WebKit-affected e2e change on both
  WebKit projects locally before pushing (owner, 2026-10-06).
- `scripts/ci/prove-content-id.sh` runs by hand or as a manual job only; it
  builds the image three times.

## Local traps

Reasoning for each is in [docs/testing.md](docs/testing.md#local-traps).

- A stack a script started is torn down by that script; stale containers are a
  defect, not housekeeping. Run `bash scripts/cleanup-stacks.sh` at session end
  and before acceptance. Plain `--remove` skips running stacks (another session
  may own them); your own running stack goes with `--project NAME --remove`.
- `pnpm db:generate` is blocked on purpose: `drizzle/meta/` snapshots stop at
  0004, so it would emit a migration recreating the whole schema. The
  hand-written procedure is in `docs/testing.md`.
- `docker compose --env-file .env-orbit` without `-p` silently adopts that
  deployment's project and volumes, from any checkout. Source
  `scripts/compose-isolation-preflight.sh` before an `up` you assemble by hand.
- Never drive a pty test by closing its stdin: the pty master closes, reads
  return EOF, and the test proves nothing. Keep stdin open for the child's life.
- pty deadlines come from `scripts/pty-deadline.mjs`, not a new timer; tests set
  `PTY_TEST_TIMEOUT_MS` so Vitest's 5s default does not speak first.
- A Compose `file:` secret is an inode bind mount: edit in place and containers
  see it; replace it (`mv`, `tar -x`, `rsync`) and running containers keep the
  old copy until restarted.
- `test-backup-restore.sh` seeds its own state with SQL and nothing else drives
  it: a dropped column fails only the compose smoke test. Grep it before any
  schema change.
- No `pnpm install` from a worktree: it can rewire the main checkout. If it
  recurs, `find node_modules web/node_modules -type l -lname '*worktrees*'` must
  be empty in the main checkout; repair with `CI=true pnpm install` there, after
  agreeing a window (it breaks other sessions' builds meanwhile).
- The web type check says SKIPPED in most worktrees, and that is correct (it
  would read another branch's `orbit/server/*`); run it in the main checkout.
- A red compose smoke job can hide the next failure, because it stops at the
  first bad step. Read the whole job before saying what a branch needs.
- Never hand-write a control-character range in a regex: lose an escape and it
  matches most ordinary characters. Scan explicitly, as `isApplicationRelative`
  in `web/src/lib/return-path.js` does, and test empty, `//` and backslash.
- A leftover volume of the same Compose project blocks an install;
  `scripts/cleanup-stacks.sh` lists them.
- A lockfile diff adding an `@pnpm/exe` block means the host pnpm is older than
  the pin: discard the diff, run `node --test scripts/lockfile-no-pnpm-exe.test.mjs`
  before committing a lockfile change, and ask the owner to upgrade the host
  pnpm.
- Only ten fonts exist on this host and anything else falls back silently;
  check `fc-list : family` (list in `scripts/corpus/README.md`).
- `tmp/` is gitignored scratch for prototypes; the gates skip it. Nothing there
  is built or shipped.
- Every tappable thing on the phone layout is at least 44x44px (`--p-hit`,
  gated by `web/tests/fidelity/pocket-measure.spec.js`).

## Sources of truth

[docs/README.md](docs/README.md) indexes the docs. The product contract is
`docs/v1-charter.md`; architecture is `docs/architecture.md` and `docs/adr/`;
the test and CI policy is `docs/quality-strategy.md`. GitLab issues, milestones
and labels are the delivery-status surface (owner, 2026-09-04): the milestone says
what is scheduled, open or closed says what is done. `SECURITY.md`
is the vulnerability-reporting contract.
