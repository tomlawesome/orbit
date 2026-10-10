# ADR-0036: The Orbit family is one project in three repositories; act across them without asking

**Status:** Accepted (owner rulings 2026-08-30, 2026-10-03 and 2026-10-10)
**Date:** 2026-10-10
**Relates to:** [ADR-0011](0011-operator-experience-as-product.md) (the
working model); [ADR-0031](0031-signed-launcher-shipped-with-orbit.md) (the
launcher Orbit pins and ships); issues #1371 (the door is designed on the
site and pulled in here), #1374 (slimming `AGENTS.md`); orbit-site ADR-0001

## Context

Orbit's work is spread over four GitLab repositories:

- `ai/orbit`: the product (project 49), where `AGENTS.md` and these ADRs live.
- `ai/orbit-base-image`: the base image Orbit's image is built on.
- `ai/orbit-launcher` (project 50): the signed launcher that installs Orbit.
- `ai/orbit-site` (project 57): Orbit's public website; GitHub Pages serves
  its mirror.

The global agent rules say to write only in the project assigned and to treat
every other project as read-only, reporting what should change rather than
changing it. Applied to these four, that rule meant a session in one had to
stop and ask the owner before filing an issue in another, although the
answer was always the same. The owner said so in turn:

- 2026-08-30: `ai/orbit-base-image` is part of this project, not a sibling,
  with standing authorisation to raise issues and make changes there.
- 2026-10-03: `ai/orbit-launcher` is part of this project too. When one needs
  something from the other, or something there is not working as intended, act
  on it (file the issue, tell the launcher session) without asking first.
  Asking costs the owner a round trip on a question with only one answer.
- 2026-10-10: `ai/orbit-site` is part of this project too. Orbit, the launcher
  and the site are one project, split into three repositories for development
  reasons.

Until now the rule lived only in `AGENTS.md`, restated in three places. That
file is slimmed to project rules and one-line traps (#1374), so the reasoning
needs a durable home.

## Decision

**The base image, the launcher and the site are part of this project, not
siblings.** Specifically:

1. **Act without asking.** When Orbit needs something from one of them, or
   something there is not working as intended, file the issue and tell that
   repository's session. No permission step first.
2. **Standing authorisation covers the repositories, not the safety rules.**
   The global rules still apply inside them: no merging your own work without
   fresh instruction, no repository or branch-protection settings, no secrets,
   no contacting anyone. Another project outside this family is still
   read-only.
3. **Public description lives on the site.** Anything that describes Orbit to
   the public (a feature claim, an install step, a screenshot) belongs in
   `ai/orbit-site`, so check it when Orbit's behaviour changes. The door is
   designed there and Orbit pulls it in (#1371).
4. **`AGENTS.md` is the single home of this rule.** The launcher's and site's
   own instructions point here rather than restating it.

## Consequences

- Cross-repository issues and notes between these four need no owner round
  trip.
- A change that spans them still lands in the order its contract needs; the
  install-script and launcher order is in `docs/releasing.md`.
- Any further repository joining the family is an owner ruling and an
  amendment here.

## Alternatives rejected

- **Treat them as siblings under the global read-only rule.** Every
  cross-repository need becomes a question to the owner with one possible
  answer, which is the round trip the owner asked to stop paying.
- **Restate the rule in each repository's instructions.** Four copies drift;
  one rule with one home does not.
