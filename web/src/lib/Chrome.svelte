<script>
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { tick } from "svelte";
  import { signOut } from "$lib/data/workspace.js";
  import { DEFAULT_THEME } from "$lib/theme.js";
  import { SWATCHES, applyTheme } from "$lib/theme-swatches.js";
  import Hatch from "$lib/pocket/Hatch.svelte";
  import { watchTour } from "$lib/tour/watch.js";
  import TopChrome from "$lib/pocket/TopChrome.svelte";

  /**
   * The sub-screens' shared chrome (#461): the "← YOUR SKY" way back, the
   * account orb, and the account card with the journey nav and the five pack
   * swatches. Markup and styles are the #452 mockups' own, verbatim; home
   * keeps its inline copy for now because its card also closes sibling
   * overlays the sub-screens don't have.
   */
  /* The way back defaults to the sky, because that is where every sub-screen
     was reached from. Household management is the exception the design draws:
     it hangs off the helm's memberships card, so its back link says SETTINGS
     and goes there (§15-2k). */
  let {
    user = null,
    role = "",
    current = "",
    back = "/home",
    backLabel = "← YOUR SKY",
  } = $props();

  /* §14: due-next and documents retired — the manifest is the corridor and
     the belt is the document surface.
     #1014: the belt (/item/[[id]]) has no front door of its own elsewhere in
     the chrome, so it gets one here, above Inbox; since #1010 the belt renders
     Chrome too, so "item" is a `current` that lights up. */
  const NAV = [
    ["item", "Items", "/item"],
    ["inbox", "Inbox", "/inbox"],
    ["settings", "Settings", "/settings"],
    ["administration", "Administration", "/administration"],
    /* #1256: last in every menu, for every member -- the credits reach
       everyone who uses what they credit. */
    ["about", "About", "/about"],
  ];
  /* The five swatches and the act of choosing one: $lib/theme-swatches.js,
     shared with the pocket hatch (#1120). */

  let open = $state(false);
  let active = $state(DEFAULT_THEME);

  $effect(() => {
    active = document.documentElement.dataset.theme || DEFAULT_THEME;
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

  /** @param {string} name */
  function setSwatch(name) {
    active = name;
    applyTheme(name);
  }

  /* THE POCKET (#1120): below the CON-10 switch the way back and the orb
     sit in the retracting top chrome, and the orb opens the hatch, a list
     sheet, instead of the desk card. Both are in the page and CSS picks,
     like home's two dialects. Administration in the hatch is for instance
     admins only (the root layout's load says who is one). */
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
  /** @param {string | null} redirectTo the provider's own logout URL, if any */
  async function descend(redirectTo) {
    try {
      await loadLeave();
      await tick();
      if (!leave) throw new Error("no flight");
    } catch {
      /* the flight cannot be had: the reader is signed out all the same, and
         the dusk is at /logout */
      loading = null;
      location.href = "/logout";
      return;
    }
    await leave.descendFrom(redirectTo);
  }

  /* set while the request is in flight, so a second press never fires a
     second, concurrent signOut() (#1151 W1-R7, as home has it) */
  let signingOut = $state(false);
  /** @type {string | null} */
  let signOutProblem = $state(null);
  async function tapSignOut() {
    if (signingOut) return;
    signingOut = true;
    signOutProblem = null;
    /** @type {string | null} */
    let redirectTo = null;
    try {
      redirectTo = await signOut();
    } catch (error) {
      signingOut = false;
      signOutProblem = /** @type {{ message?: string }} */ (error)?.message ?? "still signed in — try again";
      return;
    }
    /* #1262: the menu closes as the sign-out goes ahead, never left standing
       over the descent */
    open = false;
    await descend(redirectTo);
  }

  /*
   * No `part` annotation here (#1133): a bare JSDoc comment directly before
   * an arrow function's own parameter -- anywhere outside the
   * `/** @type {T} *\/ (expr)` cast idiom used above for `error` -- makes the
   * Svelte compiler re-emit the parameter wrapped in an extra, invalid pair
   * of parens (`((part))`). `vite build` bundles through rolldown, which
   * tolerates it and prints clean code, but `vite dev`'s SSR module runner
   * hands the raw text straight to V8, which doesn't: every load of a page
   * that reaches this component 500'd under `pnpm --filter orbit-web dev`
   * with "SyntaxError: Invalid destructuring assignment target", never in
   * the production build. The type goes on the name instead, in that cast
   * idiom: `user` carries no declared type, so without it `part` is an
   * implicit `any` and the type check (#624) fails.
   */
  const initials = $derived(
    /** @type {string} */ (user?.displayName ?? "")
      .split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "·",
  );
</script>

<!-- `back` only ever holds "/settings" or the "/home" default (the two
     doors in ./household/[id]/door.js) -- resolve() needs a literal to
     type-check, so it is picked with a plain comparison rather than passed
     straight through as an opaque string. -->
<a class="back" href={back === "/settings" ? resolve("/settings") : resolve("/home")}>{backLabel}</a>
<button class="orb" aria-expanded={open} aria-controls="account" title="Menu"
        onclick={() => { open = !open; if (open) void wake(); }}>{initials}</button>
<div class="account" class:open id="account" role="region" aria-label="Account and menu">
  <div class="who"><b>{user?.displayName ?? ""}</b><span>{role}</span></div>
  <nav>
    {#each NAV as [key, label, href] (key)}
      <a href={href === "/item" ? resolve("/item")
          : href === "/inbox" ? resolve("/inbox")
          : href === "/settings" ? resolve("/settings")
          : href === "/about" ? resolve("/about")
          : resolve("/administration")} aria-current={key === current ? "page" : undefined}>{label}</a>
    {/each}
  </nav>
  <div class="swatches" role="group" aria-label="Theme">
    <span>THEME</span>
    {#each SWATCHES as { id, title, colour, shadow } (id)}
      <button style="background:{colour}{shadow ? `;box-shadow:${shadow}` : ""}" {title}
              aria-pressed={active === id} onclick={() => setSwatch(id)}></button>
    {/each}
  </div>
  <!-- Beside the theme, as on the phone (#1189). -->
  <button class="watch" onclick={() => { open = false; void watchTour(); }}>↻ watch the tour</button>
  <button class="signout" onclick={tapSignOut} disabled={signingOut}>sign out →</button>
  {#if signOutProblem}<div class="signout-problem">{signOutProblem}</div>{/if}
</div>

<div class="pocket-chrome">
  <TopChrome back={back === "/settings" ? resolve("/settings") : resolve("/home")} {backLabel}>
    {#snippet end()}
      <button class="porb" aria-haspopup="dialog" aria-expanded={hatchOpen} aria-label="Account and menu"
              onclick={() => (hatchOpen = true)}><span>{initials}</span></button>
    {/snippet}
  </TopChrome>
</div>
<Hatch bind:open={hatchOpen} name={user?.displayName ?? ""} roleLine={role} {current} {isAdmin}
       onopened={wake} onsignedout={descend} />
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
  .back{position:fixed;top:30px;left:26px;z-index:6;font:11px var(--mono);
        letter-spacing:.14em;color:var(--ink-quiet);text-decoration:none;
        text-shadow:0 0 2px var(--bg),0 0 5px var(--bg),0 0 11px var(--bg)}
  .back:hover{color:var(--accent-text)}
  .orb{position:fixed;top:22px;right:26px;z-index:6;width:40px;height:40px;
       border-radius:50%;border:1px solid var(--line);background:var(--panel);
       backdrop-filter:blur(10px);cursor:pointer;display:grid;place-items:center;
       font:12px var(--mono);color:var(--ink-mid)}
  .orb:hover{border-color:var(--accent)}
  .account{position:fixed;top:70px;right:26px;z-index:6;width:240px;
           background:var(--panel-raised);backdrop-filter:blur(14px);
           border:1px solid var(--line);border-radius:16px;padding:18px 20px;
           opacity:0;transform:translateY(-6px);pointer-events:none;
           /* #847: closed, this must leave the tab order entirely — opacity
              and pointer-events alone still let Tab land on the links and
              swatch buttons inside. visibility is delayed to match the close
              animation's own .25s so it still plays; opening clears the delay
              so the panel is reachable the instant it appears. */
           visibility:hidden;
           transition:opacity .25s,transform .25s,visibility 0s .25s}
  .account.open{opacity:1;transform:none;pointer-events:auto;
                visibility:visible;transition-delay:0s}
  .account .who b{display:block;font-size:14px;font-weight:560}
  .account .who span{font-size:12px;color:var(--ink-mid)}
  .account nav{display:flex;flex-direction:column;gap:2px;margin:14px 0;
               padding:12px 0;border-top:1px solid var(--line-soft);
               border-bottom:1px solid var(--line-soft)}
  .account nav a{font-size:13.5px;color:var(--ink-mid);text-decoration:none;
                 padding:6px 8px;border-radius:8px}
  .account nav a:hover{color:var(--ink);background:var(--panel)}
  .account nav a[aria-current]{color:var(--accent-text)}
  .swatches{display:flex;gap:10px;align-items:center;margin-bottom:12px}
  .swatches span{font:10.5px var(--mono);color:var(--ink-quiet);margin-right:2px}
  .swatches button{width:18px;height:18px;border-radius:50%;cursor:pointer;
                   border:1px solid var(--line);padding:0}
  .swatches button[aria-pressed=true]{outline:2px solid var(--accent);outline-offset:2px}
  .watch{display:block;margin-bottom:12px;font:12px var(--mono);color:var(--accent-text);
         background:none;border:0;cursor:pointer;padding:0}
  .watch:hover{text-decoration:underline}
  .signout{font:12px var(--mono);color:var(--ink-quiet);background:none;border:0;cursor:pointer;padding:0}
  .signout:hover{color:var(--overdue-text)}
  .signout-problem{font:10.5px var(--mono);color:var(--overdue-text);margin-top:7px;line-height:1.7}

  /* The dialect switch (CON-10), the same query as home's pocket.css and
     $lib/pocket/media.js. Above it nothing here changes the desk. */
  .pocket-chrome{display:none}
  @media (max-width:900px), (max-height:600px){
    .back,.orb,.account{display:none}
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
