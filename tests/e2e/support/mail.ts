import { ImapFlow, type MailboxObject, type MessageStructureObject } from "imapflow";

/**
 * #481: reading Orbit's OWN outbound mail back out of the disposable GreenMail
 * sidecar, for the invitation journey.
 *
 * `v19-mail-collection.spec.ts` (#459) SMTP-injects mail INTO GreenMail and
 * then asks Orbit's own `/api/imap-inbox` what its poller made of it -- that
 * spec never needs to read a mailbox itself. This one is the other direction:
 * Orbit is the SENDER (the invitation mail), and nothing in the product reads
 * it back, so the only way to find the invite link is to open the recipient's
 * mailbox exactly as a real mail client would.
 *
 * GreenMail auth is disabled in this overlay (`-Dgreenmail.auth.disabled`),
 * so any password logs in as any mailbox; the address is the only credential
 * that matters. IMAPS (3993) is published to the host the same way GreenMail's
 * SMTP already is -- see compose/docker-compose.acceptance.yml and TEST_IMAPS_PORT in
 * scripts/test-e2e-local.sh.
 */

const IMAPS_PORT = Number(process.env.TEST_IMAPS_PORT ?? 3993);

/** The one intake mailbox every v19-mail-collection pass delivers into and
 *  Orbit polls (#459). Shared by all workers and all projects on a stack. */
export const INTAKE_MAILBOX = "orbit-intake@in.orbit.test";

/**
 * #1183: empties the intake mailbox, as part of putting the stack back to its
 * seed (support/database.ts). The restore wipes Orbit's own record of what it
 * has already read from this box but GreenMail keeps the mail, so after a
 * reset Orbit read every earlier pass's "Boiler cover renewal" again and the
 * next pass found extra suggestion rows it never sent -- desktop-firefox in
 * pipeline 1926, and any second pass on one local stack. Only ever called
 * where the gate has every worker outside a spec file, so no worker's
 * in-flight mail is in the box.
 */
export async function emptyIntakeMailbox(): Promise<void> {
  await withMailbox(INTAKE_MAILBOX, { readOnly: false }, async (client, box) => {
    if (box.exists > 0) await client.messageDelete("1:*");
  });
}

/**
 * Opens `address`'s INBOX, runs `read`, and always logs out. GreenMail accepts
 * any password for any address, so the address selects the mailbox. The
 * self-signed certificate rotates every run, hence `rejectUnauthorized: false`:
 * this is test code reading a disposable mailbox, not Orbit's own provider
 * connection (which does verify, via NODE_EXTRA_CA_CERTS). Read-only unless
 * the caller must delete.
 */
export async function withMailbox<T>(
  address: string,
  options: { readOnly?: boolean },
  read: (client: ImapFlow, box: MailboxObject) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: IMAPS_PORT,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user: address, pass: "orbit-e2e-mail-helper" },
    logger: false,
  });
  await client.connect();
  try {
    const box = await client.mailboxOpen("INBOX", { readOnly: options.readOnly ?? true });
    return await read(client, box);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** Depth-first search for the first text/plain node in a body structure. */
function findTextPlainPart(node: MessageStructureObject | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type?.toLowerCase() === "text/plain") return node.part ?? "1";
  for (const child of node.childNodes ?? []) {
    const found = findTextPlainPart(child);
    if (found) return found;
  }
  return undefined;
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

type MailQuery = { subject: string } | { body: string };

/** The newest UID matching `query`, or 0 for none: a mark to hand back as `afterUid`. */
async function newestUid(address: string, query: MailQuery): Promise<number> {
  return withMailbox(address, {}, async (client) => {
    const uids = await client.search(query, { uid: true });
    return !uids || uids.length === 0 ? 0 : Math.max(...uids);
  });
}

/** The plain-text body of the newest message matching `query` above `afterUid`, or null. */
async function latestMatchingBody(address: string, query: MailQuery, afterUid: number): Promise<string | null> {
  return withMailbox(address, {}, async (client) => {
    const found = await client.search(query, { uid: true });
    const uids = (found || []).filter((uid) => uid > afterUid);
    if (uids.length === 0) return null;
    const newest = Math.max(...uids);
    const message = await client.fetchOne(newest, { uid: true, bodyStructure: true }, { uid: true });
    if (!message) return null;
    const { content } = await client.download(newest, findTextPlainPart(message.bodyStructure), { uid: true });
    if (!content) return null;
    return streamToString(content);
  });
}

/**
 * The one poll loop behind every mail wait: a fresh connection per attempt,
 * the first link in the newest matching mail ABOVE `afterUid`. `afterUid` is
 * required: a wait without a mark answers with whatever an earlier run or an
 * earlier sign-in left in the box, which for the approval mail is a link that
 * has already been pressed (reads as a broken page, not as a wait that
 * answered too early) and for the sender check a link that no longer works.
 */
export async function pollForLink(
  address: string,
  query: MailQuery,
  linkPattern: RegExp,
  options: { afterUid: number; timeoutMs?: number; failure: string },
): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const body = await latestMatchingBody(address, query, options.afterUid);
      const match = body?.match(linkPattern);
      if (match) return match[0].replace(/[).,]+$/u, "");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  const detail = lastError instanceof Error ? `; last error: ${lastError.message}` : "";
  throw new Error(`${options.failure} within ${options.timeoutMs ?? 60_000}ms${detail}`);
}

