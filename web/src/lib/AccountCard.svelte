<script>
  import { resolve } from "$app/paths";
  import { DEFAULT_THEME } from "$lib/theme.js";
  import { SWATCHES } from "$lib/theme-swatches.js";

  /**
   * The account card (#1689): who is signed in, the journey nav, the five
   * theme swatches, "watch the tour", sign out and its problem line. Chrome
   * (every sub-screen) and home both render it, so there is one copy of the
   * markup and its styles. It is presentational: the orb, the `open` state,
   * the light dismiss and Escape stay with each host, which hands the state
   * in and takes the card's presses back (`onpick`, `onwatch`, `signOut`).
   *
   * It keeps `id="account"`, `role="region"`, the swatch `title`s and the
   * `.swatches`, `.watch` and `.signout` classes: the tour (chapter 11), home's
   * mounts and the rig specs select on them.
   * @typedef {{
   *   name?: string, roleLine?: string, roleId?: string, isAdmin?: boolean,
   *   current?: string, open?: boolean,
   *   onpick: (themeId: string) => void, onwatch: () => void,
   *   signOut: { press: () => void, signingOut: boolean, problem: string },
   * }} Props
   */
  /** @type {Props} */
  let { name = "", roleLine = "", roleId, isAdmin = false, current = "", open = false, onpick, onwatch, signOut } = $props();

  /* §14: due-next and documents retired -- the manifest is the corridor.
     #1319 (§34): the belt retired too, and with it the "Items" front door
     #1014 gave it; an item is managed in its drawer on home. */
  const NAV = [
    ["inbox", "Inbox"],
    ["settings", "Settings"],
    ["administration", "Administration"],
    /* #1256: last in every menu, for every member -- the credits reach
       everyone who uses what they credit. */
    ["about", "About"],
  ];

  /* The pressed swatch is the live theme, read when the card mounts and each
     time it opens, so a pick made anywhere (the tour's, the pocket's) shows. */
  let active = $state(DEFAULT_THEME);
  $effect(() => {
    void open;
    active = document.documentElement.dataset.theme || DEFAULT_THEME;
  });

  /** @param {string} id */
  function pick(id) {
    active = id;
    onpick(id);
  }
</script>

<div class="account" class:open id="account" role="region" aria-label="Account and menu">
  <div class="who"><b>{name}</b><span id={roleId}>{roleLine}</span></div>
  <nav>
    {#each NAV as [key, label] (key)}
      {#if key !== "administration" || isAdmin}
      <a href={key === "inbox" ? resolve("/inbox")
          : key === "settings" ? resolve("/settings")
          : key === "about" ? resolve("/about")
          : resolve("/administration")} aria-current={key === current ? "page" : undefined}>{label}</a>
      {/if}
    {/each}
  </nav>
  <!-- THE v1.3.0 ROSTER, FINAL (§15, owner): five packs, five swatches. The
       titles stay written out by the roster because the tour's selectors match
       on them (chapter 11); every colour is read from theme.js's table (#1331)
       through theme-swatches.js. Atlas, hanami, porcelain, miami and solarium
       are on the records shelf, offered nowhere. -->
  <div class="swatches" role="group" aria-label="Theme">
    <span>THEME</span>
    {#each SWATCHES as { id, title, colour, shadow } (id)}
      <button style="background:{colour}{shadow ? `;box-shadow:${shadow}` : ""}" {title}
              aria-pressed={active === id} onclick={() => pick(id)}></button>
    {/each}
  </div>
  <!-- Beside the theme, as on the phone (#1189). -->
  <button class="watch" onclick={onwatch}>↻ watch the tour</button>
  <!-- One press to leave, and it revokes the session before a single frame of
       the descent is drawn (§15). -->
  <button class="signout" onclick={signOut.press} disabled={signOut.signingOut}>sign out →</button>
  {#if signOut.problem}<div class="signout-problem">{signOut.problem}</div>{/if}
</div>

<style>
  /* :where() keeps the root at one class of specificity, as home's own rule
     was, so the light packs' `[data-theme] :is(.account, ...)` overrides in
     home.css still win over it whichever stylesheet loaded last. */
  :where(.account){position:fixed;top:70px;right:26px;z-index:6;width:240px;
           background:var(--panel-raised);backdrop-filter:blur(14px);
           border:1px solid var(--line);border-radius:16px;padding:18px 20px;
           opacity:0;transform:translateY(-6px);pointer-events:none;
           /* #847: closed, this must leave the tab order entirely -- opacity
              and pointer-events alone still let Tab land on the links and
              swatch buttons inside. visibility is delayed to match the close
              animation's own .25s so it still plays; opening clears the delay
              so the panel is reachable the instant it appears. */
           visibility:hidden;
           transition:opacity .25s,transform .25s,visibility 0s .25s}
  :where(.account).open{opacity:1;transform:none;pointer-events:auto;
                visibility:visible;transition-delay:0s}
  .account .who b{display:block;font-size:0.875rem;font-weight:560}
  .account .who span{font-size:0.75rem;color:var(--ink-mid)}
  .account nav{display:flex;flex-direction:column;gap:2px;margin:14px 0;
               padding:12px 0;border-top:1px solid var(--line-soft);
               border-bottom:1px solid var(--line-soft)}
  .account nav a{font-size:0.84375rem;color:var(--ink-mid);text-decoration:none;
                 padding:6px 8px;border-radius:8px}
  .account nav a:hover{color:var(--ink);background:var(--panel)}
  .account nav a[aria-current]{color:var(--accent-text)}
  .swatches{display:flex;gap:10px;align-items:center;margin-bottom:12px}
  .swatches span{font:0.65625rem var(--mono);color:var(--ink-quiet);margin-right:2px}
  .swatches button{width:18px;height:18px;border-radius:50%;cursor:pointer;
                   border:1px solid var(--line);padding:0}
  .swatches button[aria-pressed=true]{outline:2px solid var(--accent);outline-offset:2px}
  .watch{display:block;margin-bottom:12px;font:0.75rem var(--mono);color:var(--accent-text);
         background:none;border:0;cursor:pointer;padding:0}
  .watch:hover{text-decoration:underline}
  .signout{font:0.75rem var(--mono);color:var(--ink-quiet);background:none;border:0;cursor:pointer;padding:0}
  .signout:hover{color:var(--overdue-text)}
  .signout-problem{font:0.65625rem var(--mono);color:var(--overdue-text);margin-top:7px;line-height:1.7}
</style>
