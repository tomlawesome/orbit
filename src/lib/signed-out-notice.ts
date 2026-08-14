/**
 * A one-shot, content-free "you signed out" hand-off between the document
 * that ended the session and the document that lands afterwards.
 *
 * Signing out navigates away (`preview-workspace.ts` → the provider's
 * end-session endpoint, or straight back to `/`), so the goodbye screen is
 * rendered by a *different* document to the one that clicked "Sign out".
 * `sessionStorage` is the only channel that survives that hop in the same
 * tab, including a round trip through the identity provider, without
 * putting anything in a URL the provider would have to accept.
 *
 * The stored value is a per-document token, never household data and never
 * anything identifying: it exists only so the document that *wrote* the
 * notice does not also consume it. Between `setSession(null)` and
 * `location.assign()` the signed-out gate briefly mounts in the outgoing
 * document; without the token it would swallow the notice and the goodbye
 * screen would never appear. A fresh document loads a fresh module, gets a
 * fresh token, and therefore sees the notice as foreign — which is exactly
 * the condition that means "the previous page signed out".
 */

const SIGNED_OUT_KEY = "orbit:signed-out:v1";

/** Identifies this document instance. Module scope, so `markSignedOut` and
 *  `consumeSignedOutNotice` agree within one document and disagree across
 *  a navigation. */
const DOCUMENT_TOKEN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Storage can be unavailable (blocked cookies, hardened privacy modes).
    // A missing goodbye screen is a cosmetic loss, never a failure.
    return null;
  }
}

/** Records that this document deliberately ended its session. */
export function markSignedOut(): void {
  try {
    storage()?.setItem(SIGNED_OUT_KEY, DOCUMENT_TOKEN);
  } catch {
    // Quota or policy failures are ignored, per the note above.
  }
}

/**
 * Reads and clears a notice left by an *earlier* document. Returns false
 * for a notice this document wrote itself, so the outgoing page never
 * consumes its own hand-off.
 */
export function consumeSignedOutNotice(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const notice = store.getItem(SIGNED_OUT_KEY);
    if (notice === null || notice === DOCUMENT_TOKEN) return false;
    store.removeItem(SIGNED_OUT_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Memoized answer for this document, so the value survives being read
 *  during render (including React's double render in development) and does
 *  not flip back once the notice has been cleared. */
let cachedNotice: boolean | null = null;

/**
 * `useSyncExternalStore` snapshot: whether this document was reached by
 * signing out. Consuming on first read keeps this a one-shot — a reload
 * shows the plain sign-in screen — while the memo keeps it stable for the
 * life of the document.
 */
export function signedOutNoticeSnapshot(): boolean {
  cachedNotice ??= consumeSignedOutNotice();
  return cachedNotice;
}

/** Server snapshot: rendered markup never claims a sign-out happened, so
 *  hydration is stable and the notice is a client-only enhancement. */
export function noSignedOutNotice(): boolean {
  return false;
}

/** The notice is written once, before a navigation, and never changes
 *  within the life of a document, so there is nothing to subscribe to. */
export function subscribeToSignedOutNotice(): () => void {
  return () => {};
}
