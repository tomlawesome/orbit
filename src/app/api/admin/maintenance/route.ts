import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/env";
import { requireInstanceAdministrator } from "@/server/authorization";
import {
  activateMaintenance,
  assertOutsideMaintenance,
  cancelMaintenanceNotice,
  editMaintenanceMessage,
  endMaintenance,
  readMaintenanceState,
  scheduleMaintenanceNotice,
} from "@/server/maintenance";

export const dynamic = "force-dynamic";

/**
 * The administrator's maintenance control (#524), over the versioned
 * mutations of #522.
 *
 * The guard runs first here exactly as it does everywhere else, and that is
 * the whole access design (ADR-0013 decision 3): the control needs no path
 * exemption because an administrator passes the guard on every route, so a
 * non-administrator probing this path during maintenance receives the same
 * generic 503 as any other path. The control is neither discoverable nor
 * invocable from outside, without a single URL comparison.
 *
 * Message bounds are not restated here. The domain module owns them, so the
 * API edge and the operator script cannot disagree about what a publishable
 * message is.
 */
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("activate"),
    expectedVersion: z.number().int().positive(),
    message: z.string(),
    expectedEndAt: z.coerce.date().nullable(),
  }),
  z.object({
    action: z.literal("edit_message"),
    expectedVersion: z.number().int().positive(),
    message: z.string(),
  }),
  z.object({
    action: z.literal("end"),
    expectedVersion: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("schedule_notice"),
    expectedVersion: z.number().int().positive(),
    message: z.string(),
    startsAt: z.coerce.date(),
    expectedEndAt: z.coerce.date().nullable(),
  }),
  z.object({
    action: z.literal("cancel_notice"),
    expectedVersion: z.number().int().positive(),
    noticeId: z.uuid(),
  }),
]);

export async function GET(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const session = await requireSession(request, getAuthConfig());
    await requireInstanceAdministrator(session.user.id);
    const maintenance = await readMaintenanceState();
    return NextResponse.json({ maintenance }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await assertOutsideMaintenance(request);
    const config = getAuthConfig();
    const session = await requireSession(request, config);
    assertCsrf(request, session, config);
    await requireInstanceAdministrator(session.user.id);
    const command = mutationSchema.parse(await request.json());
    const actor = session.user.id;
    const maintenance = await runCommand(actor, command);
    return NextResponse.json({ maintenance }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}

type MaintenanceCommand = z.infer<typeof mutationSchema>;

function runCommand(actor: string, command: MaintenanceCommand) {
  switch (command.action) {
    case "activate":
      return activateMaintenance(actor, command.expectedVersion, {
        message: command.message,
        expectedEndAt: command.expectedEndAt,
      });
    case "edit_message":
      return editMaintenanceMessage(actor, command.expectedVersion, command.message);
    case "end":
      return endMaintenance(actor, command.expectedVersion);
    case "schedule_notice":
      return scheduleMaintenanceNotice(actor, command.expectedVersion, {
        message: command.message,
        startsAt: command.startsAt,
        expectedEndAt: command.expectedEndAt,
      });
    case "cancel_notice":
      return cancelMaintenanceNotice(actor, command.expectedVersion, command.noticeId);
  }
}
