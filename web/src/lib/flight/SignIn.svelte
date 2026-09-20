<script>
  import { onMount } from "svelte";
  import Grain from "$lib/Grain.svelte";
  import Dawn from "./Dawn.svelte";
  import Claim from "./Claim.svelte";
  import Identity from "./Identity.svelte";
  import Waiting from "./Waiting.svelte";
  import { clearLaunch, markLaunch } from "./arrival.js";
  import {
    CLAIM, DOOR, LOCAL, STARTING, STARTING_BACKSTOP_MS,
    applyStartingBackstop, availabilityOf, cardMessageFor, claimFromHash, doorMessageFor,
    doorModeOf, nextDoorState, phaseOf, readinessOf,
  } from "./door-state.js";
  import "$lib/ringcard.css";
  import "./flight.css";

  /**
   * THE SIGN-IN (#410, §15).
   *
   * The owner ratified the login/logout flight verbatim on 2026-08-16 —
   * "nothing short of amazing... Ship these in that exact form" — and ruled in
   * the same breath that they are NOT first-run dressing: they ship as THE
   * login and logout screens for every user, every time; first-run just
   * happens to use them. So this screen is design/v19/first-run.html's login
   * layer, drawn as it draws it: the dawn limb, and — since the owner's
   * 2026-08-17 correction, applied to sheet and app together — the 2026-08-14
   * lockup on top of it: the ring large and centred, `orbit` inside it, the
   * small gold pill inside the ring beneath the word, and no ribbon and no
   * footer anywhere on the screen.
   *
   * THE HONEST DEVIATION, stated where it happens. The mockup's flight runs
   * unbroken from this button. Pressing it in the product leaves Orbit for the
   * identity provider, so the journey is cut at the departure and nowhere
   * else: the gate flashes over the mockup's own 420 → 900ms window, and at
   * 900 — exactly the beat the mockup hands over to the climb — this page
   * hands over to /api/auth/login instead. The climb itself, whole and
   * unaltered, plays on the authenticated return (see Flight.svelte and the
   * launch overlay on /home). A one-shot marker written here and consumed
   * there is what tells the landing that a genuine sign-in just happened; see
   * arrival.js for why that is honest and why it cannot replay.
   */
  let {
    /*
     * WHERE THE JOURNEY LANDS. The front door is the arrival's switchboard
     * (#410, §15: "first-run sits ON TOP of the login screen, not its own
     * page"), so a reader coming back from the identity provider comes back
     * to "/" and it decides what they are looking at: home, the create card,
     * or the newcomer's climb. /login hands the same decision on by returning
     * to the same address.
     */
    returnTo = "/",
    /*
     * THE ONE DIFFERENCE THE CREATE PATH HAS (§15, fourth pass, verbatim):
     * "the orbit logo and text reappear and we run the login intro, the only
     * tweak being this time there's no login button as we already passed it."
     * So the identity-provider button — and only that — can be left off,
     * while the dawn, the lockup and the first light stay exactly as ratified.
     */
    gate = true,
    /*
     * The dawn holds itself up on this screen, because this screen IS the
     * dawn. When a flight is about to lift off it, the body class takes the
     * visibility over instead, so the ascent's `release` beat at 430ms has
     * something to release.
     */
    dawnShown = true,
    /* One <title> per document: the arrival's stages stand on this surface, so
       they name it rather than adding a second one. */
    title = "Orbit — sign in",
  } = $props();

  let leaving = false;

  const reduced = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /*
   * THE THREE STATES WHERE THE DOOR CANNOT OPEN (#788, design/v19/
   * signin-states/round-1/, direction C, owner-ratified 2026-09-06).
   *
   * Default optimistic: the door's own `data-state` starts (and, for a
   * healthy instance, stays) unset — the ordinary button, unchanged from
   * before this issue — so a healthy sign-in shows nothing different at all,
   * and the very first paint (this route is prerendered, static HTML with no
   * JS run yet) is always the door. Only once a check answers with a real
   * problem does `onMount` below set `data-state` at all.
   *
   * The button itself stays in the markup throughout (`{#if gate}`, as
   * before this issue) — flight.css hides `.gate-wrap` by `data-state`,
   * exactly as the ratified sheet does, rather than this component removing
   * and re-inserting the button. That is what lets its ratified 3.6s-delayed
   * entrance replay correctly on recovery: a freshly inserted element has no
   * "before" style to transition from, but a `display:none` element coming
   * back already does. `display:none` still meets the round-1 README's
   * accessibility bar ("not rendered... not merely hidden"): unlike
   * `opacity:0` or `visibility:hidden`, it drops the button from both the
   * layout and the accessibility tree, so it is not reachable by keyboard or
   * screen reader while sign-in is unavailable.
   */
  let statePrimary = $state("");
  let stateSub = $state("");

  /*
   * THE OPEN DOOR'S THREE FACES, AND THE CARD THAT STANDS IN THE RING
   * (#914, plan §2.7, ADR-0022 §1–§2, ADR-0023 §1). Composition ruled by the
   * owner on 2026-09-09; see design/owner-decisions.md.
   *
   * Nothing here can reach the three states above. `card` is only ever set
   * once `nextDoorState` has already answered DOOR, so an instance that is
   * still booting, misconfigured or broken shows exactly what #788 ratified
   * and no card at all — which is also why a claim card can never be a
   * screen a reader reaches by an instance being unwell.
   *
   * `card` is the empty string for the ratified door and one of "claim",
   * "create", "signin" otherwise. The empty default matters as much as the
   * others: this route is prerendered static HTML, so the very first paint is
   * always the door, and a card only ever arrives once the server has said so.
   */
  let card = $state("");
  /** Whether the quiet "local login" line stands under the gate (mixed mode). */
  let localLine = $state(false);
  /** Whether an identity provider is configured, for the create card's one line. */
  let providerOffered = $state(false);
  let busy = $state(false);
  /** Orbit's own words for a refusal — never the server's. */
  let message = $state("");

  /*
   * THE SECOND SCREEN (#1033, ADR-0027 §1, §4). A correct password no longer
   * ends the journey: the server answers with a pending sign-in, this card
   * becomes "waiting", and the tab holds until somebody reading the emailed
   * link approves it. Nothing about the dawn, the ring or the launch's timings
   * moves -- the same `markLaunch()` fires at the same beat, just later, when
   * the session actually arrives.
   */
  /** "waiting" while nobody has answered; "denied" and "lapsed" are ends. */
  let pendingState = $state(/** @type {"waiting" | "denied" | "lapsed"} */ ("waiting"));
  /** Epoch ms when another mail may be asked for (ADR-0027 §8's minute). */
  let canResendAt = $state(0);
  /** ADR-0027 §8's fifth send in an hour: read the mail we already sent. */
  let limited = $state(false);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let approvalTimer;
  /** Set by the component's own teardown, so a poll in flight lands nowhere. */
  let approvalStopped = false;

  let claimCode = $state("");
  let email = $state("");
  let displayName = $state("");
  let password = $state("");

  /**
   * Raises or drops the card layer. `showform` is the same class the arrival
   * uses for the create-system card, and deliberately so: ringcard.css keys
   * the ring's entrance, the card layer's fade and the disappearance of the
   * login chrome off it, and two names for one state would be two states.
   *
   * SHARED CLASS, SO ONLY WHAT THIS COMPONENT RAISED IS EVER DROPPED. On the
   * front door this component is a CHILD of the arrival, which raises the
   * same class for the create-system card (`enterCreate`) — and the two do
   * not run in a fixed order: the arrival raises it when the workspace read
   * answers, this component decides when the availability read does. Written
   * as a plain toggle, whichever lost the race took the other's card off the
   * screen; the fidelity gate caught it as the create card vanishing behind
   * a login it had already replaced. Add-only unless we are the one holding
   * it up.
   */
  let raised = false;
  /** @param {boolean} on */
  function showCard(on) {
    if (on) {
      raised = true;
      document.body.classList.add("showform");
    } else if (raised) {
      raised = false;
      document.body.classList.remove("showform");
    }
  }

  /**
   * POSTs a card's answers and reports back in Orbit's own words.
   *
   * Same-origin and no CSRF token, because none of these four routes has a
   * session to derive one from: they assert same-origin instead, which is the
   * boundary that applies to a signed-out write (see each route's own note).
   *
   * A response that is not JSON, or no response at all, is a refusal like any
   * other — `cardMessageFor(undefined)` is the generic line — so a proxy
   * returning an HTML error page can no more put its own text on this screen
   * than a hostile body can.
   *
   * Answers the parsed body on success -- `{}` when there is nothing readable
   * in it -- and `null` on any refusal, so a caller can still write
   * `if (await present(...))` and a caller that needs what came back (the
   * sign-in card, since #1033: a correct password answers with a PENDING
   * sign-in rather than a session) can read it without a second request.
   *
   * @param {string} url
   * @param {Record<string, string>} body
   * @returns {Promise<Record<string, any> | null>} the answer, or null if it did not work
   */
  async function present(url, body) {
    busy = true;
    message = "";
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        try {
          return (await response.json()) ?? {};
        } catch {
          return {};
        }
      }
      /* The envelope `authErrorResponse` writes is `{ error: { code, message } }`;
         only the code is read, never the message. */
      let code;
      try {
        code = (await response.json())?.error?.code;
      } catch {
        code = undefined;
      }
      message = cardMessageFor(code);
      return null;
    } catch {
      message = cardMessageFor(undefined);
      return null;
    } finally {
      busy = false;
    }
  }

  /** The claim, and the create card it reveals (ADR-0022 §2). */
  async function submitClaim() {
    if (busy || !claimCode.trim()) return;
    if (await present("/api/auth/bootstrap/claim", { claim: claimCode.trim() })) {
      /* The code is spent the moment it is accepted: it never goes back into
         a field, and the cookie the route minted is what the next request
         carries. */
      claimCode = "";
      card = "create";
    }
  }

  /** The first administrator (ADR-0022 §2). Lands on the arrival, signed in,
   *  where the create-system card is waiting — the ratified first-run journey,
   *  entered exactly as an identity provider's callback enters it. */
  async function submitCreate() {
    if (busy) return;
    if (await present("/api/auth/bootstrap/local", { email, displayName, password })) {
      password = "";
      markLaunch();
      location.href = "/";
    }
  }

  /**
   * Local sign-in (ADR-0023 §4, ADR-0027 §1). Lands wherever the door was
   * asked for -- once the emailed approval has come back.
   *
   * Two answers now. An instance with no mail relay has no second factor to
   * apply (ADR-0027 §2) and signs the reader straight in, exactly as before.
   * Every other instance answers with a pending sign-in, and this card gives
   * way to the waiting one. The password is cleared either way, the moment it
   * has been spent.
   */
  async function submitSignIn() {
    if (busy) return;
    const answer = await present("/api/auth/local/login", { email, password });
    if (!answer) return;
    password = "";
    if (answer.pending) {
      waitForApproval(answer.pending);
      return;
    }
    markLaunch();
    location.href = returnTo;
  }

  /** Raises the waiting card and starts asking. @param {Record<string, any>} pending */
  function waitForApproval(pending) {
    message = "";
    pendingState = "waiting";
    limited = pending.limited === true;
    canResendAt = Date.parse(pending.canResendAt) || 0;
    card = "waiting";
    showCard(true);
    askAgain();
  }

  /**
   * One round of "has anybody answered yet", every two seconds.
   *
   * The claim cookie the sign-in route handed this browser is the whole of the
   * request: nothing is sent in the body, and a tab without that cookie gets
   * `unknown` however long it asks (ADR-0027 §4, build ruling 2026-09-18).
   *
   * An unreadable answer is not an end -- a proxy hiccup must not throw a
   * reader out of a sign-in that is still perfectly live -- so only the
   * server's own three words stop the loop.
   */
  function askAgain() {
    if (approvalStopped) return;
    approvalTimer = setTimeout(async () => {
      if (approvalStopped) return;
      let answer = null;
      try {
        const response = await fetch("/api/auth/local/login/pending", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        answer = response.ok ? await response.json() : null;
      } catch {
        answer = null;
      }
      if (approvalStopped) return;
      if (answer?.state === "approved") {
        /* The session is already in this browser's cookie jar: the poll route
           minted it for THIS tab and nobody else. The ratified launch plays
           from here exactly as it does after any other way in. */
        markLaunch();
        location.href = returnTo;
        return;
      }
      if (answer?.state === "denied") {
        pendingState = "denied";
        return;
      }
      if (answer?.state === "unknown") {
        pendingState = "lapsed";
        return;
      }
      askAgain();
    }, 2000);
  }

  /** "Send it again", inside ADR-0027 §8's limits, which the server keeps. */
  async function resendApproval() {
    if (busy) return;
    busy = true;
    message = "";
    try {
      const response = await fetch("/api/auth/local/login/resend", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const answer = response.ok ? await response.json() : null;
      if (!answer) {
        message = cardMessageFor(undefined);
        return;
      }
      if (answer.state === "limited") limited = true;
      else if (answer.state === "unknown") pendingState = "lapsed";
      else canResendAt = Date.parse(answer.canResendAt) || 0;
    } catch {
      message = cardMessageFor(undefined);
    } finally {
      busy = false;
    }
  }

  /** Mixed mode's quiet line: the same card, opened rather than offered. */
  function openLocal() {
    message = "";
    card = "signin";
    showCard(true);
  }

  /** The create card's one provider line — the claim cookie authorises the
   *  bootstrap sign-in, exactly as the claim endpoint's own note describes. */
  function toProvider() {
    location.href = `/api/auth/login?returnTo=${encodeURIComponent("/")}`;
  }

  /** Fetches JSON, answering `null` for anything that cannot be trusted — a
   *  network failure, a non-2xx the caller still wants the body of, or a
   *  response that is not JSON at all. Never throws. @param {string} url */
  async function fetchJson(url) {
    try {
      const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      return await response.json();
    } catch {
      return null;
    }
  }

  /** One round of both checks (#788, #869): availability first, since its
   *  `phase` field is what decides whether there is any point asking
   *  readiness at all — `phase: "starting"` is `STARTING` regardless of
   *  what `/api/health` would say, so a booting instance costs one request,
   *  not two. Readiness is only fetched once `phase` says boot is done and
   *  a degraded or unreadable answer becomes a fault worth failing on. */
  async function checkOnce() {
    const availabilityBody = await fetchJson("/api/auth/availability");
    const phase = phaseOf(availabilityBody);
    const availability = availabilityOf(availabilityBody);
    const readiness = phase === "running" ? readinessOf(await fetchJson("/api/health")) : null;
    return {
      state: nextDoorState({ phase, readiness, availability }),
      contactAddress: availability?.contactAddress ?? null,
      /* Read off the same body, and acted on only when the state is DOOR
         (#914): which face an OPEN door wears is a different question from
         whether it may open, and `doorModeOf` answers only the first. */
      face: doorModeOf(availabilityBody),
    };
  }

  onMount(() => {
    /* A marker left over from an abandoned sign-in must never fire later. */
    clearLaunch();

    /*
     * THE CODE OUT OF THE ADDRESS BAR, FIRST (ADR-0022 §1).
     *
     * Before anything is asked of the server and before a frame is drawn with
     * it on screen: an operator who followed the link in the container's log
     * is holding a one-use secret in their address bar, and a fragment is
     * kept there by every bookmark, screenshot and back button. `replaceState`
     * rewrites the entry in place, so there is no history step carrying it
     * either — and the fragment never reached a server to begin with, which
     * is why the notice puts the code there rather than in a query string.
     *
     * The code is held in a local, not in `claimCode`, until the door knows
     * the instance is actually unclaimed: filling a field on a claimed
     * instance would put a secret back on a screen it has no business on.
     */
    const linkClaim = claimFromHash(location.hash);
    if (linkClaim) history.replaceState(null, "", location.pathname + location.search);

    /** @type {ReturnType<typeof setTimeout>[]} */
    const timers = [];
    /** @param {number} ms @param {() => void} fn */
    const after = (ms, fn) => timers.push(setTimeout(fn, ms));
    /* first light: the dawn breaks once on load (CON-9, POL-13) */
    const frame = requestAnimationFrame(() => after(180, () => document.body.classList.add("lit")));

    let disposed = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let pollTimer;

    /**
     * Shows a state other than the door: fixed words, styled to match it.
     * @param {Parameters<typeof doorMessageFor>[0]} state
     * @param {string | null} [contactAddress]
     */
    function showState(state, contactAddress) {
      const message = doorMessageFor(state, contactAddress);
      statePrimary = message.primary;
      stateSub = message.sub;
      document.body.classList.add("switched");
      document.body.dataset.state = state;
    }

    /* The waking instance comes up on its own — no action from the reader
       (round-1 README, "deliberately not done": no Try again control). The
       held sky releases into the ratified first light exactly as it would on
       a fresh, healthy load; only the words fade out first. */
    function recoverToDoor() {
      document.body.classList.add("returning");
      after(reduced() ? 200 : 800, () => {
        if (disposed) return;
        statePrimary = "";
        stateSub = "";
        document.body.dataset.state = DOOR;
        document.body.classList.add("returned");
      });
    }

    /**
     * WHICH FACE THE OPEN DOOR WEARS (#914, §2.7). Called only when the state
     * is DOOR, so it can never overwrite one of the three cannot-open states.
     *
     * A door that shows a card raises `showform`, which is what takes the
     * login chrome off the screen and brings the ring up in its place —
     * exactly the beat the create-system card already plays. Mixed mode
     * raises nothing at all: the ratified door is unchanged, and the quiet
     * "local login" line under the gate is the only thing added to it, only
     * when a local credential actually exists.
     *
     * @param {{ mode: string, localAccounts: boolean, oidc: boolean }} face
     */
    function wearFace(face) {
      providerOffered = face.oidc;
      if (face.mode === CLAIM) {
        card = "claim";
        localLine = false;
        /* The link's own code, filled and sent without the operator typing
           it — the whole point of the notice being a link (ADR-0022 §1). */
        if (linkClaim) {
          claimCode = linkClaim;
          submitClaim();
        }
      } else if (face.mode === LOCAL) {
        card = "signin";
        localLine = false;
      } else {
        card = "";
        localLine = face.localAccounts;
      }
      showCard(card !== "");
    }

    async function run() {
      const first = await checkOnce();
      if (disposed) return;
      if (first.state === DOOR) {
        wearFace(first.face);
        return;
      }
      const wasStarting = first.state === STARTING;
      showState(first.state, first.contactAddress);
      if (!wasStarting) return;

      /* Measured from the first paint of STARTING, not from the server's own
         boot start, which this page never learns. Only Date.now() and
         setTimeout live here; whether that makes the door give up or poll
         again is applyStartingBackstop's decision, pinned without a
         browser in door-state.test.mjs. */
      const backstopAt = Date.now() + STARTING_BACKSTOP_MS;
      const poll = async () => {
        if (disposed) return;
        const next = await checkOnce();
        if (disposed) return;
        const resolved = applyStartingBackstop(next.state, backstopAt, Date.now());
        if (resolved === STARTING) {
          pollTimer = setTimeout(poll, 4000);
          return;
        }
        if (resolved === DOOR) {
          /* The instance finished waking: whichever face it woke up wearing
             is the one the released dawn hands over to. */
          wearFace(next.face);
          recoverToDoor();
        } else showState(resolved, next.contactAddress);
      };
      pollTimer = setTimeout(poll, 4000);
    }
    run();

    return () => {
      disposed = true;
      approvalStopped = true;
      clearTimeout(approvalTimer);
      clearTimeout(pollTimer);
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
      document.body.classList.remove("lit", "switched", "returning", "returned");
      /* Same rule as showCard: never take down a card somebody else put up. */
      showCard(false);
      delete document.body.dataset.state;
    };
  });

  /** @param {MouseEvent} event */
  function press(event) {
    const gate = /** @type {HTMLElement} */ (event.currentTarget);
    if (leaving) return;
    leaving = true;
    markLaunch();
    const rm = reduced();
    setTimeout(() => gate.classList.add("flash"), rm ? 0 : 420);
    setTimeout(() => {
      location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
    }, rm ? 200 : 900);
  }
</script>

<svelte:head>
  <title>{title}</title>
</svelte:head>

<!-- The mockup's own page ground (#04060e), carried as a layer rather than as
     a rule on <body>: a stylesheet that reached the document would follow the
     reader onto every other screen once its chunk had loaded. -->
<div class="signin-stage" aria-hidden="true"></div>
<Dawn shown={dawnShown} {statePrimary} {stateSub}>
  <!-- `Sign in`, the ratified word (08-14), and the word the sunset's own
       pill was reworded to match. The sheet's longer
       "Continue with your identity provider" belonged to the v18 chrome
       struck on 2026-08-17 — and would not fit inside the ring in any case.
       What it said is still true and is still said, out loud, one screen
       later: pressing this leaves for the identity provider.

       Left off entirely on the create path, where the reader is already
       through it (§15, fourth pass), and on every screen where a card stands
       in the ring instead (#914): an unclaimed instance has nobody to sign in
       as, and a local-only one signs them in on the card itself. -->
  {#if gate && card === ""}<button class="gate" id="gate" onclick={press}>Sign in</button>
    <!-- MIXED MODE, and only mixed mode (§2.7, verbatim): "the ratified door
         is unchanged — Sign in gate as today — plus one subtle line under the
         gate, 'local login', which opens that same card in the ring". It is
         absolutely positioned off the bottom of the wrapper rather than laid
         out under the button, because `.gate-wrap` is centred in its grid
         cell: laid out, a second element would push the ratified button half
         its own height upward, and "unchanged" would stop being true. -->
    {#if localLine}
      <div class="localopen">
        <button type="button" class="quietline" id="localopen" onclick={openLocal}>local login</button>
      </div>
    {/if}
  {/if}
</Dawn>
<Grain slope={0.08} />

<!-- THE RING AND THE CARD (#914, §2.7). Siblings of the dawn and after the
     grain, in the order the arrival already stands them in, so the card is
     over the grain on both surfaces and nothing about the layering is a
     second answer to a question already settled. `aria-hidden` on the ring
     for the reason the arrival gives: it is the card's frame, and the card
     is the thing with the words in it. -->
{#if card !== ""}
  <div class="ringcard">
    <div class="bigring" aria-hidden="true">
      <div class="ringglass"></div>
      <!-- the ring's line, on its own unblurred box (#873): the glass
           closes on the compositor, this closes by width/height so the
           4.2px stroke never thins. See ringcard.css. -->
      <div class="ringstroke"></div>
      <div class="ringorbit"><i></i></div>
    </div>
    {#if card === "claim"}
      <Claim bind:claim={claimCode} {busy} {message} onsubmit={submitClaim} />
    {:else if card === "waiting"}
      <Waiting phase={pendingState} {canResendAt} {limited} {busy} {message} onresend={resendApproval} />
    {:else if card === "create"}
      <Identity mode="create" bind:email bind:displayName bind:password
                provider={providerOffered} {busy} {message}
                onsubmit={submitCreate} onprovider={toProvider} />
    {:else}
      <Identity mode="signin" bind:email bind:password {busy} {message} onsubmit={submitSignIn} />
    {/if}
  </div>
{/if}
