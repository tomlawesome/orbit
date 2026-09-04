import { json } from "@sveltejs/kit";
import { z } from "zod";

import { listInstanceUsers, setInstanceAdministrator, setInstanceUserDisabled } from "orbit/server/admin-repository";

import { ADMIN_USERS_FIXTURE } from "$lib/data/fixtures/admin.js";
import { read, write } from "$lib/server/api.js";

const administratorUpdateSchema = z.object({ userId: z.uuid(), administrator: z.boolean() });
const disabledUpdateSchema = z.object({ userId: z.uuid(), disabled: z.boolean() });

export const GET = read(
  async (_event, session) => {
    const result = await listInstanceUsers(session.user.id);
    return json(
      { users: result.users, totalUsers: result.totalCount, truncated: result.truncated },
      { headers: { "cache-control": "no-store" } },
    );
  },
  { fixture: () => json(ADMIN_USERS_FIXTURE, { headers: { "cache-control": "no-store" } }) },
);

export const PUT = write(async (event, session) => {
  const update = administratorUpdateSchema.parse(await event.request.json());
  const result = await setInstanceAdministrator(session.user.id, update.userId, update.administrator);
  return json(
    { users: result.users, totalUsers: result.totalCount, truncated: result.truncated },
    { headers: { "cache-control": "no-store" } },
  );
});

export const PATCH = write(async (event, session) => {
  const update = disabledUpdateSchema.parse(await event.request.json());
  const result = await setInstanceUserDisabled(session.user.id, update.userId, update.disabled);
  return json(
    { users: result.users, totalUsers: result.totalCount, truncated: result.truncated },
    { headers: { "cache-control": "no-store" } },
  );
});
