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

Check here before building a test rig, or before telling the owner a check
needs their hands.

- `scripts/test-install-acceptance.sh` — a real fresh install: unmocked
  `install.sh`, real Docker/PostgreSQL/ClamAV, through to a healthy
  `/api/health`, asserting `docs/installer-guarantees.md` entries. OIDC
  discovery is a fixture, so no provider credentials are needed. `--lifecycle`
  adds the interruption and update cases. It cleans up after itself.
- `scripts/test-e2e-local.sh` — the acceptance stack with disposable OIDC and
  GreenMail sidecars under an isolated Compose project, then Playwright,
  rather than promoting to `preview` to find out.
- `scripts/installer-simulation.sh` — the command-centre UI only, no Docker.
  Not a substitute for the first.

Both real harnesses build their own image, so the published bootstrap
(`ORBIT_CHANNEL=preview` resolving `ghcr.io/tomlawesome/orbit:preview` to a
digest) stays untested by them.

## Traps when running things locally

Three known ways to lose an afternoon, or worse. The first two have open
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
