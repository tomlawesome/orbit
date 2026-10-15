import { expect, type Page } from "@playwright/test";

/**
 * #1417: the instance's mail-in mailbox, set up by whichever spec gets there
 * first.
 *
 * Two spec files configure the same mailbox on the same stack, and when they
 * run in parallel they race: both read version N, one writes N+1, and the
 * other's write is refused with 409 `mailbox_version_conflict`. So the setup
 * is tolerant, in the two ways a race can show itself:
 *
 *  - already done: the mailbox is configured, enabled and verified with the
 *    values this spec needs (the password is never readable, so it is taken
 *    on trust), so there is nothing to write;
 *  - lost the race: a 409 `mailbox_version_conflict` re-reads the current
 *    version (and checks again whether the winner left what this spec needs)
 *    and tries once more.
 *
 * Everything runs inside the signed-in administrator's page, because the
 * callback is serialised: it can use nothing from this module's scope.
 */
export interface MailboxSetup {
  account: string;
  password: string;
  authservId: string;
}

export async function configureMailbox(page: Page, setup: MailboxSetup): Promise<void> {
  const outcome = await page.evaluate(async ({ account, password, authservId }) => {
    type View = {
      configured?: boolean; enabled?: boolean; version?: number | null; verificationState?: string; hasPassword?: boolean;
      host?: string; port?: number; accountUser?: string; mailbox?: string; tlsServerName?: string;
      providerProfile?: string; trustedRecipientHeader?: string; trustedAuthservId?: string; pollSeconds?: number;
    };
    const wanted = {
      host: "orbit-greenmail",
      port: 3993,
      accountUser: account,
      mailbox: "INBOX",
      tlsServerName: "orbit-greenmail",
      providerProfile: "other",
      trustedRecipientHeader: "X-Orbit-Delivered-To",
      trustedAuthservId: authservId,
      pollSeconds: 30,
    };
    const csrf = async () =>
      ((await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string }).csrfToken;
    const read = async () =>
      ((await (await fetch("/api/admin/mailbox", { credentials: "same-origin" })).json()) as { mailbox?: View | null }).mailbox ?? null;
    const done = (current: View | null) =>
      current !== null
      && current.configured === true && current.enabled === true && current.hasPassword === true
      && current.verificationState === "verified"
      && (Object.keys(wanted) as (keyof typeof wanted)[]).every((key) => current[key] === wanted[key]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await read();
      if (done(current)) return "verified";
      const response = await fetch("/api/admin/mailbox", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": await csrf() },
        body: JSON.stringify({ action: "set", expectedVersion: current?.version ?? null, ...wanted, password }),
      });
      if (response.ok) return ((await response.json()) as { outcome?: string }).outcome ?? "";
      const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
      if (response.status === 409 && body?.error?.code === "mailbox_version_conflict" && attempt === 0) continue;
      throw new Error(`mailbox set failed: ${response.status} ${body?.error?.code ?? ""}`);
    }
    throw new Error("mailbox set failed: unreachable");
  }, setup);
  /* A refusal here is the provider check doing its job, and every assertion
     after it would fail for a reason that named the wrong thing. */
  expect(outcome, "the administrator API must verify the GreenMail mailbox before committing it").toBe("verified");
}