/**
 * What `address` already holds of invitation mail whose subject contains
 * `subjectContains`, before the invitation is sent. Handed straight back to
 * `waitForInvitationLink`.
 */
export async function newestInvitationUid(address: string, subjectContains: string): Promise<number> {
  return newestUid(address, { subject: subjectContains });
}

/**
 * Waits for a mail addressed to `address` whose subject contains
 * `subjectContains`, newer than `afterUid`, and returns the `/invite/<token>`
 * link from its plain-text body -- never anything asserted against the
 * surrounding prose, which #481's own mail.ts warns is a placeholder due to
 * change.
 */
export async function waitForInvitationLink(
  address: string,
  subjectContains: string,
  afterUid: number,
  timeoutMs = 60_000,
): Promise<string> {
  return pollForLink(address, { subject: subjectContains }, /https?:\/\/\S+\/invite\/\S+/u, {
    afterUid,
    timeoutMs,
    failure: `#481: no mail to ${address} with subject containing "${subjectContains}" arrived`,
  });
}

/** The subject `src/server/sign-in-approvals/mail.ts` sends, pinned by its own test. */
const APPROVAL_SUBJECT = "Approve your Orbit sign-in";

/**
 * What the mailbox already holds, before a sign-in is started.
 *
 * The number itself means nothing outside IMAP -- it is only ever handed
 * straight back to `waitForApprovalLink`, which uses it to ignore everything
 * that was there first. Zero for a mailbox with no approval in it, which is
 * every mailbox on a fresh stack.
 */
export async function newestApprovalUid(address: string): Promise<number> {
  return newestUid(address, { subject: APPROVAL_SUBJECT });
}

/**
 * Waits for the sign-in approval mail (#1033, ADR-0027 section 5) and returns
 * its one `/approve/<token>` link.
 *
 * The only wait where the mail IS the security control rather than a
 * convenience: without this link nobody gets past a password, so a journey
 * that proves the factor works finds it the way its reader would -- in a
 * mailbox, not in a database. The subject is fixed because there is exactly
 * one approval mail and `src/server/sign-in-approvals/mail.test.ts` pins it.
 *
 * `afterUid` is the mark `newestApprovalUid` took before the sign-in was
 * started, so this waits for the approval THAT sign-in caused. Every sign-in
 * in a file gets its own mark; a stack kept between runs (--reuse) holds the
 * previous run's mail too, so the first sign-in needs one just as much as the
 * second.
 */
export async function waitForApprovalLink(address: string, timeoutMs: number, afterUid: number): Promise<string> {
  return pollForLink(address, { subject: APPROVAL_SUBJECT }, /https?:\/\/\S+\/approve\/\S+/u, {
    afterUid,
    timeoutMs,
    failure: `#1033: no sign-in approval mail to ${address} arrived`,
  });
}

/** The path of the one link the sender-address check email carries (ADR-0017 decision 7c). */
const SENDER_CHECK_PATH = "/api/settings/mail-relay/verify";

/**
 * What the mailbox already holds of sender-address check mail, before one is
 * asked for. Handed straight back to `waitForSenderCheckLink` so it answers
 * with the email THIS request caused: only the newest link works, and a
 * mailbox kept between runs holds older, dead ones. Zero for a clean mailbox.
 */
export async function newestSenderCheckUid(address: string): Promise<number> {
  return newestUid(address, { body: SENDER_CHECK_PATH });
}

/**
 * How many sender-address check emails `address` has received since `afterUid`
 * (the mark `newestSenderCheckUid` took). One press of the button must be one
 * email, so a spec asks this rather than assuming the link it found is the
 * only message.
 */
export async function countSenderCheckMails(address: string, afterUid = 0): Promise<number> {
  return withMailbox(address, {}, async (client) => {
    const found = await client.search({ body: SENDER_CHECK_PATH }, { uid: true });
    return (found || []).filter((uid) => uid > afterUid).length;
  });
}

/**
 * Waits for the check email sent to the member's registered address (decision
 * 7c) and returns its one `.../mail-relay/verify?token=...` link. Matched by
 * the link it carries, not by its subject or wording.
 */
export async function waitForSenderCheckLink(address: string, afterUid: number, timeoutMs = 60_000): Promise<string> {
  return pollForLink(
    address,
    { body: SENDER_CHECK_PATH },
    /https?:\/\/\S+\/api\/settings\/mail-relay\/verify\?token=[A-Za-z0-9_-]+/u,
    { afterUid, timeoutMs, failure: `#1403: no sender-address check mail to ${address} arrived` },
  );
}
