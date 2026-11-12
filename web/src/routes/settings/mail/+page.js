import { redirect } from "@sveltejs/kit";

/**
 * The relay's old page (#1509): the relay lives in Settings now, as the
 * `your relay` tab of the Mail card, so this address only redirects there.
 * `?sender=` rides along, because the sender check's email (sent before the
 * move, or by an older server) still links here, and its landing is said by
 * the card (sender.js `landingOf`).
 *
 * @param {{ url: URL }} event
 */
export function load({ url }) {
  const sender = url.searchParams.get("sender");
  redirect(308, sender ? `/settings?${new URLSearchParams({ sender })}#mail` : "/settings#mail");
}
