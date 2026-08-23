<script>
  import Arrival from "$lib/arrival/Arrival.svelte";

  /**
   * Orbit's front door (#429; the arrival's switchboard since #410/§15).
   *
   * Signed out, the front door IS the sign-in: the ratified login screen, not a
   * redirect to it, so the address a reader types, bookmarks and is returned to
   * by the identity provider is the one they started from.
   *
   * Signed in, it decides what they are looking at — and that decision is the
   * sealed law that first-run "doesn't get its own page — it sits ON TOP of the
   * login screen". A member is handed on to /home exactly as this route already
   * did. A reader with no household stays here: the create card if the instance
   * is empty, the newcomer's climb and its question if it is not.
   *
   * The decision happens in the browser against GET /api/auth/session and GET
   * /api/workspace, because this front end has no server-side session of its
   * own to read (there are no SvelteKit hooks here by design: the engine owns
   * auth, on the same origin).
   */
  let { data } = $props();
</script>

<Arrival {data} />
