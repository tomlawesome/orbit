# Release plan

> **Current.** Set by the owner on 2026-10-17, after the v0.3.0 acceptance run
> and the first alpha feedback. The live state of each step is its GitLab
> milestone (`https://gitlab.tomlawson.io/ai/orbit/-/milestones`); this page
> holds the plan and the reasons, which a milestone cannot. When a step
> changes, change both.

This is the order of work after v0.3.0. [roadmap.md](roadmap.md) is a
different thing: the register of what Orbit has promised and whether it has
been kept.

## What gets a new version

Orbit is in alpha, with one owner and one tester. A new minor version
(v0.4.0) is only for a change that everyone has to adapt to: today that is
only a change to how people sign in. Everything else, fixes and new features
alike, ships as a v0.3.x patch (owner, 2026-10-17).

## The order, and why

Each step makes the steps after it cheaper or safer:

1. **Ship the known fixes and prove the upgrade path.** v0.3.0 is the first
   real prior version, so the upgrade and backup tests can finally run.
2. **Fix the tooling every later change runs through.** Flaky tests and slow
   pipelines tax every batch after them.
3. **Merge the duplicated front-end code before redesigning the sky**, so the
   home and create screens are rewritten once, not twice.
4. **The sky**, the heart of the alpha feedback, in one design round.
5. Then mail and documents, operators, the look, and the household budget:
   in that order because mail is what the owner's live install hit most
   (re-planned 2026-11-03).

v0.4.0 (Gauntlet as the sign-in backend, #1194) comes after the v0.3.x line.

## v0.3.1 — Known fixes, and proof of the upgrade path

Milestone: [v0.3.1](https://gitlab.tomlawson.io/ai/orbit/-/milestones/31)

- **Dated:** #794 (sidecar scan exceptions expire 2026-11-04), #1370 (a scan
  can pass on a stale vulnerability database).
- **Prove the upgrade:** #725 (upgrade journey tests), #680 (repair, backup and
  restore against a prior version), #1199 (a restored document decrypts).
- **Data-loss and stuck states:** #1392 (key rotation cannot finish), #1393
  (stuck mailbox approvals), #1396 (approval retry stuck), #1397 (PDFs saved
  many times refused), #1420 (backup import without the live key), #1394
  (retry loses edits).
- **Small visible fixes:** #1459 (stop promising document reading without the
  reader), #1460 (planet size cap), #1471 (call the overdue line the event
  horizon), #1450 (claim link), #1454 (issuer check at the prompt), #1443,
  #1444, #1438 (search results), #1180 (text size setting).
- **Follow-ups and docs:** #1209, #1426, #1452 (audit Lows and Notes), #1206
  (licence gate), #1202 (development notice), #1226 (contract change order),
  #1429 (app memory limit), #1469 (alpha feedback tracker).

## v0.3.2 — CI and test foundation

Milestone: [v0.3.2](https://gitlab.tomlawson.io/ai/orbit/-/milestones/32)

- **Flakes at the root:** #1416 (the shared flaky-test system) and #1447
  (rewrite the 46 timing checks behind most flakes). These should absorb the
  eleven open flaky-test issues: #1233, #1306, #1307, #1365, #1367, #1376,
  #1381, #1404, #1415, #1448, #1449.
- **Faster, cheaper pipelines:** #1412, #1413, #1414 (run only the tests a
  change can affect; the full set at promotion), #1377 (fast job near its
  limit), #1200 (runner disk), #1167 (dependency proxy 404), #1101 (base image
  source), #1432 (shared gitleaks rules), #1231 (rehearse publish before
  preview), #1267 (a build-breaking line nothing catches).
- **Local tooling:** #1266 and #1445 (port 4443 collisions), #1280 (worktrees
  share ports), #1423 (test image left behind), #1158 (demo stack names).
- **Shared test code:** #1348, #1357, #1358, #1359, #1360, #1361, #1362,
  #1363. Last, if it still pays: #949 (browser tests in parallel).

## v0.3.3 — Each thing once, front end

Milestone: [v0.3.3](https://gitlab.tomlawson.io/ai/orbit/-/milestones/33)

Done before the sky so its screens are rewritten once: #1352 (home and
inbox), #1354 (household, archive card and create), #1353, #1346 (the engine
sends the item's kind), #1347. #1355 and #1356 moved to v0.3.7, into the sky
build; #1354 moved to v0.3.10.

## v0.3.4 — Hotfix: an administrator gets a relay

