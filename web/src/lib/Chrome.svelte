<script>
  import { initials as initialsOf } from "$lib/format.js";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { tick } from "svelte";
  import { createSignOut } from "$lib/sign-out.svelte.js";
  import AccountCard from "$lib/AccountCard.svelte";
  import { chooseTheme } from "$lib/pick.js";
  import Hatch from "$lib/pocket/Hatch.svelte";
  import { watchTour } from "$lib/tour/watch.js";
  import TopChrome from "$lib/pocket/TopChrome.svelte";

  /**
   * The sub-screens' shared chrome (#461): the "← YOUR SKY" way back, the
   * account orb, and the account card ($lib/AccountCard.svelte, shared with
   * home since #1689; the orb, the open state and its dismissal stay here).
   */
  /* The way back defaults to the sky, because that is where every sub-screen
     was reached from. Household management is the exception the design draws:
     it hangs off the helm's memberships card, so its back link says SETTINGS
     and goes there (§15-2k). */
  let {
    user = null,
    household = null,
    current = "",
    back = "/home",
    backLabel = "← YOUR SKY",
  } = $props();

  /* The "household · role" line, built here once for the account card and the
     hatch. A household with no name has no line: never " · member". */
  const line = $derived(household?.name ? `${household.name} · ${household.canManage ? "owner" : "member"}` : "");

  let open = $state(false);

  $effect(() => {
    const close = (/** @type {Event} */ event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".account,.orb")) open = false;
    };
    /** @param {KeyboardEvent} event */
    const onKeydown = (event) => {
      if (event.key !== "Escape" || !open) return;
      const account = document.getElementById("account");
      const hadFocus = account?.contains(document.activeElement);
      open = false;
      if (hadFocus) /** @type {HTMLElement | null} */ (document.querySelector(".orb"))?.focus();
    };
    addEventListener("click", close);
    addEventListener("keydown", onKeydown);
    return () => {
      removeEventListener("click", close);
      removeEventListener("keydown", onKeydown);
    };
  });

  /* THE POCKET (#1120): below the CON-10 switch the way back and the orb
     sit in the retracting top chrome, and the orb opens the hatch, a list
     sheet, instead of the desk card. Both are in the page and CSS picks,
     like home's two dialects. Administration, in the hatch and in the desk
     menu alike (#1440), is for instance admins only (the root layout's load
     says who is one). */
  let hatchOpen = $state(false);
  const isAdmin = $derived(Boolean(page.data?.isAdmin));

  /*
   * Signing out from any page (#410, §15, #1253).
   *
   * One press (owner, 2026-10-06), and it REVOKES before anything is shown:
   * the session is gone before the descent begins, so a lid closed mid-flight
   * can never leave a live session behind.
   *
   * Then the reader gets the ratified DESCENT, the same one home plays
   * (owner, 2026-10-07: "signing out should always play the reverse flight.
   * No matter where you are."). It is $lib/flight/Leave.svelte, shared with
   * home, and it is imported only when the menu is opened or a sign-out is
   * pressed, so a page that is never signed out from does not carry the
   * flight. The hatch below hands its sign-out to it as well.
   */
  /** @type {import('svelte').Component<any> | null} */
  let LeaveView = $state(null);
  /** @type {{ ready: () => void, descendFrom: (redirectTo: string | null) => Promise<void> } | null} */
  let leave = $state(null);
  /** @type {Promise<void> | null} */
  let loading = null;
  /** Fetches the flight code once; false if it could not be had. */
  function loadLeave() {
    loading ??= import("$lib/flight/Leave.svelte").then((m) => { LeaveView = m.default; });
    return loading;
  }
  /* the menu opened: fetch the flight and ready its world, so both are there
     by the time the press has revoked the session */
  async function wake() {
    try { await loadLeave(); } catch { loading = null; return; }
    await tick();
    leave?.ready();
  }
  /**
   * The goodbye, after the session has ended. Exported (#1439) so settings'
   * own sign-outs play this same descent, under the name Leave's has.
   *
   * @param {string | null} redirectTo the provider's own logout URL, if any
   */
  export async function descendFrom(redirectTo) {
    try {
      await loadLeave();
      await tick();
      if (!leave) throw new Error("no flight");
    } catch {
      /* the flight cannot be had: the reader is signed out all the same, and
         the dusk is at /logout -- by way of the provider's own sign-out when
         there is one, which brings the browser back there */
      loading = null;
      location.href = redirectTo ?? "/logout";
      return;
    }
    await leave.descendFrom(redirectTo);
  }

  /* The press, its in-flight guard and its refusal line are
     $lib/sign-out.svelte.js's, shared with the hatch and home (#1355). */
  const signOut = createSignOut(async (redirectTo) => {
    /* #1262: the menu closes as the sign-out goes ahead, never left standing
       over the descent */
    open = false;
    await descendFrom(redirectTo);
  });

  const initials = $derived(initialsOf(user?.displayName));
