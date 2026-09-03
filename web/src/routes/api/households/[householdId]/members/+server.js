import { json } from "@sveltejs/kit";
import { z } from "zod";

import {
  addHouseholdMember,
  listHouseholdMembers,
  listRegisteredUserCandidates,
  removeHouseholdMember,
  transferHouseholdOwnership,
} from "orbit/server/workspace-repository";

import { MEMBERS_FIXTURE } from "$lib/data/fixtures/household.js";
import { read, write } from "$lib/server/api.js";

const addMemberSchema = z.object({ userId: z.uuid() });
const removeMemberSchema = z.object({ userId: z.uuid() });
const transferOwnerSchema = z.object({ userId: z.uuid() });

/**
 * Household roster: members and, for an owner or instance admin, who else
 * could be added (#735 port).
 *
 * A household with no entry answers an empty roster rather than 404 in the
 * fixture branch — the real route 404s on a household the caller cannot see
 * (inside `listHouseholdMembers`), and the fixture is not claiming that
 * authorization decision.
 */
export const GET = read(
  async (event, session) => {
    const householdId = /** @type {string} */ (event.params.householdId);
    const members = await listHouseholdMembers(session.user.id, householdId);
    const currentUser = members.find((member) => member.id === session.user.id);
    const candidates = session.user.isInstanceAdmin || currentUser?.role === "owner"
      ? await listRegisteredUserCandidates(session.user.id, householdId)
      : [];
    return json({ members, candidates }, { headers: { "cache-control": "no-store" } });
  },
  {
    fixture: (event) => json(
      MEMBERS_FIXTURE[event.params.householdId] ?? { members: [], candidates: [] },
      { headers: { "cache-control": "no-store" } },
    ),
  },
);

export const POST = write(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const { userId } = addMemberSchema.parse(await event.request.json());
  const members = await addHouseholdMember(session.user.id, householdId, userId);
  const candidates = await listRegisteredUserCandidates(session.user.id, householdId);
  return json({ members, candidates }, { headers: { "cache-control": "no-store" } });
});

export const DELETE = write(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const { userId } = removeMemberSchema.parse(await event.request.json());
  const members = await removeHouseholdMember(session.user.id, householdId, userId);
  const candidates = userId === session.user.id
    ? []
    : await listRegisteredUserCandidates(session.user.id, householdId);
  return json({ members, candidates }, { headers: { "cache-control": "no-store" } });
});

export const PATCH = write(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const { userId } = transferOwnerSchema.parse(await event.request.json());
  const members = await transferHouseholdOwnership(session.user.id, householdId, userId);
  const actor = members.find((member) => member.id === session.user.id);
  const candidates = session.user.isInstanceAdmin || actor?.role === "owner"
    ? await listRegisteredUserCandidates(session.user.id, householdId)
    : [];
  return json({ members, candidates }, { headers: { "cache-control": "no-store" } });
});
