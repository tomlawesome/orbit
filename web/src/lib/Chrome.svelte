<script>
  /**
   * The sub-screens' shared chrome (#461): the "← YOUR SKY" way back, the
   * account orb, and the account card with the journey nav and the five pack
   * swatches. Markup and styles are the #452 mockups' own, verbatim; home
   * keeps its inline copy for now because its card also closes sibling
   * overlays the sub-screens don't have.
   */
  let { user = null, role = "", current = "" } = $props();

  const NAV = [
    ["due-next", "Due next", "/due-next"],
    ["documents", "Documents", "/documents"],
    ["inbox", "Inbox", "/inbox"],
    ["settings", "Settings", "/settings"],
    ["administration", "Administration", "/administration"],
  ];
  const PACKS = [
    ["starchart", "star-chart", "#060b1c", ""],
    ["afterdark", "after dark", "#05070d", ""],
    ["atlas", "atlas", "#c9bfa6", ""],
    ["dawn", "dawn", "#c3ccdb", ""],
    ["retrograde", "retrograde", "#080a14", "inset 0 0 0 1px #ff4fd8"],
  ];

  let open = $state(false);
  let active = $state("starchart");

  $effect(() => {
    active = document.documentElement.dataset.theme || "starchart";
    const close = (event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".account,.orb")) open = false;
    };
    addEventListener("click", close);
    return () => removeEventListener("click", close);
  });

  function setSwatch(name) {
    active = name;
    document.documentElement.dataset.theme = name;
    /* Survive a refresh — the same pre-paint cache home writes. */
    try { localStorage.setItem("orbit-theme", name); } catch {}
  }

  const initials = $derived(
    (user?.displayName ?? "")
      .split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "·",
  );
</script>

<a class="back" href="/home">← YOUR SKY</a>
<button class="orb" aria-expanded={open} aria-controls="account" title="Menu"
        onclick={() => (open = !open)}>{initials}</button>
<div class="account" class:open id="account" role="region" aria-label="Account and menu">
  <div class="who"><b>{user?.displayName ?? ""}</b><span>{role}</span></div>
  <nav>
    {#each NAV as [key, label, href] (key)}
      <a {href} aria-current={key === current ? "page" : undefined}>{label}</a>
    {/each}
  </nav>
  <div class="swatches" role="group" aria-label="Theme">
    <span>THEME</span>
    {#each PACKS as [name, title, swatch, shadow] (name)}
      <button style="background:{swatch}{shadow ? `;box-shadow:${shadow}` : ""}" {title}
              aria-pressed={active === name} onclick={() => setSwatch(name)}></button>
    {/each}
  </div>
  <button class="signout" onclick={() => (location.href = "/logout")}>sign out →</button>
</div>

<style>
  .back{position:fixed;top:30px;left:26px;z-index:6;font:11px var(--mono);
        letter-spacing:.14em;color:var(--ink-faint);text-decoration:none}
  .back:hover{color:var(--accent)}
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
  .account nav a[aria-current]{color:var(--accent)}
  .swatches{display:flex;gap:10px;align-items:center;margin-bottom:12px}
  .swatches span{font:10.5px var(--mono);color:var(--ink-faint);margin-right:2px}
  .swatches button{width:18px;height:18px;border-radius:50%;cursor:pointer;
                   border:1px solid var(--line);padding:0}
  .swatches button[aria-pressed=true]{outline:2px solid var(--accent);outline-offset:2px}
  .signout{font:12px var(--mono);color:var(--ink-faint);background:none;border:0;cursor:pointer;padding:0}
  .signout:hover{color:var(--overdue)}
</style>
