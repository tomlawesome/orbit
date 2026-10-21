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
5. Then operators, documents and mail, and the look: in that order because
   the earlier ones are what the tester hit.

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
inbox), #1354 (household, archive card and create), #1353, #1355, #1356,
#1346 (the engine sends the item's kind), #1347.

## v0.3.4 — The sky

Milestone: [v0.3.4](https://gitlab.tomlawson.io/ai/orbit/-/milestones/34)

The alpha-feedback redesign, decided in one design round with the owner:
#1463 (importance: three levels, required, shown as colour), #1466
(households set their own categories), #1462 (the warning date can drive
distance from the sun), #1464 (log scale for distance), #1461 (optional
permanent labels), #1468 (themed dropdowns), #1391 (the section limit).

## v0.3.5 — Running Orbit

Milestone: [v0.3.5](https://gitlab.tomlawson.io/ai/orbit/-/milestones/35)

#1458 (a readable, organised operator log), #1419 (hold documents when the
scanner is down, and tell administrators), #1421 (alert emails to
administrators), #1387 (a maintenance command for the launcher), #1398 (mail
approval all or nothing), #1411 (Content-Security-Policy), #1326 (the engine
serves its own API) with #1364, #1350, #1351 and #1330 (consistency review).
Decisions: #1453 (the second release signature), #802 (hardware needs).

## v0.3.6 — Documents and mail

Milestone: [v0.3.6](https://gitlab.tomlawson.io/ai/orbit/-/milestones/36)

#1434, #1436, #1446 (PDF cost and timeouts), #1433 (stored previews), #1390
(exports of any size), #1437 (duplicate uploads), #1312 (Outlook and Hotmail
mailboxes), #1053 (where a sign-in came from), #1386 (retired entries), #1388
(a mail size limit), #1470 (optional single-household mode).

## v0.3.7 — Look and accessibility

Milestone: [v0.3.7](https://gitlab.tomlawson.io/ai/orbit/-/milestones/37)

#1253, #1268, #1311 (the flight on sign-in, sign-out, 404 and maintenance),
#1382 (layout by device), #1299, #1314, #1385, #1430 (flight fixes), #1182,
#1384, #1395 (accessibility and error fixes), #496 (the final accessibility
check), #1103 (rename orbit-base-image).

## v0.4.0 — Sign-in

Milestone: [v0.4](https://gitlab.tomlawson.io/ai/orbit/-/milestones/11)

#1194: review using Gauntlet as Orbit's authentication backend.
