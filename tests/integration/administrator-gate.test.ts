import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { AppError } from "@/lib/app-error";
import { getAdministratorOperations } from "@/server/admin-operations";
import { listInstanceUsers } from "@/server/admin-repository";
import { isInstanceAdministrator, requireInstanceAdministrator } from "@/server/authorization";
import { readInstanceContactSettings } from "@/server/instance-contact";
import { openMaintenanceWindow } from "@/server/maintenance";
import { readMailboxSettings } from "@/server/mail-in/mailbox-settings";
import { readUploadLimitSettings } from "@/server/upload-limit";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

/**
 * The administrator gate (#1334). A disabled account has no sessions, so
 * these refusals are defence in depth: they pin that every gate agrees with
 * the strictest one, and that each keeps the status, code and wording its
 * callers already see.
 */

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal, but the call was allowed");
}

const ADMIN_REQUIRED = { status: 403, code: "administrator_required", message: "Orbit administrator access is required" };

describe("the administrator gate", () => {
  it("refuses a disabled administrator from requireInstanceAdministrator", async () => {
    const fixture = await createIntegrationFixture("gate-admin-disabled");
    await requireInstanceAdministrator(fixture.users.admin.id);
    await fixture.disableUser("admin");
    expect(await refusal(requireInstanceAdministrator(fixture.users.admin.id))).toEqual(ADMIN_REQUIRED);
  });

  it("keeps refusing a non-administrator and an unknown account with the same wording", async () => {
    const fixture = await createIntegrationFixture("gate-admin-plain");
    expect(await refusal(requireInstanceAdministrator(fixture.users.owner.id))).toEqual(ADMIN_REQUIRED);
    expect(await refusal(requireInstanceAdministrator(randomUUID()))).toEqual(ADMIN_REQUIRED);
  });

  it("reports a disabled administrator as no administrator", async () => {
    const fixture = await createIntegrationFixture("gate-admin-flag");
    expect(await isInstanceAdministrator(fixture.users.admin.id)).toBe(true);
    expect(await isInstanceAdministrator(fixture.users.owner.id)).toBe(false);
    await fixture.disableUser("admin");
    expect(await isInstanceAdministrator(fixture.users.admin.id)).toBe(false);
  });

  it("refuses a disabled administrator at every administrator entry point", async () => {
    const fixture = await createIntegrationFixture("gate-admin-entry-points");
    await fixture.disableUser("admin");
    const actor = fixture.users.admin.id;
    const entryPoints: Array<[string, () => Promise<unknown>]> = [
      ["listInstanceUsers", () => listInstanceUsers(actor)],
      ["getAdministratorOperations", () => getAdministratorOperations(actor)],
      ["readInstanceContactSettings", () => readInstanceContactSettings(actor)],
      ["readUploadLimitSettings", () => readUploadLimitSettings(actor)],
      ["readMailboxSettings", () => readMailboxSettings(actor)],
      ["openMaintenanceWindow", () => openMaintenanceWindow(actor, 1, { body: "Planned work", expectedEndAt: null })],
    ];
    for (const [name, call] of entryPoints) {
      const refused = await refusal(call()).catch((error: Error) => {
        throw new Error(`${name}: ${error.message}`);
      });
      expect({ name, ...refused }).toEqual({ name, ...ADMIN_REQUIRED });
    }
  });
});
