import { json } from "@sveltejs/kit";

import { env } from "$env/dynamic/private";

import { read } from "$lib/server/api.js";

/**
 * The VAPID public key a browser needs before it can subscribe (#735 port).
 *
 * Signed-in only, and no-store: the key is not secret, but which instance a
 * reader is on is, and a cached copy would outlive a key rotation.
 *
 * Nothing in v19 calls this yet — the subscribe control is #763. The route is
 * carried across the cut rather than deleted because the back end behind it
 * works, and the owner's call was to keep it whole rather than rebuild it.
 */
export const GET = read(() =>
  json({ publicKey: env.VAPID_PUBLIC_KEY ?? "" }, { headers: { "cache-control": "no-store" } }),
);
