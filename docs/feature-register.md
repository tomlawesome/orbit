# Orbit deferred feature register

This register captures agreed product directions that are intentionally deferred
until the initial completion pass is finished. Entries describe the intended
outcome and important constraints; they are not commitments to a particular
implementation.

## ORB-FUT-001 — Intelligent email and document ingestion

**Status:** Deferred  
**Objective:** Let a registered user forward household documents to Orbit and
turn them into reviewed items with the original documents retained.

### Intended experience

1. Orbit connects to an external mail server using IMAP to monitor a dedicated
   inbound mailbox.
2. Orbit associates the sender with a registered user and places accepted
   messages into that user's private ingestion queue.
3. It examines the subject, message body and attachments, prioritising the
   documents themselves when extracting policy, provider, reference, cost,
   coverage and schedule information.
4. Orbit presents the extracted item and its source evidence for confirmation
   before changing household data.
5. The user selects the destination household and section, corrects uncertain
   fields, and approves creation or attachment to an existing item.
6. Original documents remain available from the resulting item.

### Outbound email

Outbound SMTP is a first-class part of this feature, not merely an ingestion
implementation detail. An instance administrator should be able to configure:

- an external SMTP server, port and TLS mode;
- authentication credentials independently from the IMAP credentials;
- a custom sender display name and `From` address;
- an optional reply-to address;
- a connection and delivery test before enabling outbound messages.

Orbit should use this configuration for ingestion receipts, review prompts,
duplicate warnings and existing reminder emails. The interface must explain
that the configured mail provider may restrict or rewrite unverified sender
addresses.

### Duplicate handling

Before creating an item, Orbit should rank possible matches using:

- exact document hashes;
- policy, contract or account references;
- provider and product names;
- overlapping effective, expiry, renewal or service dates;
- similarity to existing item titles and attached documents.

Potential matches must produce a comparison screen with explicit choices to
create a separate item, merge new information, or attach the documents without
changing existing fields. Orbit must not silently merge uncertain records.

### Security and privacy requirements

- A matching `From` address alone is not proof of identity because email can be
  spoofed. Provider authentication results, a dedicated forwarding address or
  token, and user confirmation should form the trust boundary.
- Treat message bodies and documents as hostile input, including possible
  prompt injection. Extraction must not grant documents access to application
  tools, secrets or unrelated records.
- Apply message, attachment-count and decompressed-size limits; reject unsafe
  MIME types and archive bombs; and scan retained files for malware.
- Isolate every ingestion job by user and household. Never expose candidate
  matches across households the user cannot access.
- Encrypt or otherwise protect retained documents, define deletion and
  retention behaviour, and include document storage in backup and restore
  procedures.
- Record source, extraction confidence, user corrections and the final action
  in the audit history.

### Architecture decisions required

- IMAP polling versus IDLE, including reconnect and mailbox-cursor behaviour.
- Separate IMAP and SMTP hosts, credentials and TLS requirements.
- Dedicated per-instance mailbox versus unique per-user forwarding addresses.
- Local-volume versus object-storage document backend, with a replaceable
  storage interface.
- OCR and extraction engine, including whether processing may leave the
  self-hosted instance.
- Supported document types, maximum sizes and retention defaults.
- Behaviour when the sender belongs to multiple households.

### Acceptance criteria

- An authenticated user's forwarded sample policy can produce a reviewable
  draft with its source document attached.
- Unknown or insufficiently authenticated senders cannot create drafts.
- Duplicate policy documents raise a comparison rather than silently creating
  or merging an item.
- Low-confidence fields remain visibly unresolved until confirmed.
- Failed parsing, unsafe files and provider outages are recoverable and visible
  to an administrator without exposing document contents in logs.

## ORB-FUT-002 — Mobile and installed-PWA information density

**Status:** Deferred  
**Objective:** Make Orbit faster to scan on a phone without losing the richer
desktop presentation.

### Intended experience

- Replace the large desktop hero/focus treatment with a compact mobile summary
  that leaves upcoming items visible near the top of the first screen.
- Retain the brand and current sense of visual energy without allowing
  decorative elements to dominate limited vertical space.
- Increase the readability of essential item information and preserve generous
  touch targets.
- Keep search, household switching, notifications and add-item actions easily
  reachable in standalone PWA mode.
- Respect safe-area insets, browser text scaling, orientation changes and the
  on-screen keyboard.

### Acceptance criteria

- At common phone widths, the first upcoming item is visible without scrolling
  past a desktop-sized hero.
- Primary item text remains readable at a glance at every Orbit text-size
  setting.
- Interactive controls meet accessible touch-target and keyboard-focus
  requirements.
- Layout is verified in iOS Safari/installed mode and Android
  Chrome/installed mode, including light and dark themes.
- Desktop and tablet layouts retain their current richer composition.