Milestone: [v0.3.4](https://gitlab.tomlawson.io/ai/orbit/-/milestones/39)

Found on the owner's live v0.3.3 install on 2026-11-01: an instance
administrator was never given a relay address or a review queue, and the
installing account can never stop being an administrator, so on the usual
one-admin install nobody could use mail-in. #1632, owner decision 47. Ships
as a `hotfix/*` train from `main`; every later v0.3 step moved up one patch
number for it (owner, 2026-11-01).

## v0.3.5 — Hotfix: updates refused the mail overlay

Milestone: [v0.3.5](https://gitlab.tomlawson.io/ai/orbit/-/milestones/40)

Found on the owner's install on 2026-11-02: the update's configuration check
refused `.env-orbit`'s `COMPOSE_FILE` line, which is how a deployment keeps
the mail overlay, so no mail-enabled install could update. #1643. The tag
v0.3.5 went to this hotfix, so every later v0.3 step moved up one patch
number again (owner, 2026-11-02).

## v0.3.6 — Testing

Milestone: [v0.3.6](https://gitlab.tomlawson.io/ai/orbit/-/milestones/34)

Re-planned on 2026-11-03 (owner): faster, steadier CI first, because every
later change runs on it. In order: keep CI standing (#1657 nightly failure,
#1620, #1602); land the move of the browser tests to the rig (ADR-0039:
#1357, #1614, #1609, #1610, #1612, #1613, #1616), already built on
`feature/v034-sky-tour`, then the first audit (#1642), and finish it with
#1611, #1615 (with #1362), #1621 and #1546; then the release proof, the
upgrade matrix (#1647, after #1644), which makes the next update onto a live
install tested before promotion, with #1601 as one of its cells. The mail
fixes from the owner's install (#1630, #1626, #1654, #1658, #1652, #1627,
#1659) run alongside, and the dated upstream re-checks (#1641, #1541, #794,
#1489) stay for #794's 2026-12-04 deadline. The flakes (#1416) and the test
tidy-ups moved to v0.3.7, because the move changes where those tests live and
judging them first would be work done twice.

## v0.3.7 — The sky

Milestone: [v0.3.7](https://gitlab.tomlawson.io/ai/orbit/-/milestones/41)

The alpha-feedback redesign: one design round with the owner, then one build.
#1623 (home blank over http on a LAN address) goes first, since the design
reviews run on that bed. The build holds #1463 (importance as colour), #1466
(households' own categories), #1462 and #1464 (warning date and log scale for
distance), #1461 (permanent labels), #1468 (no native pickers), #1382 (layout
by device), #1639, #1355 and #1356 (shared page and sky code), and #1618 (the
what's-new notice after an upgrade), which belongs here because the sky is the
first change users need telling about. While the design round runs, the
flakes are judged on the moved tests (#1416, #1376, #1381, #1449, #1307,
#1415, #1404, #1196) and the test tidy-ups land (#1358 to #1361, #1066). The
parked tour issues (#1254, #1516, #1581) stay for the design round; owner may
overrule: if the round does not revive the tour, take all three out of every
milestone.

## v0.3.8 — Mail and documents

Milestone: [v0.3.8](https://gitlab.tomlawson.io/ai/orbit/-/milestones/36)

Mail comes ahead of operators, because the owner's live install hit a dozen
mail defects and the owner overruled ADR-0017 for one mail screen. #1629
(mail setup on one guided screen, with #1509, #1651, #1388 and #1312) also
removes the compose overlay that the one-step update would otherwise have to
carry. Then every mail in the ratified design (#1648), alerts to
administrators (#1421) and scanner-down handling (#1419), which bridges to
the documents half: the PDF pipeline (#1436, #1433, #1446, #1591, #1437),
archives (#1390), ClamAV (#1170) and the carried audit Lows (#1605). Also
#1650 and #1656 (relay senders and sender check) and #1398 (mail approval all
or nothing). Owner may overrule: if operators should come first, swap this
title with v0.3.9; every issue move still stands.

## v0.3.9 — Running Orbit

Milestone: [v0.3.9](https://gitlab.tomlawson.io/ai/orbit/-/milestones/35)

Operators. Decisions first: #1453 (the keyless signature) and #1458 (the
operator log). Then one install transaction: #1573 (update in one step with
backup, health and rollback), #1577, #1496, #1576, #1535, #1387 and the rest.
Proof comes after the new flow (#725, #680, #1199, #1265, #802), so old
scripts are not tested and then replaced. The engine serves its own API
(#1326, ADR-0035, with #1364 and #1350), and the scanner and licence gates
(#1592, #1206, #1596, #1432) and carried audit Lows (#1603, #1604) close it.

## v0.3.10 — Look and accessibility

Milestone: [v0.3.10](https://gitlab.tomlawson.io/ai/orbit/-/milestones/37)

The door and sign-in (#1497, #1435, #1311, #1637 and the flight fixes), the
household and create screens on shared controllers (#1354 first, then #1394,
#1386, #1391, #1470, #1628, #1053, moved here because #1624 and #1330 need
them), every error honest (#1384, #1395), then one control per job across
every screen (#1624) and the full accessibility check (#1182, #1494, #496)
once the screens stop moving, followed by the consistency review (#1330).
This milestone has no "check Waiting on upstream" issue yet; the owner's
orchestrator adds one when it opens.

## v0.3.11 — Household budget

Milestone: [v0.3.11](https://gitlab.tomlawson.io/ai/orbit/-/milestones/38)

A household can see what it spends on the things Orbit tracks, forwards and
backwards: #983 (budget for renewals), #457 (cost over time), and #1619
(the cost-estimate mark, which has no engine route today).

## v0.4.0 — Sign-in

Milestone: [v0.4](https://gitlab.tomlawson.io/ai/orbit/-/milestones/11)

#1194: review using Gauntlet as Orbit's authentication backend.
