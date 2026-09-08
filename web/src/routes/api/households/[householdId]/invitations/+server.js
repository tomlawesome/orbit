import { json } from "@sveltejs/kit";
import { z } from "zod";

import {
  listHouseholdInvitations,
  sendHouseholdInvitation,
  withdrawHouseholdInvitation,
} from "orbit/server/invitations";

import { INVITATIONS_FIXTURE } from "$lib/data/fixtures/household.js";
import { read, write } from "$lib/server/api.js";

/**
 * Email invitations for one household (#481).
 *
 * GET is every member's — the list is who has been invited, and a household
 * where only the owner can see that is not this product's household. POST and
 * DELETE are owners' alone, enforced in the engine's own transaction rather
 * than here, so the rule holds however the route is reached.
 *
 * POST is BOTH send and resend: there is one open invitation per address, so
 * sending again to an address that already has one replaces it (new token, new
 * expiry, the earlier link dead). The screen calls the two acts by different
 * names; the protocol has one.
 *
 * No response, on any of the three, carries the token.
 */

const sendSchema = z.object({ email: z.string().min(3).max(320) });
const withdrawSchema = z.object({ invitationId: z.uuid() });

export const GET = read(
  async (event, session) => {
    const householdId = /** @type {string} */ (event.params.householdId);
    const invitations = await listHouseholdInvitations(session.user.id, householdId);
    return json({ invitations }, { headers: { "cache-control": "no-store" } });
  },
  {
    fixture: (event) => json(
      { invitations: INVITATIONS_FIXTURE[/** @type {string} */ (event.params.householdId)] ?? [] },
      { headers: { "cache-control": "no-store" } },
    ),
  },
);

export const POST = write(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const { email } = sendSchema.parse(await event.request.json());
  const { invitation, invitations } = await sendHouseholdInvitation(session.user.id, householdId, email);
  return json({ invitation, invitations }, { headers: { "cache-control": "no-store" } });
});

export const DELETE = write(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const { invitationId } = withdrawSchema.parse(await event.request.json());
  const invitations = await withdrawHouseholdInvitation(session.user.id, householdId, invitationId);
  return json({ invitations }, { headers: { "cache-control": "no-store" } });
});
