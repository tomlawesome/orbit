# Orbit agent instructions

These repository instructions apply to every automated agent working on Orbit,
alongside the global agent instructions.

## Working model

Orbit is maintained by its human owner with AI assistants working under
direction. Architecture and security decisions are recorded in ADRs and
reviewed by the owner; the durable governance decision is
[ADR-0011](docs/adr/0011-operator-experience-as-product.md).

## Who makes design and architecture calls

UX/UI design work and architecture judgement on Orbit are done by Claude
Fable 5 (owner decision, 2026-08-22). That covers the visual and interaction
design itself — screen and component design, layout, motion, colour and
typography decisions, mockup work, judgement against the ratified designs or
the fidelity gate — and macro system-design choices of the kind ADRs record.

Issues whose substance is that judgement carry the `model: fable` label. An
orchestrating agent on another model hands the judgement itself to Fable — a
Fable sub-agent producing the artefact (the design proposal, the ADR draft,
the trade-off call), or the issue parked for a Fable session — and integrates
the result without altering the call. If unlabelled work turns out to conceal
such a call mid-implementation, stop and escalate rather than make it.

Other models implement, test and deliver ratified judgement, and do the rest
of the engineering: orchestration, integration, tests, CI.

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

## Traps when running things locally

Two known ways to lose an afternoon, or worse. Both have open issues; until
those land, this is the procedure.

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
  and Delivery lane. GitHub milestones remain the release grouping and are
  mirrored by the board's Slice field (owner decision, issue #502).
- `docs/engineering-baseline.md`: evidence-backed capability and gap audit.
- `docs/quality-strategy.md`: test, CI, and definition-of-done policy.
- `docs/feature-register.md`: detailed product direction and constraints, not
  live delivery status.
- `docs/releasing.md`: release procedure and operator acceptance.
- `SECURITY.md`: supported-version and private vulnerability-reporting
  contract.