</script>

<!-- `back` only ever holds "/settings" or the "/home" default (the two
     doors in ./household/[id]/door.js) -- resolve() needs a literal to
     type-check, so it is picked with a plain comparison rather than passed
     straight through as an opaque string. -->
<a class="back" href={back === "/settings" ? resolve("/settings") : resolve("/home")}>{backLabel}</a>
<button class="orb" aria-expanded={open} aria-controls="account" title="Menu"
        onclick={() => { open = !open; if (open) void wake(); }}>{initials}</button>
<AccountCard name={user?.displayName ?? ""} roleLine={line} {isAdmin} {current} {open} {signOut}
             onpick={chooseTheme} onwatch={() => { open = false; void watchTour(); }} />

<div class="pocket-chrome">
  <TopChrome back={back === "/settings" ? resolve("/settings") : resolve("/home")} {backLabel}>
    {#snippet end()}
      <button class="porb" aria-haspopup="dialog" aria-expanded={hatchOpen} aria-label="Account and menu"
              onclick={() => (hatchOpen = true)}><span>{initials}</span></button>
    {/snippet}
  </TopChrome>
</div>
<Hatch bind:open={hatchOpen} name={user?.displayName ?? ""} roleLine={line} {current} {isAdmin}
       onopened={wake} onsignedout={descendFrom} />
{#if LeaveView}
  <!-- no household name to hand on a page that is not home's: the void's name line is empty -->
  <LeaveView bind:this={leave} />
{/if}

<style>
  /*
   * THE WAY BACK, KNOCKED OUT (#491, the '← SETTINGS on sky' hazard).
   *
   * This label is the one piece of chrome in the family that sits DIRECTLY on
   * the starfield with nothing behind it — no panel, no glass, no rule. It was
   * drawn in --ink-faint, which is 2.78:1 on star-chart's ground before a
   * single star is added, and every star that drifts through it makes it worse:
   * 11px of tracked-out mono is thin enough that one bright near-field star
   * landing inside a letter is the difference between reading the word and
   * guessing it.
   *
   * Two moves, and they answer two different problems:
   *   · the INK goes to the text-grade companion, because this is words —
   *     6.59:1 on star-chart, and the same lift on every pack;
   *   · and it gets a BACKING, which is EVA's stencil precedent (that concept
   *     paints its on-sky title stroke-first in the sky's own colour so it
   *     survives a starfield). Here the plate is spent as a halo rather than as
   *     an outline: -webkit-text-stroke at any width a star could hide behind
   *     would close up 11px mono, so three radii of --bg do the knocking out
   *     instead. The sky cannot get between the letters, and nothing is drawn
   *     that a reader would notice as a shape.
   *
   * --bg and not a literal: the plate has to be whatever the pack's ground is,
   * or it becomes a visible smudge the moment someone picks clouds.
   */
  .back{position:fixed;top:30px;left:26px;z-index:6;font:0.6875rem var(--mono);
        letter-spacing:.14em;color:var(--ink-quiet);text-decoration:none;
        text-shadow:0 0 2px var(--bg),0 0 5px var(--bg),0 0 11px var(--bg)}
  .back:hover{color:var(--accent-text)}
  .orb{position:fixed;top:22px;right:26px;z-index:6;width:40px;height:40px;
       border-radius:50%;border:1px solid var(--line);background:var(--panel);
       backdrop-filter:blur(10px);cursor:pointer;display:grid;place-items:center;
       font:0.75rem var(--mono);color:var(--ink-mid)}
  .orb:hover{border-color:var(--accent)}
  /*
   * LEAVING, in home's own beats (#1253; owner ruling 2026-10-07): when the
   * descent plays over one of these pages, the page's header, nav and hatch
   * go first (chromeout, beat 0, home's `withdrawing`), then the page fades
   * as home's own `.desk` does (beat 620, `dispersing`), so nothing of it
   * stands over the dusk. The body classes are Flight.svelte's.
   *
   * The pages share no one wrapper, and each draws its desk and its phone
   * (pocket) markup as separate roots, so the roots are listed here rather
   * than every page re-marked: `.page` is the settings, inbox, about,
   * household and administration desks'; `.belt-page`, `.stage` and
   * `main.kit` are the belt, create/mail and kit ones; the `*-pocket` and
   * `pk-*` classes are the phone dialects'. A new page that renders Chrome
   * adds its root here, never a root that contains Chrome itself (the
   * dusk is drawn inside it, and would go too: settings' `.helm-page`).
   * The chrome itself
   * (way back, orb, the pocket's top bar) goes with the page: `withdrawing`
   * ends at the next beat, so `dispersing` keeps it gone.
   */
  :global(body.withdrawing .page > :is(header,nav,.hatch)){animation:chromeout .45s ease both}
  :global(body.withdrawing :is(.back,.orb,.p-chrome)){animation:chromeout .45s ease both}
  :global(body.dispersing :is(.page,.belt-page,.stage,main.kit,
      .st-pocket,.pk-inbox,.ad-pocket,.pk-create,.hh-pocket,.rl-pocket,
      .back,.orb,.account,.p-chrome)){
    opacity:0;visibility:hidden;pointer-events:none;
    transition:opacity .7s ease .15s,visibility 0s linear .85s}
  :global(body.pinned :is(.page,.belt-page,.stage,main.kit,
      .st-pocket,.pk-inbox,.ad-pocket,.pk-create,.hh-pocket,.rl-pocket,
      .back,.orb,.account,.p-chrome)){transition:none!important}
  @media (prefers-reduced-motion:reduce){
    :global(body.withdrawing .page > *),:global(body.withdrawing :is(.back,.orb,.p-chrome)){animation:none!important}
    :global(body.dispersing :is(.page,.belt-page,.stage,main.kit,
        .st-pocket,.pk-inbox,.ad-pocket,.pk-create,.hh-pocket,.rl-pocket,
        .back,.orb,.account,.p-chrome)){transition:none}
  }

  /* The dialect switch (CON-10), the same query as home's pocket.css and
     $lib/pocket/media.js. Above it nothing here changes the desk. */
  .pocket-chrome{display:none}
  @media (max-width:900px), (max-height:600px){
    .back,.orb,:global(.account){display:none}
    .pocket-chrome{display:contents}
  }
  /* The orb: drawn 36px, hit 44px (§1.3). */
  .porb{appearance:none;width:var(--p-hit);height:var(--p-hit);padding:0;border:0;background:none;
        display:grid;place-items:center;cursor:pointer;-webkit-tap-highlight-color:transparent}
  /* No blur: --panel over the sky is enough at 36px, and a blur on a fixed
     layer repaints on every scroll (§5.3). */
  .porb span{width:36px;height:36px;border-radius:50%;border:1px solid var(--line);
        background:var(--panel);display:grid;place-items:center;
        font:var(--p-type-meta) var(--mono);color:var(--ink-mid)}
  /* §25: the ring sits on the focused button itself, not its drawn disc --
     a ring on the child left the button with no indicator of its own. The
     44px circle inset by 2px draws the same ring the disc's outline did. */
  .porb{border-radius:50%}
  .porb:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
</style>
