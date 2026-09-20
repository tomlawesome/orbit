<script>
  import { onMount } from "svelte";
  import Grain from "$lib/Grain.svelte";
  import Dawn from "$lib/flight/Dawn.svelte";
  import "$lib/ringcard.css";
  import "$lib/flight/flight.css";
  import "./approve.css";

  /**
   * APPROVING A SIGN-IN (#1033, ADR-0027 §4).
   *
   * The screen the link in the approval mail opens. It is the door's own
   * surface -- the dawn, the ring, one card in it -- for the same reason
   * `/setup/[token]` is: it is part of getting in, so it belongs to the same
   * night sky rather than being a form on a page. The chrome is off from the
   * first frame (`showform` before the paint that lights the sky), because
   * nobody arrives here to press Sign in.
   *
   * A PHONE SCREEN FIRST (build ruling, 2026-09-18). One column. Approve is
   * full width on top; This wasn't me is the same size directly beneath it, in
   * a quieter colour. Two presses of equal weight, because a reader who did
   * not expect this mail must find the refusal exactly as easily as the person
   * who did find the approval -- and because a small "not me" under a big
   * "yes" teaches people to press the big one.
   *
   * WHAT THIS SCREEN NEVER SAYS. Whose account it is: no name, no address.
   * A link that reaches the wrong hands must tell them nothing they did not
   * already have. What it DOES say is everything about the REQUEST, which is
   * the only thing the reader is being asked to judge.
   *
   * NOBODY IS SIGNED IN HERE, whichever button they press. The browser that
   * typed the password is the one that gets the session, and it is still
   * waiting on its own poll (ADR-0027 §4).
   */
  /**
   * @type {{ data: {
   *   token: string,
   *   request: null | {
   *     instance: string, device: string, where: string,
   *     requestedAt: string, expiresAt: string,
   *     state: "open" | "approved" | "denied" | "lapsed",
   *   },
   * } }}
   */
  let { data } = $props();

  /* The screen's own state, which starts as whatever the server read. Named
     `phase`, not `state`: a local called `state` shadows the `$state` rune for
     the whole component. */
  let phase = $state(data.request?.state ?? "unknown");
  let busy = $state(false);
  /** Orbit's own words for a refusal -- never the server's. */
  let message = $state("");

  onMount(() => {
    document.body.classList.add("showform");
    const frame = requestAnimationFrame(() => document.body.classList.add("lit"));
    return () => {
      cancelAnimationFrame(frame);
      document.body.classList.remove("showform", "lit");
    };
  });

  const headings = {
    open: "Is this you?",
    approved: "Approved",
    denied: "Refused",
    lapsed: "This link has lapsed",
    unknown: "This link is no longer any good",
  };
  const heading = $derived(headings[/** @type {keyof typeof headings} */ (phase)] ?? headings.unknown);

  /**
   * Records the one press. Same-origin with no CSRF token, because there is no
   * session to derive one from -- the token in the body is the whole
   * authorisation and the route asserts same-origin instead, exactly as the
   * setup card's POST does.
   *
   * @param {"approved" | "denied"} decision
   */
  async function decide(decision) {
    if (busy || phase !== "open") return;
    busy = true;
    message = "";
    try {
      const response = await fetch("/api/auth/approve", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: data.token, decision }),
      });
      if (!response.ok) {
        message = "That didn’t work. Try again.";
        return;
      }
      const recorded = (await response.json())?.recorded === true;
      /* A token that was already spent, already answered or lapsed is one
         answer, the same way a setup link has one answer for its three. */
      phase = recorded ? decision : "unknown";
    } catch {
      message = "That didn’t work. Try again.";
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>Orbit — approve a sign-in</title>
</svelte:head>

<main class="ringcard">
  <!-- One landmark, one heading, the arrival's own rule: the heading names the
       screen for a reader who cannot see it. -->
  <h1 class="sr-only">Approve a sign-in to Orbit</h1>

  <div class="signin-stage" aria-hidden="true"></div>
  <Dawn shown={true} />
  <Grain slope={0.08} />

  <div class="bigring" aria-hidden="true">
    <div class="ringglass"></div>
    <div class="ringorbit"><i></i></div>
  </div>

  <div id="formlayer">
    <div class="card approve" aria-label={heading}>
      <p class="approve-head">{heading}</p>

      {#if phase === "open" && data.request}
        <!-- THE BULLETS, IN THE MAIL'S OWN ORDER (ADR-0027 §4-§5): instance,
             browser, address, time. The mail says these four things before its
             link and this screen says them before its buttons, so a reader
             comparing the two is comparing the same four facts. -->
        <ul class="approve-facts">
          <li>Orbit at <b>{data.request.instance}</b></li>
          <li>{data.request.device}</li>
          <li>From {data.request.where}</li>
          <li>{data.request.requestedAt}</li>
        </ul>

        <button class="approve-yes" id="approveyes" type="button" disabled={busy}
                onclick={() => decide("approved")}>Approve</button>
        <button class="approve-no" id="approveno" type="button" disabled={busy}
                onclick={() => decide("denied")}>This wasn’t me</button>

        <p class="note">Lapses {data.request.expiresAt}. Nobody gets in until you approve.</p>
      {:else if phase === "approved"}
        <p class="note">The browser that asked is being let in. You can close this page —
          approving here does not sign this one in.</p>
      {:else if phase === "denied"}
        <p class="note">Nobody was let in. Somebody knows that password, so change it
          the next time you sign in.</p>
      {:else}
        <p class="note">It has been used already, it has been answered already, or it
          has expired. Sign in again to get a new one.</p>
      {/if}

      <p class="err" class:shown={Boolean(message)} role="alert">{message}</p>
    </div>
  </div>
</main>
