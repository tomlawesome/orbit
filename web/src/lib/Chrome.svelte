<script>
  import { resolve } from "$app/paths";
  import { signOut } from "$lib/data/workspace.js";

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
     the belt is the document surface. */
  const NAV = [
    ["inbox", "Inbox", "/inbox"],
    ["settings", "Settings", "/settings"],
    ["administration", "Administration", "/administration"],
  ];
  /*
   * THE v1.3.0 ROSTER, FINAL (§15, owner: "the release theme list is star
   * chart, after dark, CLOUDS, dawn terminator, and retrograde"). Five packs,
   * five swatches. Atlas, hanami, porcelain, miami and solarium are on the
   * records shelf — their code stays and a stored preference still renders,
   * but they are offered nowhere a reader can choose, and this row is one of
   * those places (the precedent is atlas leaving at #480/f9261c6).
   *
   * The dot is the pack's most telling colour rather than strictly its --bg:
   * clouds shows the cool white of a cloud crest, which is the lighter end of
   * the range it was admitted to carry, and dawn shows the temperature story's
   * own ground now that the terminator has moved it off #c3ccdb.
   */
  const PACKS = [
    ["starchart", "star-chart", "#060b1c", ""],
    ["afterdark", "after dark", "#05070d", ""],
    ["clouds", "clouds", "#eef2f9", ""],
    ["dawn", "dawn", "#d2d3d4", ""],
    ["retrograde", "retrograde", "#080a14", "inset 0 0 0 1px #ff4fd8"],
  ];

  let open = $state(false);
  let active = $state("starchart");

  $effect(() => {
    active = document.documentElement.dataset.theme || "afterdark";
    const close = (/** @type {Event} */ event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".account,.orb")) open = false;
    };
    addEventListener("click", close);
    return () => removeEventListener("click", close);
  });

  /** @param {string} name */
  function setSwatch(name) {
    active = name;
    document.documentElement.dataset.theme = name;
    /* Survive a refresh — the same pre-paint cache home writes. */
    try { localStorage.setItem("orbit-theme", name); } catch {}
  }

  /*
   * Signing out from a sub-screen (#410, §15).
   *
   * Two taps, and the second one REVOKES before it navigates: this control
   * used to walk to /logout without ending anything, which meant the goodbye
   * screen was a picture of a sign-out rather than a sign-out. The session is
   * gone before the reader leaves this page.
   *
   * The ratified DESCENT — instrument withdrawing, bodies dispersing, the
   * bloom read backwards — belongs to home, because home is the surface that
   * has an instrument and bodies to take away. From a sub-screen there is
   * nothing to withdraw, so the reader is handed to the dusk directly.
   * Carrying the full flight onto every sub-screen is a follow-up, not a
   * silent invention.
   */
  let armedOut = $state(false);
  /** @type {string | null} */
  let signOutProblem = $state(null);
  async function tapSignOut() {
    if (!armedOut) { armedOut = true; return; }
    signOutProblem = null;
    try {
      await signOut();
    } catch (error) {
      armedOut = false;
      signOutProblem = /** @type {{ message?: string }} */ (error)?.message ?? "still signed in — try again";
      return;
    }
    location.href = "/logout";
  }

  const initials = $derived(
    (user?.displayName ?? "")
      .split(/\s+/).map((/** @type {string} */ part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "·",
  );
</script>

<!-- `back` only ever holds "/settings" or the "/home" default (the two
     doors in ./household/[id]/door.js) -- resolve() needs a literal to
     type-check, so it is picked with a plain comparison rather than passed
     straight through as an opaque string. -->
<a class="back" href={back === "/settings" ? resolve("/settings") : resolve("/home")}>{backLabel}</a>
<button class="orb" aria-expanded={open} aria-controls="account" title="Menu"
        onclick={() => (open = !open)}>{initials}</button>
<div class="account" class:open id="account" role="region" aria-label="Account and menu">
  <div class="who"><b>{user?.displayName ?? ""}</b><span>{role}</span></div>
  <nav>
    {#each NAV as [key, label, href] (key)}
      <a href={href === "/inbox" ? resolve("/inbox")
          : href === "/settings" ? resolve("/settings")
          : resolve("/administration")} aria-current={key === current ? "page" : undefined}>{label}</a>
    {/each}
  </nav>
  <div class="swatches" role="group" aria-label="Theme">
    <span>THEME</span>
    {#each PACKS as [name, title, swatch, shadow] (name)}
      <button style="background:{swatch}{shadow ? `;box-shadow:${shadow}` : ""}" {title}
              aria-pressed={active === name} onclick={() => setSwatch(name)}></button>
    {/each}
  </div>
  <button class="signout" onclick={tapSignOut}>{armedOut ? "tap again to sign out" : "sign out →"}</button>
  {#if signOutProblem}<div class="signout-problem">{signOutProblem}</div>{/if}
</div>

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
           transition:opacity .25s,transform .25s}
  .account.open{opacity:1;transform:none;pointer-events:auto}
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
  .swatches span{font:10.5px var(--mono);color:var(--ink-faint);margin-right:2px}
  .swatches button{width:18px;height:18px;border-radius:50%;cursor:pointer;
                   border:1px solid var(--line);padding:0}
  .swatches button[aria-pressed=true]{outline:2px solid var(--accent);outline-offset:2px}
  .signout{font:12px var(--mono);color:var(--ink-faint);background:none;border:0;cursor:pointer;padding:0}
  .signout:hover{color:var(--overdue-text)}
  .signout-problem{font:10.5px var(--mono);color:var(--overdue-text);margin-top:7px;line-height:1.7}
</style>
