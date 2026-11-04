import { json } from "@sveltejs/kit";
import { z } from "zod";

import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { removeProviderLinks } from "orbit/server/local-credentials";
import { requireInstanceAdministrator } from "orbit/server/authorization";

import { write } from "$lib/server/api.js";

const bodySchema = z.object({
  /** The retired provider's issuer. In the body, not the path: it contains slashes. */
  issuer: z.string().min(1),
  /**
   * Mail the existing setup link to every member left with no way in, rather
   * than refusing because of them (#1676, owner answer 45b).
   */
  mailStranded: z.boolean().optional(),
  /** Whole days each mailed setup link lives, 1 to 14, default 7 (ADR-0023 §3). */
  expiresInDays: z.number().optional(),
  /**
   * The acting administrator's own current password (ADR-0023 §5), when they
   * have a local credential; absent for an OIDC-only administrator, who is
   * challenged with a step-up proof cookie instead.
   */
  currentPassword: z.string().optional(),
});

/**
 * Removes every member's link to a provider that has been turned off
 * (#1676): deletes the links, ends those members' provider sessions and, in
 * mail mode, emails each member left without a password their setup link.
 *
 * Refused (409) while the issuer is still the configured provider, when mail
 * mode has no outgoing mail, when a stranded member's address cannot be read,
 * and in the bare mode when anyone would be stranded. The answer is counts
 * and, per stranded member, whether their mail went; never an address.
 *
 * The acting administrator is re-challenged first (ADR-0023 §5, intent
 * `provider_links_remove`).
 */
export const POST = write(async (event, session) => {
  await requireInstanceAdministrator(session.user.id);
  const submitted = bodySchema.parse(await event.request.json());
  await requireRecentAuthentication(event, session, submitted, "provider_links_remove");

  const result = await removeProviderLinks(
    session.user.id,
    submitted.issuer,
    submitted.mailStranded === true
      ? { mailStranded: true, expiresInDays: submitted.expiresInDays }
      : {},
  );

  return json(result, { headers: { "cache-control": "no-store" } });
});
