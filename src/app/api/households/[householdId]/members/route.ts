import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthConfig } from "@/lib/env";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import {
  addHouseholdMember,
  listHouseholdMembers,
  listRegisteredUserCandidates,
  removeHouseholdMember,
  transferHouseholdOwnership,
} from "@/server/workspace-repository";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ householdId: string }> };
const addMemberSchema = z.object({ userId: z.uuid() });
const removeMemberSchema = z.object({ userId: z.uuid() });
const transferOwnerSchema = z.object({ userId: z.uuid() });

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await requireSession(request, getAuthConfig());
    const { householdId } = await context.params;
    const members = await listHouseholdMembers(session.user.id, householdId);
    const currentUser = members.find((member) => member.id === session.user.id);
    const candidates = session.user.isInstanceAdmin || currentUser?.role === "owner"
      ? await listRegisteredUserCandidates(session.user.id, householdId)
      : [];
    return NextResponse.json({ members, candidates }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const { householdId } = await context.params;
    const { userId } = addMemberSchema.parse(await request.json());
    const members = await addHouseholdMember(session.user.id, householdId, userId);
    const candidates = await listRegisteredUserCandidates(session.user.id, householdId);
    return NextResponse.json({ members, candidates }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const { householdId } = await context.params;
    const { userId } = removeMemberSchema.parse(await request.json());
    const members = await removeHouseholdMember(session.user.id, householdId, userId);
    const candidates = userId === session.user.id
      ? []
      : await listRegisteredUserCandidates(session.user.id, householdId);
    return NextResponse.json({ members, candidates }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    const { householdId } = await context.params;
    const { userId } = transferOwnerSchema.parse(await request.json());
    const members = await transferHouseholdOwnership(session.user.id, householdId, userId);
    const actor = members.find((member) => member.id === session.user.id);
    const candidates = session.user.isInstanceAdmin || actor?.role === "owner"
      ? await listRegisteredUserCandidates(session.user.id, householdId)
      : [];
    return NextResponse.json({ members, candidates }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}
