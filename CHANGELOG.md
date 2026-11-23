# Changelog

What changed in each Orbit release, for the people who run and use it.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and Orbit uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.10] - 2026-11-23

### Added

- An administrator can set a member's registered address from the people list when it cannot be read back; this ends that member's pending links and sign-in approvals, and the old address is told if it could be read (#1869).
- The Add form's reminder days are the same on desk and phone, 1, 3, 7, 14, 30, 60 and 90, and you can type any number of days from 1 to 365, up to eight reminders (#1892).
- The administrator card names the number of damaged document fingerprints, and a stored document fingerprint Orbit cannot read is reported and cleared by the background work (#1931, #1945).
- `orbit update --preflight` asks the database before an update whether the release can migrate, and the update stops with the reason if it cannot (#1779).
- Orbit now settles mail transfers left stuck from before the 0.3.9 mail changes, and update checks for any it cannot settle (#1932).

### Changed

- When a page of a document fails to load, the Reader and the preview card offer a quiet try again button, and the page takes focus once it loads (#1870).
- When the server is busy drawing documents, a page is retried once by itself instead of failing, and the queue of waiting pages is limited so one busy moment cannot stall every reader (#1446).
- Text size, importance and the other tile choices follow the arrow keys, Home and End as one radio group, and the repeat period and section colours do the same (#1494, #1930).
- A password change now cancels any sign-in approvals still waiting (#1898).
- After a sign-in is refused for a wrong password, the next sign-in asks for a new password before it opens a session, and the refused password cannot be chosen again (#1881).
- Restoring an archive no longer puts a waiting hold on a kept document whose item was deleted, and such documents no longer count against a member's limit of 100 waiting uploads (#1871, #1904).
- The phone Exports kept row in Administration shows its hours and count as the title and the size beneath it (#1913).
- The v0.3.7 What's new entry for Importance now describes the levels and the size change correctly (#1926).
- A repair run as root now creates, renames and removes files in the deployment folder as the folder's owner, reads them with size and time limits, and only one `--execute` run works on a folder at a time (#1857, #1858, #1872, #1873, #1875, #1887, #1849).
- A killed repair no longer leaves its lock held or its recovery copy behind, and a lock recreated under the same inode number is noticed (#1893, #1919, #1906).
- Repair opens the backup lock read-write only, never creates it as root, holds the compose-restore lock for the whole restore, and keeps the original and its recovery copy when a restore fails (#1890, #1897, #1899, #1902, #1872).
- Repair keeps its checkpoint encryption in memory so that it no longer counts against the owner step's time limit, and mounts the checkpoint bundle from a private copy outside the folder (#1935, #1875).
- `install.sh` takes the backup and restore lock when it retires the `SMTP_*` lines, and writes `.env-orbit` through a fresh temporary name (#1855, #1848).
- Old installer undo copies are offered for removal on update and removed once the change is confirmed (#1834).
- The update readiness check bounds its output, uses a safe mount path and cleans up on a time-out or an interrupt, and an install still on 0.3.7 is no longer refused every update (#1842, #1854).
- A configure `--migrate` that was killed is finished by the next run, and a leftover rollback copy no longer blocks it; a half-removed staging folder is never read as an interrupted install (#1877, #1876).
- Installer prompts draw wide characters correctly, answers show on a plain terminal, and the terminal is restored when you press Ctrl-C (#1885, #1874).
- Restore and repair messages are plainer: they name the backups folder, the exact `ORBIT_BACKUP_DIR` when another restore is unfinished, and say to re-enter the SMTP password after a restore (#1848, #1874, #1603).
- The Orbit base image and the sidecar images are re-pinned: ClamAV 1.5.5, Ollama 0.40.17, the rebuilt Tika 4.2.0-full, and rebuilt Postgres and Node base images (#1856, #1825).
- GitLab now signs the SBOM as its own attestation, and GitHub verifies each attestation before it is copied to `ghcr.io`, so `cosign verify-attestation` also covers the SBOM; builds attested before this change must be re-validated on GitLab before they publish (#1848, #1862).
- Reminder catch-up mail is one message per item and channel, About shows a service version only while its last check succeeded, and the scanner's version check is bounded (#1603).
- The administration draft now carries a time and is dropped after 15 minutes or a plain visit, a search result for an item deleted elsewhere says so, and the browser-alerts words follow the switch (#1604).
- A new app version now turns your next navigation into a page load, the phone due date can be cleared, and the importance pass saves its picks together (#1738).
- A backup, restore or import is read before it is sent, a changed file steps back to choosing, one retry press sends one request, and purging old archive jobs drains the whole backlog and stops after three failures in a row (#1605).
- A retried mail receipt over a lowered size limit is settled as too large, a missing sending password file is recreated empty, and `update.sh` bounds its downloads (#1789).

### Fixed

- Two sign-in approval requests at once could pass the hourly mail limit, and two resends at once could send a dead link; the mail is now reserved first and the new link is used only after the mail goes (#1882, #1891, #1879).
- When a sign-in approval mail may have been delivered although the send reported failure, the old link keeps working beside the new one (#1896).
- Review and amend of a flagged mail says why the flagged file is left out, and the amend button follows the form shown (#1795).
- Widening the window after typing on a phone no longer hides the question about leaving the Add form, and only the visible form asks it (#1883).
- Choosing another file while an archive is being brought in no longer uploads the old one (#1903).
- On Home, an attach whose paper could not be read no longer says done, and a re-read for an item it did not read no longer says done either (#1905, #1916).
- Inbox and household pages now announce a failed or successful decision, and focus stays where it was when a decision fails (#1182).
- The phone tour's Add chapter finds the due button, and its callouts no longer cover their text (#1760, #1895).
- A colour that failed to save is put back and keeps its error, and an unknown outcome is read again and settled (#1879, #1915).
- Checking an upload no longer holds a whole document in the server's memory (#1920).
- A web-push address that is an IPv4-mapped IPv6 address or a name that resolves to a private one is now refused, and the address the push connects to is the one checked (#1929).
- Configuration migration writes each managed key once, even when a commented copy exists (#1847).

## [0.3.9] - 2026-11-16

### Added

- When the scanner flags an attachment on mail waiting for review, the inbox card names it and offers Add without it or Discard everything; the flagged file is never added (#1398).
- A member can list up to five sending addresses, the sign-in one included, and check each one separately (#1650).
- While the virus scanner cannot be reached, a document waiting to be scanned is held instead of being rejected, the member sees it as waiting, and administrators are emailed, at most once a day (#1419).
- Administrators are emailed, at most once a day, when undoing a failed archive import fails (#1421).
- About's Credits gain a System packages group listing the packages of Orbit's base system (#1781).

### Changed

- When Orbit cannot add a reviewed email, the email and push say so in one plain message with an Open your inbox button, and a locked key delays the notice instead of losing it (#1398).
- Mail from a sending address you listed but have not checked is held, unopened, and added once you check the address; an address not checked within 14 days lapses and must be added again (#1810).
- A household backup is never refused for the size of its documents, even after its storage limit was lowered; restoring one that will not fit says how to make room (#1799).
- After Fetch now, the Mail card says only that the mailbox was checked, or why it could not be (#1799).
- The fingerprint of each attachment held from mail is now stored encrypted, like a document's, and a received mail's own fingerprint is no longer stored; attachments already held are moved over in the background (#1778).
- GitLab now hands each tested build to GitHub, through a separate public `orbit-handoff` repository whose key cannot change Orbit's own, and GitHub checks GitLab's signature before publishing it; GitHub no longer needs any access to GitLab, publishing holds read-only access to Orbit's repository, and GitLab's signature now travels with the image and covers the image's SBOM, so `cosign verify-attestation` can check it on `ghcr.io` (#1824).
- A member's mail relay is now a tab on the Mail card in Settings, and the old Mail relay page sends you there (#1509).
- Outlook and Hotmail are no longer offered as a mail provider; a saved Outlook setting reads as Other and keeps its server details (#1780).
- The `SMTP_*` lines in `.env-orbit` are imported into Orbit's Mail settings, and `install.sh --update` then retires them (#1817).
- Key rotation's re-encryption step now runs on an installed Orbit through the command in the rotation guide, not `pnpm rewrap-kek`, which only a source checkout has (#1635).

### Fixed

- Repair no longer starts Orbit while a restore is unfinished or running, a database volume is missing or a container is restarting, and says what to do instead (#1804).
- Repair will not start Orbit's services while it cannot tell whether their containers belong to this folder (#1798).
- Finding the notices for mail that could not be added no longer reads the whole audit log every cycle, so large deployments stay quick (#1787).
- On a phone, the small text in the Settings Planets group is now at least 12px (#1796).
- Approving mail into an existing item, if retried after a database failure, could lose its attachments; the retry now adds them to the item before removing the held copies (#1820).
- Repair no longer says a backup is running when it could not test the backup lock (for example with backups on an NFSv4 share); it says what failed and how to start Orbit (#1820).
- A backup or restore of a deployment that has drawn page previews is no longer refused with "Document archive contains an unexpected path", and carries the kept previews (#1838).
- A held mail attachment approved while the scanner was down no longer stays stuck when scan recovery gives up: the member can retry, or is told to remove it (#1802).
- A kept page preview that is missing or damaged is drawn again when viewed instead of showing an error (#1803).
- Administration's preview figures say unknown when they cannot be read, and the preview store's size reads in KB or GB (#1803).
- Every update stops the optional services outside the selected profile, so a profile change that was interrupted is finished by the next update (#1803).
- An archive refused for the household's storage limit now says to ask for the limit to be raised (#1823).
- On a phone, signing out no longer sometimes leaves the goodbye page at the Settings address (#1637).
- On the Add form, the date, repeat and reminder buttons show the focus ring when reached by keyboard (#1761).

### Security

- A copy of the database can no longer confirm that a member was sent a known file by mail (#1778).
- An archive that would not fit the household's storage limit is refused as soon as its manifest has arrived, not after the whole upload (#1797).
- Adding or checking a sending address no longer tells a member whether someone else has already verified it, and no check mail goes to an address another member holds (#1810).
- An archive upload that stalls no longer keeps its whole declared size reserved on the disk for as long as the connection lasts, so one slow or malicious upload cannot make other households' exports and uploads fail with a disk-full error; space is reserved as the bytes arrive (#1820).

## [0.3.8] - 2026-11-11

### Added

- Mail is set up on one guided Mail card in Administration, sending and receiving together, stored encrypted, with nothing to edit in `.env-orbit` to set either up (#1629).
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
- A document's stored content fingerprint is now encrypted under the household's key once the maintenance backfill has sealed it, so a database dump can't show which files a household holds; a household whose key is locked keeps plain fingerprints until it opens (#1771).

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
