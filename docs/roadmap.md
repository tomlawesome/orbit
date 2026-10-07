# Orbit roadmap: promises against delivery

> **Current.** Checked against the code on `dev` (3379d6cb), 2026-10-07.

This page lists everything Orbit has promised and says whether it has been
kept. One row is one promise; a promise made in several places is one row that
names every place. The public website will read these tables, so the layout is
fixed: the columns, the status words and the row IDs do not change.

## Where promises come from

All three count, and a promise found anywhere new gets a row:

- **The v1 charter and the feature register**: [v1 charter](v1-charter.md)
  requirements (`charter V1-ID-01`) and register entries (`ORB-FUT-001`).
- **orbit-site's public claims**: written `site: "Section"`, the section
  heading on the home page of the website (a separate, read-only project).
- **Owner decisions**: `owner-decisions §n` for
  [design/owner-decisions.md](../design/owner-decisions.md), and
  `decision #n` for GitLab issues labelled `type: decision`.

## The rule

Every promise is either delivered or removed. A promise that will not be kept
is taken out of where it was made (the site, the register, the charter) and
marked `dropped` here. It is not left standing.

## Columns

- **ID**: `RM-nnn`, stable. Never reused or renumbered; new rows take the next
  number.
- **Promise**: what was promised, in plain English.
- **Promised in**: the sources above.
- **Target**: a GitLab milestone (`v0.3`, `M15`) or `unscheduled`. For a
  delivered row it is the milestone of the work that delivered it. The
  `v1.0` to `v1.2` milestones were retracted alphas; `v0.3` is the first
  supported release.
- **Status**: exactly one of the four listed after this.
- **Evidence**: GitLab issues (`#123`), merge requests (`!456`) or short commit
  shas. For `partial` it also says what is missing.

The four statuses:

- `delivered`: works in the current code and has a test. Known defects are named in Evidence.
- `partial`: some of it works, or it works untested, or it could not be confirmed. Evidence says which.
- `not started`: nothing in the code yet.
- `dropped`: removed from where it was promised.

Status comes from reading the code, not from whether an issue is open or
closed.

## Promises

### Identity and access

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-001 | Sign in and out through standard OIDC, with revocable, rotated sessions and cross-site protection | charter V1-ID-01; site: "The system" | v1.0 | partial | #14, 81bbb0ac; real-provider sign-in not proven (#1242) |
| RM-002 | Orbit's own accounts, no identity provider needed; optional OIDC linking; the first administrator claims a fresh install | site: "The system"; owner-decisions §17 | M7 | delivered | #259, #909, 19f042a8 |
| RM-003 | Ask for the password again (step-up) before sensitive actions | owner-decisions §17 (m7 plan) | M7 | partial | #910, 264453ed; not applied to household ownership transfer, member removal or hard delete |
| RM-004 | Signed-out visitors and non-members cannot find a household's records, members, documents or archives | charter V1-ID-02 | v1.0 | delivered | #14, #25 |
| RM-005 | An administrator can disable and re-enable an account; disabling ends its sessions; never an ownerless household or an administrator-less instance | charter V1-ID-03; ORB-FUT-005 | v1.0 | delivered | #26, 8e8086f2 |
| RM-006 | Handle people the identity provider removes or renames | ORB-FUT-005 | unscheduled | partial | identity is keyed on issuer and subject (src/lib/auth/provision.ts); no removal or rename handling; no issue |
| RM-007 | Decide whether Gauntlet becomes Orbit's authentication backend | decision #1194 | v0.4 | not started | #1194 |

