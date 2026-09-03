import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { appErrorResponse } from "@/lib/app-error";
import { assertCsrf, requireSession } from "@/lib/auth/session";
import { nextCookies } from "@/lib/auth/next-compat";
import { getAuthConfig } from "@/lib/env";
import { requireInstanceAdministrator } from "@/server/authorization";
import {
  assertOutsideMaintenance,
  cancelMaintenanceWindow,
  editMaintenanceUpdate,
  endMaintenance,
  openMaintenanceWindow,
  publishMaintenanceUpdate,
  readMaintenanceState,
  rescheduleMaintenanceWindow,
  reviseMaintenanceExpectedEnd,
  scheduleMaintenanceWindow,
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
 *
 * The action set follows the window/update model of #585: `activate` opens a
 * window and publishes its first entry, `publish_update` appends a follow-on
 * entry rather than replacing it, and `edit_update` corrects one in place
 * (ADR-0013 decision 8). There is no "which message wins" action left,
 * because there is no longer one message to win.
 */
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("activate"),
    expectedVersion: z.number().int().positive(),
    message: z.string(),
    expectedEndAt: z.coerce.date().nullable(),
  }),
  z.object({
    action: z.literal("publish_update"),
    expectedVersion: z.number().int().positive(),
    message: z.string(),
  }),
  z.object({
    action: z.literal("edit_update"),
    expectedVersion: z.number().int().positive(),
    updateId: z.uuid(),
    message: z.string(),
  }),
  z.object({
    action: z.literal("revise_expected_end"),
    expectedVersion: z.number().int().positive(),
    expectedEndAt: z.coerce.date().nullable(),
  }),
  z.object({
    action: z.literal("end"),
    expectedVersion: z.number().int().positive(),
    message: z.string().nullish(),
  }),
  z.object({
    action: z.literal("schedule_window"),
    expectedVersion: z.number().int().positive(),
    message: z.string(),
    startsAt: z.coerce.date(),
    expectedEndAt: z.coerce.date().nullable(),
  }),
  z.object({
    action: z.literal("reschedule_window"),
    expectedVersion: z.number().int().positive(),
    windowId: z.uuid(),
    startsAt: z.coerce.date(),
    expectedEndAt: z.coerce.date().nullable(),
  }),
  z.object({
    action: z.literal("cancel_window"),
    expectedVersion: z.number().int().positive(),
    windowId: z.uuid(),
  }),
]);

export async function GET(request: NextRequest) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    const session = await requireSession(nextCookies(request), getAuthConfig());
    await requireInstanceAdministrator(session.user.id);
    const maintenance = await readMaintenanceState();
    return NextResponse.json({ maintenance }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return appErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await assertOutsideMaintenance(nextCookies(request));
    const config = getAuthConfig();
    const session = await requireSession(nextCookies(request), config);
    assertCsrf(request.headers, session, config);
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
      return openMaintenanceWindow(actor, command.expectedVersion, {
        body: command.message,
        expectedEndAt: command.expectedEndAt,
      });
    case "publish_update":
      return publishMaintenanceUpdate(actor, command.expectedVersion, command.message);
    case "edit_update":
      return editMaintenanceUpdate(actor, command.expectedVersion, command.updateId, command.message);
    case "revise_expected_end":
      return reviseMaintenanceExpectedEnd(actor, command.expectedVersion, command.expectedEndAt);
    case "end":
      return endMaintenance(actor, command.expectedVersion, { body: command.message });
    case "schedule_window":
      return scheduleMaintenanceWindow(actor, command.expectedVersion, {
        body: command.message,
        scheduledStartAt: command.startsAt,
        expectedEndAt: command.expectedEndAt,
      });
    case "reschedule_window":
      return rescheduleMaintenanceWindow(actor, command.expectedVersion, command.windowId, {
        scheduledStartAt: command.startsAt,
        expectedEndAt: command.expectedEndAt,
      });
    case "cancel_window":
      return cancelMaintenanceWindow(actor, command.expectedVersion, command.windowId);
  }
}
