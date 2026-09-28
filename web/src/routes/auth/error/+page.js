/*
 * This screen holds no data of its own — it reads the `code` query parameter
 * client-side (see +page.svelte), exactly as /login reads `returnTo` — so,
 * like /login, it is prerendered to plain HTML: the signed-out surface a
 * failed sign-in lands on reaches no database and no session at all.
 */
export const prerender = true;
