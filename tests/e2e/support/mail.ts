import { ImapFlow, type MessageStructureObject } from "imapflow";

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
 * SMTP already is -- see docker-compose.acceptance.yml and TEST_IMAPS_PORT in
 * scripts/test-e2e-local.sh.
 */

const IMAPS_PORT = Number(process.env.TEST_IMAPS_PORT ?? 3993);

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

/**
 * One connect/search/download/logout cycle against one mailbox. Returns the
 * plain-text body of the newest message whose Subject contains
 * `subjectContains`, or null if none matches yet -- a fresh connection every
 * attempt is simpler than managing one long-lived client across a poll, and
 * this runs at most a handful of times.
 */
async function latestMatchingBody(address: string, subjectContains: string): Promise<string | null> {
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: IMAPS_PORT,
    secure: true,
    // The sidecar's self-signed certificate rotates every run; the same
    // trade-off tests/e2e/v19-mail-collection.spec.ts makes for its SMTP
    // connection, and for the same reason -- this is test code reading a
    // disposable mailbox, not Orbit's own provider connection (which does
    // verify, via NODE_EXTRA_CA_CERTS).
    tls: { rejectUnauthorized: false },
    // GreenMail accepts any password for any address; the address is what
    // selects the mailbox.
    auth: { user: address, pass: "orbit-e2e-mail-helper" },
    logger: false,
  });

  await client.connect();
  try {
    await client.mailboxOpen("INBOX", { readOnly: true });
    const uids = await client.search({ subject: subjectContains }, { uid: true });
    if (!uids || uids.length === 0) return null;
    const newestUid = uids[uids.length - 1];

    const message = await client.fetchOne(newestUid, { uid: true, bodyStructure: true }, { uid: true });
    if (!message) return null;
    const part = findTextPlainPart(message.bodyStructure);
    const { content } = await client.download(newestUid, part, { uid: true });
    if (!content) return null;
    return streamToString(content);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/**
 * Waits for a mail addressed to `address` whose subject contains
 * `subjectContains`, and returns the `/invite/<token>` link from its
 * plain-text body -- never anything asserted against the surrounding prose,
 * which #481's own mail.ts warns is a placeholder due to change.
 */
export async function waitForInvitationLink(
  address: string,
  subjectContains: string,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const linkPattern = /https?:\/\/\S+\/invite\/\S+/u;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const body = await latestMatchingBody(address, subjectContains);
      if (body) {
        const match = body.match(linkPattern);
        if (match) return match[0].replace(/[).,]+$/u, "");
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  const detail = lastError instanceof Error ? `; last error: ${lastError.message}` : "";
  throw new Error(
    `#481: no mail to ${address} with subject containing "${subjectContains}" arrived within ${timeoutMs}ms${detail}`,
  );
}
