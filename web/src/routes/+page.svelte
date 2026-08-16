<script>
  import SignIn from "$lib/flight/SignIn.svelte";

  /**
   * Orbit's front door (#429, cut over to v19 for #410/§15).
   *
   * Signed out, the front door IS the sign-in: the ratified login screen, not
   * a redirect to it, so the address a reader types, bookmarks and is returned
   * to by the identity provider is the one they started from.
   *
   * Signed in, the door hands them on to /home exactly as this route already
   * did — home lives at /home, and the fidelity gate, the account panel and
   * the 404's links all address it there. The hand-on happens in the browser
   * against GET /api/auth/session, because this front end has no server-side
   * session of its own to read (there are no SvelteKit hooks here by design:
   * the engine owns auth, on the same origin).
   */
</script>

<SignIn handOnWhenSignedIn />