### Households

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-008 | A first-time user creates a household explicitly; reading creates nothing; anyone can start one and becomes its owner | charter V1-HH-01; owner-decisions §11 | v1.0 | delivered | #15 |
| RM-009 | Owners add registered members and transfer ownership atomically with an audit record, never leaving a household ownerless | charter V1-HH-02; ORB-FUT-005 | v1.0 | delivered | #94; adding a member writes no audit row |
| RM-010 | Members can leave a household they do not own | ORB-FUT-005 | v1.0 | delivered | #94 |
| RM-011 | Removing a household makes it private at once, keeps it recoverable for 30 days, and purges only by an administrator who types its name, audited; restore sits on the household's row in Systems | charter V1-HH-03; owner-decisions §19 | v1.0 | delivered | #66, 3852bf73 |
| RM-012 | Retention rules for documents, notification records, audit and backups after a deletion | ORB-FUT-005 | unscheduled | partial | documents purge on a clock (#42); no rules for the other records found in code |
| RM-013 | Cancel or reassign pending mail-in drafts and jobs when a user is disabled or removed; legal-hold exception | ORB-FUT-005 | unscheduled | not started | disabling only ends sessions; no issue |
| RM-014 | A user with no household sees the sky, can ask to join one, and owners approve | owner-decisions §11, §23 | v0.3 | delivered | #453, aeec79f7 |
| RM-015 | Instance administrators can add any user to any household | owner-decisions §11 | v0.3 | delivered | #453 |
| RM-016 | Add the people you live with by name, no invitations, no email addresses exposed | site: "Around your household" | unscheduled | partial | adding registered members works (#453); email invitations exist (#481) so "no invitations" is untrue; email exposure not checked |
| RM-017 | Several households per person, each a system in the sky you can fly to | site: "Around your household"; owner-decisions §11 | v0.3 | delivered | #473, #474 |

### Items and the sky

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-018 | Create, edit, search and schedule household items | charter V1-ITEM-01; site: "The rhythm" | v1.0 | delivered | #16, #40, #455 |
| RM-019 | Complete an item and its next date is worked out; one-offs simply end | site: "The rhythm" | v0.3 | delivered | #455 |
| RM-020 | Reschedule or snooze an item when life gets in the way | site: "The rhythm"; charter V1-ITEM-01 | v0.3 | delivered | #455 |
| RM-021 | Archive and restore items | charter V1-ITEM-01 | v0.3 | delivered | #455 |
| RM-022 | A history of what was done and when, for every item | charter V1-ITEM-01; site: "Around your household" | v1.0 | partial | history is stored and sent to the screens (#40) but no screen lists it |
| RM-023 | Each item keeps cost, how often it comes round (including 2 years or any 1-120 months) and its reminders (for example 4 weeks and 1 week before) | site: "The rhythm"; decision #1058 | M14 | delivered | #1058, #1069 |
| RM-024 | Item kinds service, renewal, inspection, document and suggestion; a section must be picked, with no default | decision #1058 | M14 | delivered | #1069 |
| RM-025 | Sections stay an attribute printed on each row but leave navigation | charter V1-ITEM-02; owner-decisions §10 | v0.3 | delivered | #413 |
| RM-026 | Add, rename, reorder and recolour your own sections | site: "Around your household" | unscheduled | partial | add, rename, hide, reorder exist; colour follows the chosen mark, no recolour |
| RM-027 | Display choices stay consistent across sessions: five colourways, light or dark, three text sizes | charter V1-ITEM-02; site: "Around your household" | v0.4 | partial | five packs shipped (#486); pack kept in the browser only; text size has no effect (#1180) |
| RM-028 | Assign an item to a household member | decision #1058 | unscheduled | not started | no assignee in the model; the owner-decided follow-up issue was never filed |
| RM-029 | Dial: nearer is sooner, bigger is costlier, a belt shows documents; nothing on it is decoration | owner-decisions §1, §12; site: "The orbit" | v0.3 | delivered | #414, #458 |
| RM-030 | "The sky's weather = your workload" | site: "The orbit" | unscheduled | not started | the weather layer is decoration on one pack; nothing maps workload to it |
| RM-031 | One schedule surface: the manifest list is the accessible source of truth, and reduced-motion and no-JS readers get the plain list | owner-decisions §7, §14 | v0.3 | delivered | #469 |
| RM-032 | Search that unrolls the year on the desk and opens as a sheet on a phone | owner-decisions §31; decision #1058 | M14 | delivered | #1057, #1161; open bugs #1302, #1303 |
| RM-033 | One skippable first-login tour film, replayable from the account menu, with a phone cut | owner-decisions §23, §24, §32, §33 | M14 | delivered | #477, #1083, #1189, #1190; weak steps #1254 |
| RM-034 | First run seeds demonstration data so the tour has something to show | decision #484 | M2 | partial | nothing is seeded into real data; the tour uses its own example body (#752) |
| RM-035 | A ratified goodbye screen when signing out | decision #483 | M2 | delivered | #483 |
| RM-036 | Keep structured provider contact details (phone, email, address, website) with an item | ORB-FUT-009 | unscheduled | not started | no such columns; no issue |
| RM-037 | An editable summary and notes on each item, with or without AI | ORB-FUT-010 | unscheduled | partial | notes exist (2000 characters, encrypted); no summary field |
| RM-038 | AI-proposed summaries and notes, shown as suggestions until accepted | ORB-FUT-010 | unscheduled | not started | no issue |

### Documents

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-039 | Attach a document to an item: upload, scan, encrypt, download, delete and restore without exposing it to another household or public storage | charter V1-DOC-01; ORB-FUT-003; site: "Around your household" | v1.0 | partial | #17, #42, 925ba6d6; uploads over 512 KB fail (#1286); no infected-file test (#1297) |
| RM-040 | Documents encrypted at rest with per-document keys wrapped by a key-encryption key, and a key rotation that loses nothing | ORB-FUT-003; site: "The system"; decision #954 | M8 | delivered | #932, #954, da892a9d |
| RM-041 | Downloads are authenticated, authorisation is rechecked, no public URLs, safe headers | ORB-FUT-003 | v1.0 | delivered | #42; the file is buffered, not streamed |
| RM-042 | File type decided by inspecting the bytes; opaque storage keys | ORB-FUT-003 | v1.0 | delivered | #42; false refusals #1291, #1292, #1293 |
| RM-043 | Documents wait in quarantine until scanned, and a scanner outage recovers without re-upload | ORB-FUT-003 | v1.1 | delivered | #123, #168 |
| RM-044 | Malware scanning is optional: on by default, a recommendation when off, never forced | ORB-FUT-003; site: "The system" | M16 | partial | DOCUMENT_SCAN_MODE=disabled works but the ClamAV container always runs (#1170) |
| RM-045 | Per-file and per-instance limits, with an upload limit the administrator can set | ORB-FUT-003 | v0.3 | partial | limits come from the environment only (#1285) |
| RM-046 | Orphan cleanup and storage reconciliation | ORB-FUT-003 | v1.0 | delivered | #42 |
| RM-047 | Document events recorded in the household audit history | ORB-FUT-003 | unscheduled | partial | events reach the instance audit log; only administrators read it; download auditing unconfirmed |
| RM-048 | Optional Apache Tika parser, bounded, OCR off, on an internal network | ORB-FUT-003 | v1.1 | delivered | 1cb5917b |
| RM-049 | Optional S3-compatible object storage | ORB-FUT-003 | unscheduled | not started | only local storage exists; no issue |
| RM-050 | Upload from a phone's file picker or camera | ORB-FUT-003; ORB-FUT-007 | v1.0 | partial | picker accepts PDF and images; no capture setting |
| RM-051 | Mobile capture with preview, rotate, remove, retry and progress that survives bad connectivity | ORB-FUT-007 | unscheduled | not started | no issue |
| RM-052 | Open a document's preview and a reader with page turning over the belt | owner-decisions §18; decision #1059 | M14 | partial | #1059; reader shows page 1 only (#1300); desk press fails (#1298) |

### Reading documents

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-053 | An uploaded document may suggest item fields; bounded, best effort, every field editable, nothing saved until the user submits | charter V1-DOC-02; site: "The relay" | v1.0 | delivered | #43 |
| RM-054 | Extraction accuracy measured on real-world documents | decision #977 | M15 | partial | #319, #986, #962 open; corpus built in M8 |
| RM-055 | An optional local model (Ollama) that proposes and never writes | ORB-FUT-003; charter non-goals | M8 | delivered | #935, #936, fa5f07b6 |
| RM-056 | The model reads mailed-in items on CPU, live uploads only with a GPU, and live goes first | decision #974 | M15 | not started | #974, #1031; no GPU detection or queue |
| RM-057 | Extraction sieves every candidate, tags it, then chooses per field | decision #989 | M8 | partial | stages built (d3e607e9) but used only by evaluation tools; production still uses heuristics and the model (#990, #991) |
| RM-058 | Choose the extraction method per field by testing on unseen documents | decision #977 | M15 | not started | #977, #986 |
| RM-059 | Decide on a provider database: source one, build one, or learn it | decision #987 | M15 | not started | #987 |

### Mail

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-060 | Forward a bill or policy to Orbit; it reads the attachment and asks before anything is added | charter V1-DOC-03; ORB-FUT-001; site: "The relay" | v1.0 | partial | #22, #57, #58, #59, #60; proof against a real mailbox open (#1255) |
| RM-061 | Every user has their own relay address, which they can rotate and pause | decision #336; owner-decisions §7; site: "The relay" | M4 | delivered | #336, #744, #746 |
| RM-062 | Mail-in pulls from one mailbox and never opens a port; container mail settings are for sending only | owner-decisions §7 | M4 | delivered | #742, #743, #747 |
| RM-063 | Support Mailcow, Gmail and Outlook, with OAuth2 for Outlook and Hotmail | owner-decisions §7 | unscheduled | partial | password IMAP works; OAuth2 is a stored setting only, no flow; no issue |
| RM-064 | Mail is tied to a user by envelope recipient and a signed alias, never the From line; unmatched mail is held for association | charter V1-DOC-03; ORB-FUT-001 | v1.0 | partial | #57; unmatched mail is deleted, not held |
| RM-065 | Receipts are idempotent and bad messages reach a visible failed state after bounded retries | ORB-FUT-001 | v1.0 | delivered | #57, #58 |
| RM-066 | Mailbox files are PDF only and bounded; unreviewed drafts expire after 45 days | ORB-FUT-001; site: "The relay" | v1.0 | delivered | #58, #964 |
| RM-067 | Your mail stays in your mailbox; Orbit only reads copies | ORB-FUT-001; site: "The relay" | v1.0 | partial | accepted mail is kept, never labelled; mail for unknown recipients is expunged |
| RM-068 | Possible duplicates raise a comparison with create-separate or attach-without-changing, and never merge on their own | ORB-FUT-001; charter non-goals | unscheduled | not started | no ranking, comparison screen or attach path; no issue |
| RM-069 | The administrator sets outbound SMTP: host, port, TLS, own credentials, sender name, From, reply-to, with a connection and delivery test | ORB-FUT-001 | v1.0 | partial | #60; set by file or environment, connection test only, no sender name or reply-to |
| RM-070 | Orbit emails ingestion receipts, review prompts, duplicate warnings and reminders | ORB-FUT-001 | v1.0 | partial | receipts, review prompts and reminders work; no duplicate warning |
| RM-071 | An inbox in three lanes (Filed, For your review, Failed) with a Still reading lane | owner-decisions §14; site: "The relay" | v0.3 | delivered | #463 |
| RM-072 | A suggestion opens as a drawer on home and rides the item belt, accepted in two taps | owner-decisions §27, §29 | M14 | delivered | #1145 |

### Reminders and notifications

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-073 | Due dates and reminder preferences are deterministic across calendar and daylight-saving changes | charter V1-REM-01 | v1.0 | delivered | #41 |
| RM-074 | Delivery is scheduled once, retried a bounded number of times, diagnosable without private content, and optional | charter V1-REM-02 | v1.0 | delivered | #41 |
| RM-075 | Per-user email reminders with switches and per-item warning days | site: "The system"; charter foundations | v0.3 | delivered | #479, #763 |
| RM-076 | Browser push notifications to your phone | site: "Around your household"; charter foundations | M16 | partial | #763; the push key is a byte short on about 1 install in 256 (#1276) |
| RM-077 | Orbit installs like an app | site: "Around your household"; ORB-FUT-002 | v1.0 | delivered | manifest and service worker in web/; no installability test |
| RM-078 | Members see the last five reminders sent to them | owner-decisions §20 | M14 | delivered | #1003 |
| RM-079 | Your data stays on your server: no offline copy of private data on the phone | site: "Around your household"; charter V1-UX-02 | v1.0 | delivered | #88 |

### Install and operations

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-080 | One pasteable command installs a prebuilt image by digest, without Git or prompts, and fails closed | ORB-FUT-012; charter V1-REL-01; site: "Get into Orbit" | v1.1 | delivered | #117, 4cd22c34 |
| RM-081 | Update by running the installer again with settings carried over; migrations applied safely; fresh install and upgrade both proven | charter V1-OPS-03; site: "The system" | v0.4 | partial | migration tests exist; the update path has no test (#725, #680) |
| RM-082 | Install without secrets in Git, environment output, logs or process arguments | charter V1-OPS-01 | v1.0 | delivered | #180 |
| RM-083 | Health and administrator views separate configuration, dependency, provider, queue and storage failures without leaking secrets | charter V1-OPS-02 | v1.0 | delivered | #95 |
| RM-084 | Backup and restore keep the database and encrypted documents, detect corruption and a wrong key, and say the recovery key is separate | charter V1-OPS-04 | v1.0 | partial | #28, b8859295; the backup CLI never run against a real stack (#1199, #1211) |
| RM-085 | Backups run on a schedule | charter quality attributes | unscheduled | not started | docs tell the operator to schedule backup.sh; no scheduler |
| RM-086 | Real restore exercises | charter quality attributes | M16 | partial | CI drill only; no operator drill (#1273) |
| RM-087 | Deterministic update and rollback guidance | charter quality attributes | unscheduled | partial | orbit check --rollback exists; no standalone rollback guide |
| RM-088 | Three containers on PostgreSQL 18, optional parser, scanner and model | charter supported deployment; site: "The system" | M5 | delivered | #686; the site still says PostgreSQL 17 |
| RM-089 | Orbit never needs the Docker socket | feature-register conventions | v1.0 | delivered | compose files hold none |
| RM-090 | Maintenance mode shows a rolling timeline of timed updates | decision #580 | M0 | delivered | #585, #526 |
| RM-091 | A signed launcher installs Orbit from a terminal app | site: "Yours all the way down" | M12 | partial | #1107; end-to-end proof still open (#1154) |
| RM-092 | Open source under AGPL-3.0-or-later, no paywall, no account with us | site: "Yours all the way down" | v0.3 | delivered | 30a23545 |

### Administration

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-093 | Last-success state for reminders, SMTP, push, parsing, extraction, scanning and IMAP | ORB-FUT-004 | v1.0 | partial | #95, 32e0e85b; no separate push or extraction state |
| RM-094 | Failed, retried and cancelled job counts with retry or discard | ORB-FUT-004 | M14 | delivered | #1055 |
| RM-095 | Test actions for SMTP, push, parser, storage and extraction | ORB-FUT-004 | unscheduled | partial | SMTP and IMAP tests only; no issue |
| RM-096 | Storage and queue usage, retention cleanup state and version | ORB-FUT-004 | v1.0 | partial | usage, counts and version shown; no retention-cleanup view |
| RM-097 | A filterable audit history | ORB-FUT-004 | unscheduled | partial | listed 25 at a time, no filter; no issue |
| RM-098 | Settings and administration are desktop pages with their own layout; admin entries are absent for others; an account control holds sign out | ORB-FUT-011 | v1.2 | delivered | #116, #162 |

### Security and privacy

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-099 | Mail and documents are treated as hostile: no tools, no secrets, no automatic writes | ORB-FUT-001; charter non-goals | v1.0 | delivered | #68 |
| RM-100 | Verified TLS for IMAP and SMTP, no downgrade | ORB-FUT-001 | v1.0 | delivered | #60 |
| RM-101 | Logs and errors never carry bodies, subjects or extracted text | ORB-FUT-001; charter V1-OPS-02 | v1.1 | partial | #118; free text is redacted but no test asserts it |
| RM-102 | Parser, scanner and model run with no database, secrets or socket, on an internal network, non-root and read-only | ORB-FUT-003 | v1.1 | partial | Tika meets all; Ollama and ClamAV are not read-only |

### Mobile and accessibility

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-103 | A compact phone home with the first item visible and safe-area and text scaling respected, checked on iOS and Android | ORB-FUT-002 | M14 | partial | #430, #1120; no first-item test; text size broken (#1180) |
| RM-104 | Core journeys keyboard accessible with no automated WCAG A/AA violations at phone and desktop widths | charter V1-UX-01 | M3 | partial | #20, #87; whole-package check open (#496), defects #1182 |
| RM-105 | Accessibility means real access, tested on a real iPhone, Android phone and desktop | owner-decisions §25 | v0.4 | partial | #496 |
| RM-106 | Feedback is readable, non-blocking and short-lived | charter V1-UX-03 | v1.0 | delivered | #20 |

### Data portability

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-107 | Export and import a household with its documents, owner-only, previewed, atomic and audited | ORB-FUT-006; owner-decisions §21 | M14 | delivered | #1002, #1049, a0f4308d; large archives #1290 |
| RM-108 | A human-readable export and a per-document hash manifest | ORB-FUT-006 | unscheduled | not started | only the machine archive exists; no issue |

### Delivery and release

| ID | Promise | Promised in | Target | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| RM-109 | CI tests the exact image that may be published, by digest, and promotion never rebuilds | charter V1-REL-01 | v1.0 | delivered | #21, #34, #61 |
| RM-110 | Validation evidence is signed and bound to the digest, separate from publication | decision #573 | M5 | delivered | #661 |
| RM-111 | Validation runs on the self-hosted GitLab; releases mirror to GitHub and GHCR | ORB-FUT-008 | M5 | delivered | #801 |
| RM-112 | Orbit's base image is controlled and upstream fixes reach releases | decision #650 | M5 | delivered | #650, #1081 |
| RM-113 | A stable release is accepted by digest on a test bed: update, sign-in, records, documents, backup, restore, restart | charter release acceptance | v0.3 | not started | #1152, #1153, #885 |

## Mismatches

### Promised but not scheduled in any milestone

- RM-006 identity provider removes or renames a person: no handling, no issue.
- RM-012 retention rules after a deletion: only documents have one, no issue.
- RM-013 mail-in drafts when a user is disabled, and legal hold: no issue.
- RM-028 item assignee: owner decided it (decision #1058), the follow-up issue was never filed.
- RM-036 provider contact details (ORB-FUT-009): deferred, no issue.
- RM-037 and RM-038 summary and AI-proposed notes (ORB-FUT-010): deferred, no issue.
- RM-047 document events visible in the household's own history: no issue.
- RM-049 S3-compatible storage (ORB-FUT-003): no issue.
- RM-051 enhanced mobile capture (ORB-FUT-007): post-v1, no issue.
- RM-063 OAuth2 mail-in for Outlook and Gmail (owner-decisions §7): no issue.
- RM-068 duplicate comparison (ORB-FUT-001): the register calls mail-in required for v1, yet this part has no issue.
- RM-085 scheduled backups, RM-087 rollback guide: no issue.
- RM-095 provider test actions, RM-097 audit filter (ORB-FUT-004): no issue.
- RM-108 human-readable export and per-document hash manifest (ORB-FUT-006): no issue.

### Site claims the code does not support

- "Every household has its own relay address" (and the tour film): the relay is per user (RM-061).
- "PostgreSQL 17": Orbit runs 18 (RM-088).
- "No invitations": email invitations exist for people without an account (RM-016).
- ClamAV described as "if you like": its container always starts and only the scan mode can be switched off (RM-044).
- "The sky's weather = your workload": nothing maps workload to the weather (RM-030).
- "A history for everything": no screen lists an item's history (RM-022).
- "Recolour your own sections": colour follows the chosen mark (RM-026).
- "Three text sizes": the setting has no effect (RM-027).
- "Originals stay in your mailbox": mail for unknown recipients is deleted (RM-067).

### Delivered but nobody promised, which the site might claim

- Emailed approval of a sign-in from a new device (`src/server/sign-in-approvals.ts`).
- Email invitations for people with no account (#481).
- Repair mode for failed installs and upgrades (#261).
- Recovery bundle and document-key rotation (#968, #932).
- Household export and import, owner-only (#1002).
- A tour film that can be replayed (#1189).
- Requests to join a household, seen from the empty sky (#453).
- Sent-reminder history in settings (#1003).
- Maintenance notices with a public status page (#526).

### Promises that still stand but are out of date

- ORB-FUT-008 calls GitLab validation a contingency; it has been the primary path since #801. Needs removing from the register.
- The charter's release acceptance cites GitHub issues; the work lives on GitLab.
- `docs/engineering-baseline.md` evidence column dates from 2026-07 and is not a source for current status.
