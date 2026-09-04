import { json } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "orbit/db";
import { pushSubscriptions } from "orbit/db/schema";
import { AppError } from "orbit/lib/app-error";

import { write } from "$lib/server/api.js";

/* Bounds, not decoration: an endpoint is a provider URL and the keys are
   fixed-width base64. Anything outside these is not a subscription. */
const subscriptionSchema = z.object({
  endpoint: z.url().max(2_048),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

const removeSchema = z.object({ endpoint: z.url().max(2_048) });

/**
 * Registers this browser to receive reminder notifications (#735 port).
 *
 * The conflict check is the security-relevant part: an endpoint already held
 * by another account is refused rather than reassigned, so a subscription
 * cannot be moved onto a different user's reminders by replaying it.
 *
 * Nothing in v19 calls this yet — the subscribe control is #763.
 */
export const POST = write(async (event, session) => {
  const subscription = subscriptionSchema.parse(await event.request.json());

  const [existing] = await getDb()
    .select({ userId: pushSubscriptions.userId })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, subscription.endpoint))
    .limit(1);
  if (existing && existing.userId !== session.user.id) {
    throw new AppError("subscription_conflict", "That browser subscription belongs to another account", 409);
  }

  const values = {
    userId: session.user.id,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    userAgent: event.request.headers.get("user-agent"),
    expiresAt: subscription.expirationTime ? new Date(subscription.expirationTime) : null,
    revokedAt: null,
  };
  await getDb()
    .insert(pushSubscriptions)
    .values({ endpoint: subscription.endpoint, ...values })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });

  return json({ subscribed: true }, { headers: { "cache-control": "no-store" } });
});

/**
 * Stops this browser receiving them.
 *
 * Revoked rather than deleted, and narrowed to the caller's own rows, so one
 * reader cannot unsubscribe another's device by knowing its endpoint.
 */
export const DELETE = write(async (event, session) => {
  const { endpoint } = removeSchema.parse(await event.request.json());
  await getDb()
    .update(pushSubscriptions)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(pushSubscriptions.endpoint, endpoint),
      eq(pushSubscriptions.userId, session.user.id),
    ));
  return json({ subscribed: false }, { headers: { "cache-control": "no-store" } });
});
