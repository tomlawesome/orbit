# ADR-0032: TypeScript is the engine; bash is the thin Docker shell

**Status:** Accepted (owner, 2026-10-04, ratifying the 2026-08-13 direction
on #295)
**Date:** 2026-10-04
**Relates to:** #295 (engine-delivery architecture, 2026-08-13); #1151
(v1.3.0 release audit); #1210, #1211, #1212 (the flips this ADR orders);
`docs/engine-events.md` ("In-container engine invocation (v0)")

## Context

The owner decided on 2026-08-13 (recorded on #295): host bash scripts are
the only thing that ever runs `docker`, and the TypeScript engine ships
inside the app image, invoked as a disposable
`docker compose run --rm --no-deps` one-off. The owner's hard constraint
from that decision stands unchanged: "the engine can never manage the
Docker socket. Ever." (`docs/engine-events.md`, line 613).

Today that direction is only partly carried out. Some flows — `configure`'s
write side, behind the `ORBIT_CONFIGURE_ENGINE=container` opt-in
(`scripts/configure.sh`) — already run through the TypeScript engine
(`src/lib/configure-engine.ts`). Others still run entirely in bash. Where a
flow has not flipped, both a bash version and a TypeScript version exist
side by side.

The v1.3.0 release audit (#1151) found four fixes that landed on only one of
the two twins — bash or TypeScript — and not the other. Carrying both halves
doubles every fix and halves the testing.

## Decision

TypeScript is the engine. Bash becomes a thin shell holding only what must
touch Docker on the host: the install bootstrap, pulling the image,
`compose up`/`down`, VAPID key generation, and repair's container work.

Every flow that reads or writes configuration, secrets, backups or bundles
runs once, in the TypeScript engine shipped inside the app image, invoked as
a disposable `docker compose run --rm --no-deps` one-off.

The engine never touches Docker — #295's hard constraint, unchanged — and
Node is never required on the host.

The flips are filed for v1.4, in this order, each proven on `preview` before
the next starts:

1. **#1210** — flip `configure` to the TypeScript engine; retire the bash
   write flows; `configuration.sh` follows.
2. **#1211** — flip backup, restore and recovery bundles.
3. **#1212** — flip install: the deferred #295 bootstrap flip.

Until a flow flips, both twins stay, and every fix lands on both.

## Consequences

- Reading and writing configuration, secrets, backups and recovery bundles
  moves into the TypeScript engine, one flow at a time, in the order above.
- Bash keeps only the steps that must touch Docker on the host: the install
  bootstrap, image pull, `compose up`/`down`, VAPID key generation, and
  repair's container work. These stay bash because the engine is
  structurally forbidden from touching Docker at all.
- A fix to a flow that has not yet flipped must still land on both the bash
  and TypeScript twins, exactly as today, until #1210, #1211 or #1212 (as
  applicable) lands and the bash half is retired.
- Each flip proves itself on `preview` before the next one starts; nothing
  skips ahead in the order.
- Node remains unnecessary on the host at every point in this sequence: the
  engine only ever runs inside the already-built app image.

## Alternatives rejected

- **Leave both twins in place indefinitely.** Rejected: #1151 already shows
  the cost — fixes miss one half, and testing is doubled for no benefit.
- **Flip install first.** Rejected: #295 already deferred the bootstrap flip
  for its own reasons, and configure's write side is already partway there,
  so it goes first.
