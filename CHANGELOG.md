# Changelog

What changed in each Orbit release, for the people who run and use it.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and Orbit uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- An archive that would not fit the household's storage limit is refused as soon as its manifest has arrived, not after the whole upload (#1797).

## [0.3.8] - 2026-11-11

### Added

- Mail is set up on one guided Mail card in Administration, sending and receiving together, stored encrypted, with nothing to edit in `.env-orbit` (#1629).
- Every email Orbit sends now uses Orbit's mail design, not only the invitation (#1648).
- A Fetch now button on the Mail card checks the mailbox at once instead of waiting for the next interval (#1651).
- An administrator sets the largest mail message separately from the upload limit (#1388).
- Orbit tells a household when it uploads a document it already holds (#1437).
- Every page of a document is drawn once and kept, encrypted, so turning pages is quick; Administration shows the space the previews use (#1433).
- ClamAV is optional: still on by default, and an administrator who turns it off gets a recommendation and nothing more (#1170).
- An `update.sh` in the Orbit folder fetches the latest updater and runs it (#1770).
- An update with no one at the keyboard honours `ORBIT_INSTALL_PROFILE`, so the launcher can change a deployment's profile (#1542).
- Every deployment gets a `.orbit-files` list of the files Orbit installed, so the launcher's Remove deletes only those (#1496).
- Repair can start a deployment whose services are not running, and recreate the containers after the folder was renamed or moved (#1535, #1576).
- The sky's key names every section that wears a colour (#1466).

### Changed

- Checking and drawing a PDF needs far less memory; new uploads are limited to 100 pages, and documents already stored keep the limit they were accepted under (#1436).
- A household export no longer has to fit in memory, so large ones work (#1390).
- Install and update ask, or refuse, when the deployment folder has been moved (#1576).
- The sidecar images are re-pinned to current upstream builds (#1641).

### Fixed

- Rejected document rows are removed after 45 days instead of kept forever (#1786).
- A household whose key is locked can still upload documents (#1771).
- A rolled-back archive import removes the files it had staged (#1792).
- An archive restore and a held mail attachment are filed under the size limit they were accepted under, not today's upload limit (#1784).
- Reminders are sent in the order they became due (#1784).
- The mail credential can't be removed while sending still uses it, and Orbit refuses to send if the sending settings can't be read (#1784).
- A forward that was accepted isn't checked again on retry, and a member is told about an unsigned forward at most once a day per sending address (#1727).
- The default space for exports is a whole number of GiB (#1792).

### Security

- An archive upload is stored before it is processed, so a slow upload no longer blocks every other household's export and import (#1792).
- Exports are kept for six hours, two per household and within a space limit, all three set by an administrator under Exports kept (#1792).
- A document's stored content fingerprint is now encrypted under the household's key, so a database dump can't show which files a household holds (#1771).

## [0.3.7] - 2026-11-07

### Added

- Every item has an importance, low, medium or high, shown by its planet's colour; Orbit offers once to set it on existing items (#1463).
- A setting keeps every planet's name on show (#1461).
- You choose whether a planet's distance from the sun follows its key date or your warning date (#1462).
- An administrator can remove every member's link to a sign-in provider at once, after the provider itself is removed (#1676).
- A new optional setting, `MAIL_IN_DKIM_DNS_SERVERS`, names the DNS server Orbit asks for the DKIM keys that prove who sent a forward, when the system resolver can't answer them faithfully (#1681).

### Changed

- An item has no type: its schedule follows from its key date and its repeat, and Add's date, repeat and reminder choosers are Orbit's own on desk and phone (#1468).
- Distance from the sun uses a log scale, so the next few weeks get more room (#1464).
- Forwarded mail is now matched to a member only on Orbit's own check of the sender's DKIM signature. The mail server's own verdict is no longer read, so the trusted mail server name (authserv-id) setting added in 0.3.6 is gone; a saved value is ignored (#1681).
- When a forward from a member's address isn't signed, the member now sees it in their inbox as "not kept" and is told, at most once a day, instead of it vanishing unexplained. While they've paused collection nothing appears and they aren't told; their relay page still shows the last forward was unsigned (#1681).

### Fixed

- A preview install can now update from any earlier version, including across a release-line change (#1678).
- Orbit no longer closes idle connections before the reverse proxies we document do, which could cut off a request (#1683).
- A request with malformed JSON now gets a clear "bad request" answer instead of an internal error (#1688).
- Warm-coloured text outside the household page now has enough contrast on the light colour packs (#1685).

## [0.3.6] - 2026-11-04

### Added

- You can set the trusted mail server name (authserv-id) in Administration. Before, there was no screen for it, so mail from Mailcow and other self-hosted servers was never matched (#1630).
- On a desktop, click the relay address to copy it, just as you tap it on a phone (#1658).

### Changed

- An update from more than three releases back is refused, and you're told which release to update to first (#1667).
- Uses Orbit launcher v0.4.4 (#1674).
- Clearer wording: outbound sending is no longer called "the relay", the name members' own relay addresses use (#1627). The relay page's footer note is gone (#1649).

### Fixed

- Members who forward from the same mail server as Orbit no longer have every forward refused (#1655).
- When the mailbox can't connect, it says whether sending (SMTP) or receiving (IMAP) failed, and why (#1626).
- If a forward had nothing to collect, the review page says so instead of showing nothing (#1652).
- Settings → Mail no longer says "no address yet" while an administrator has paused mail intake (#1654).
- The date chooser's "Today" button is now big enough to tap easily (#1621).
- A long member name no longer runs under the OWNER badge on the household page (#1659).
- The mail setup guide no longer points to a script an installed copy doesn't have, and it explains Mailcow's tagged-mail setting (#1625, #1631, #1660).
- Testing and release tooling are faster and steadier, so fixes reach a release sooner and more safely.

### Security

- Pages now send a Content-Security-Policy, which limits what a page may load or run (#1411).
- On installs served over plain http, signing out and checking mail work again; a stricter request check had been refusing them (#1565).
- Fixes from the release audit, including two ways the archive could go down and a mail secret that could be printed in a log (#1607).

[0.3.6]: https://github.com/tomlawesome/orbit/compare/v0.3.5...v0.3.6
