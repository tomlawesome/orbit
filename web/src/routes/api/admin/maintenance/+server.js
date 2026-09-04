import { json } from "@sveltejs/kit";
import { z } from "zod";

import { requireInstanceAdministrator } from "orbit/server/authorization";
import {
  cancelMaintenanceWindow,
  editMaintenanceUpdate,
  endMaintenance,
  openMaintenanceWindow,
  publishMaintenanceUpdate,
  readMaintenanceState,
  rescheduleMaintenanceWindow,
  reviseMaintenanceExpectedEnd,
  scheduleMaintenanceWindow,
} from "orbit/server/maintenance";

import { read, write } from "$lib/server/api.js";

/**
 * The administrator's maintenance control (#524, #735 port), over the
 * versioned mutations of #522.
 *
 * `read()`/`write()` are the right wrappers here, not a bespoke guard: the
 * shared `assertOutsideMaintenance` (ADR-0013 decisions 2/3) already exempts
 * a caller whose own session carries `isInstanceAdmin`, so the administrator
 * reaches this route the same way as every other route — through the same
 * guard, not around it. A non-administrator probing this path during
 * maintenance gets the same generic 503 as any other path, with no separate
 * exemption or path allowlist to keep in sync.
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

export const GET = read(async (_event, session) => {
  await requireInstanceAdministrator(session.user.id);
  const maintenance = await readMaintenanceState();
  return json({ maintenance }, { headers: { "cache-control": "no-store" } });
});

export const POST = write(async (event, session) => {
  await requireInstanceAdministrator(session.user.id);
  const command = mutationSchema.parse(await event.request.json());
  const actor = session.user.id;
  let maintenance;
  switch (command.action) {
    case "activate":
      maintenance = await openMaintenanceWindow(actor, command.expectedVersion, {
        body: command.message,
        expectedEndAt: command.expectedEndAt,
      });
      break;
    case "publish_update":
      maintenance = await publishMaintenanceUpdate(actor, command.expectedVersion, command.message);
      break;
    case "edit_update":
      maintenance = await editMaintenanceUpdate(actor, command.expectedVersion, command.updateId, command.message);
      break;
    case "revise_expected_end":
      maintenance = await reviseMaintenanceExpectedEnd(actor, command.expectedVersion, command.expectedEndAt);
      break;
    case "end":
      maintenance = await endMaintenance(actor, command.expectedVersion, { body: command.message });
      break;
    case "schedule_window":
      maintenance = await scheduleMaintenanceWindow(actor, command.expectedVersion, {
        body: command.message,
        scheduledStartAt: command.startsAt,
        expectedEndAt: command.expectedEndAt,
      });
      break;
    case "reschedule_window":
      maintenance = await rescheduleMaintenanceWindow(actor, command.expectedVersion, command.windowId, {
        scheduledStartAt: command.startsAt,
        expectedEndAt: command.expectedEndAt,
      });
      break;
    case "cancel_window":
      maintenance = await cancelMaintenanceWindow(actor, command.expectedVersion, command.windowId);
      break;
  }
  return json({ maintenance }, { headers: { "cache-control": "no-store" } });
});
