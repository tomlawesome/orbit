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

## Harnesses that already exist

Check the list before building a test rig or handing a check to the owner.

- `scripts/test-all.sh` — backend suite then e2e (`ORBIT_SKIP_E2E` skips e2e)
- `scripts/test-backend.sh` — static analysis and the fast Vitest suite
- `scripts/test-frontend.sh` — Playwright against a running instance
- `scripts/test-integration.mjs` — integration suite against a real database
- `scripts/test-e2e-local.sh` — local stack with disposable OIDC and GreenMail
  sidecars, then Playwright
- `scripts/test-install-acceptance.sh` — real fresh install to a healthy
  `/api/health`, asserting `docs/installer-guarantees.md`; OIDC discovery is a
  fixture, so no provider credentials are needed
- `scripts/test-backup-restore.sh` — backup and restore acceptance drill
- `scripts/test-repair-journeys.sh` — live repair journeys: installs a real
  stack, breaks it, and proves `repair.sh` recovers it (`--list` shows which
  journeys are live and which are still absent)
- `scripts/test-malware-scanner.sh` — ClamAV detection
- `scripts/test-tika-processor.mjs` — Tika document extraction
- `scripts/installer-simulation.sh` — installer command-centre UI only, no Docker
- `scripts/install-test-browser.sh` — one-time headless browser download
- `scripts/preview-lane-preflight.sh` — preview-lane preflight checks
- `scripts/validate-compose-config.sh` — Compose configuration validation
- `scripts/acceptance-mailbox.mjs` — mailbox acceptance record for a given digest

## Traps when running things locally

Four known ways to lose an afternoon, or worse. The first two have open
issues; until those land, this is the procedure.

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

## The demo stack is disposable

The demo deployment (`docker-compose.demo.yml`) carries only test data, so
nothing in it is worth preserving. Do not spend time or tokens keeping an old
demo image or its database alive: if it will not start, rebuild it from current
`dev` and current versions of everything it depends on, rather than repairing
it.

## Sources of truth

- `docs/v1-charter.md`: supported product and release contract.
- `docs/architecture.md` and `docs/adr/`: current architecture and durable
  decisions.
- `docs/implementation-plan.md`: the phased roadmap.
- The [Orbit Roadmap project board](https://github.com/users/tomlawesome/projects/4)
  is the live delivery-status surface: per-issue Status, Slice, Priority, Risk
  and Delivery lane. GitHub milestones are capability slices (M0 onwards), each
  a coherent outcome with a definition of done, mirrored by the board's Slice
  field. A version release moment gets its own milestone holding only its
  promote-to-main issue, and an issue with no milestone is not scheduled (owner
  decision, 2026-08-23, recorded on issue #502).
- `docs/engineering-baseline.md`: evidence-backed capability and gap audit.
- `docs/quality-strategy.md`: test, CI, and definition-of-done policy.
- `docs/feature-register.md`: detailed product direction and constraints, not
  live delivery status.
- `docs/releasing.md`: release procedure and operator acceptance.
- `SECURITY.md`: supported-version and private vulnerability-reporting
  contract.
