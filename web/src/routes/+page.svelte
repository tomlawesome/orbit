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
   * login screen". A member never reaches this file: since #1252 the server
   * hook (web/src/hooks.server.js, `frontDoor`) answers them 303 to /home
   * before any of this HTML is sent, so a refresh no longer shows them the
   * door. A reader with no household stays here: the create card if the
   * instance is empty, the newcomer's climb and its question if it is not.
   *
   * That rest of the decision happens in the browser against GET
   * /api/auth/session and GET /api/workspace (Arrival.svelte's decide()),
   * which still also hands a member on if one ever gets this far — the
   * invited reader's first landing does, on purpose, so the arrival plays.
   */
  let { data } = $props();
</script>

<Arrival {data} />
