# mail-in

The inbound-mail module (issue #298 split of the former `src/server/imap-*.ts`
files, ~1,150 lines in the original `imap-ingestion.ts` alone). Split along
its documented seams: receipt/identity intake, hostile-MIME staging, review
journey, persistence.

## The boundary

- **`core/`** — pure parsing and classification logic. No `getDb`/`db`/schema
  imports, no `imapflow` import. Enforced by
  `src/server/mail-in/core/import-boundary.test.ts`. Everything here is
  synchronous or otherwise side-effect-free and can be unit-tested without a
  live Postgres connection or a live IMAP server.
- **shell** (this directory's top level) — the network/worker layer:
  ImapFlow client setup and polling, the SMTP notification worker, and
  attachment holding (scan + encrypt to local staging). Calls into `core/`
  for parsing/classification decisions.
- **persistence** — DB reads/writes (receipt recording and dedup, staging
  object leases, review-inbox CRUD, notification materialization/claiming)
  live alongside the shell functions that issue them in this split; they
  remain integration-tested rather than unit-tested, and call into `core/`
  for the pure decisions (rotation state, config parsing, review
  classification) rather than duplicating that logic.

## What lives where

| File | Role |
| --- | --- |
| `core/imap-attachment-validation.ts` | BODYSTRUCTURE classification, attachment byte validation, display-name normalization. Moved as-is from `imap-attachment-validation.ts`. |
| `core/imap-recipient.ts` | Recipient-alias derivation, normalization, and matching; trusted-header parsing. Moved as-is from `imap-recipient.ts`. |
| `core/imap-rotation.ts` | Alias-rotation state machine (`decideImapRotationState`, `assertImapRotationState`). Moved as-is from `imap-rotation.ts`. |
| `core/config.ts` | `getImapIngestionConfig`, `imapProviderConnectionOptions`, `imapProviderConfigCommitment`, `imapAttachmentRetryDelayMs` — extracted from `imap-ingestion.ts`, which re-exports them for a churn-free import path. |
| `core/review-state.ts` | `reviewInboxState`, `findReviewedIntakeCandidateReason` — extracted from `imap-inbox.ts`, which re-exports them for a churn-free import path. |
| `imap-ingestion.ts` | The ImapFlow network shell: polling cycle, recipient-alias reconciliation, attachment staging/commit, provider preflight. The `globalThis.__orbitImapProviderPreflight` singleton stays here, colocated with the worker that owns it. |
| `imap-inbox.ts` | Review-inbox CRUD (list/get/discard/assign), staging purge. The `globalThis` singleton(s) for this worker's cycle stay colocated here. |
| `imap-attachment-holding.ts` | Scan + encrypt inbound attachments to local staging ahead of commit. |
| `imap-receipt-worker.ts` | SMTP notification delivery for receipts/review-ready mail. Its `globalThis.__orbit*` singleton stays colocated here. |

Old `src/server/imap-*.ts` paths (`imap-ingestion.ts`, `imap-inbox.ts`,
`imap-attachment-holding.ts`, `imap-receipt-worker.ts`) are now deprecated
one-line re-export stubs pointing at their new home here, so no caller's
import path had to change. `imap-attachment-validation.ts`, `imap-recipient.ts`,
and `imap-rotation.ts` had no consumers outside this module, so they moved
outright with no stub.

## Pending ownership question

`sanitizeReviewDraftMetadata` stays in `src/server/reviewed-intake.ts` for
now — it's shared surface between mail-in intake and the approval workflow,
and issue #298's characterization pass flagged the ownership call (mail-in
vs. approval workflow) as still open. Revisit once the approval-workflow
side of that boundary is characterized too.

## Contract

`src/server/imap-characterization.test.ts` (43 tests) is the behavioural
contract for this module: it pins the pre-split behaviour of every pure
function here (including the ten oddities flagged during characterization —
see issue #298 — which were deliberately characterized, not fixed). Any
change to `core/` or to the extracted config/review-state fragments must
keep that suite green.
