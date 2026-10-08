<script>
  import { onMount } from "svelte";
  import Grain from "$lib/Grain.svelte";
  import Dawn from "$lib/flight/Dawn.svelte";
  import { INCOMPLETE, REFUSED, authErrorMessageFor, authErrorStateFor } from "$lib/flight/auth-error-state.js";
  import "$lib/flight/flight.css";
  import "$lib/flight/door-phone.css";

  /**
   * THE CALLBACK'S OWN DOOR (#1056, design/v19/auth-error/round-1/, direction
   * B "the held dawn, refused", owner-ratified 2026-09-19).
   *
   * `web/src/routes/api/auth/callback/+server.js`'s `callbackFailure` sends
   * every failed OIDC callback here as `/auth/error?code=…`; before this
   * route existed that redirect 404'd to the gravity well, so a refused
   * sign-in read as a lost page (#1056's own comments, checked live
   * 2026-09-25 and 2026-09-27).
   *
   * THE IDEA (round-1 README, direction B): the sky records that sign-in did
   * not happen. The reader comes back to the door under the #788 held dawn —
   * first light not yet broken — sharing that family's exact `data-state`
   * mechanism (`SignIn.svelte` / `door-state.js`) with two more values,
   * `incomplete` and `refused` (`auth-error-state.js`), rather than a third
   * implementation of the same sky. `incomplete` is every code but one: the
   * pill stays — unlike the other three held-dawn states, THIS is the one
   * place a held sky keeps a handle, because pressing it plays the door's own
   * sunrise and the retry genuinely IS the recovery. `refused`
   * (`account_disabled`) is the one code where that would be a lie — the
   * administrator switched the account off — so it wears the #788 states'
   * own no-pill treatment exactly, and names the administrator plainly,
   * never the reader.
   *
   * THE ONE ACTION is back to the door, not straight to the identity
   * provider: unlike the ratified "Sign in" gate (`SignIn.svelte`'s `press`),
   * which leaves for `/api/auth/login` because that IS the decision it
   * offers, "Try again" offers another attempt at sign-in generally —
   * whatever door is there when the reader gets back to it, local or
   * provider, a door that may have changed since the failed attempt. The
   * gate's own 420 → 900ms beat is reused verbatim (round-1's own build
   * note); only where it hands over differs.
   *
   * THE WORDS are fixed and read nothing off the wire: no provider text, no
   * error code, no contact address (#1070, and the round-1 README's own
   * verdict note — the ratified table's "let us know at «address»" sentence
   * is struck entirely here, not replaced). `auth-error-state.js` holds them
   * pinned without a browser.
   *
   * THIS SCREEN HOLDS NO DATA (see +page.js): `code` is read from
   * `location.search` in `onMount`, the same way /login reads `returnTo`, so
   * the prerendered HTML — served to every reader alike — defaults to the
   * more common face (`incomplete`) until the browser corrects it; a reader
   * with JavaScript disabled keeps that default, exactly as a JS-disabled
   * reader on /login keeps `returnTo`'s "/" default. `code` itself is never
   * rendered or stored past the one read that picks a row.
   */
  let face = $state(/** @type {"incomplete" | "refused"} */ (INCOMPLETE));
  let leaving = false;

  const reduced = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Set with the face in onMount, from the same one read of `code`, which
     picks the words (#1242: `link_required` says why) and is never rendered. */
  let message = $state(authErrorMessageFor(INCOMPLETE));

  onMount(() => {
    const code = new URLSearchParams(location.search).get("code");
    const resolved = authErrorStateFor(code);
    /* The prerendered default (INCOMPLETE, above) is already right for every
       code but one, so only the correction to REFUSED needs the quick beat
       SignIn.svelte's own `showState` uses for a state reached after the
       door already loaded — the ordinary case here plays the same
       first-light hold a static page with the right words from the start
       would. */
    if (resolved === REFUSED) document.body.classList.add("switched");
    face = resolved;
    message = authErrorMessageFor(resolved, code);
    document.body.dataset.state = face;

    /* first light, as the door does it (SignIn.svelte's own choreography) */
    const frame = requestAnimationFrame(() => setTimeout(() => document.body.classList.add("lit"), 180));

    return () => {
      cancelAnimationFrame(frame);
      document.body.classList.remove("lit");
      delete document.body.dataset.state;
    };
  });

  /** @param {MouseEvent} event */
  function press(event) {
    const gate = /** @type {HTMLElement} */ (event.currentTarget);
    if (leaving) return;
    leaving = true;
    const rm = reduced();
    setTimeout(() => gate.classList.add("flash"), rm ? 0 : 420);
    setTimeout(() => {
      location.href = "/login";
    }, rm ? 200 : 900);
  }
</script>

<svelte:head>
  <title>Orbit — sign-in error</title>
</svelte:head>

<!-- The mockup's own page ground (#04060e), carried as a layer rather than as
     a rule on <body>: see SignIn.svelte's identical note. -->
<div class="signin-stage" aria-hidden="true"></div>
<Dawn shown={true} statePrimary={message.primary} stateSub={message.sub}>
  {#if face === INCOMPLETE}
    <button class="gate" id="gate" onclick={press}>Try again</button>
  {/if}
</Dawn>
<Grain slope={0.08} />
