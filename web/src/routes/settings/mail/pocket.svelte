<script>
  import { onMount } from "svelte";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import Sky from "$lib/pocket/Sky.svelte";
  import { wake } from "$lib/pocket/wake.js";
  import { rotateRelay } from "$lib/data/workspace.js";

  /*
   * YOUR RELAY ON A PHONE (#1125, proposal §2.9). Beside the desk's card and
   * chosen by CSS. The desk's satellites carry labels the screen's edge would
   * cut, so the phone keeps only the relay's own art: the dish, large and
   * dimmed behind the head, breathing while the address listens and still
   * while ingest is paused.
   *
   * The address is the thing to take away, so it is a full-width pill that
   * copies on a tap (and shares, where the platform can). Values that run
   * long (a file name) sit under their label rather than beside it, so
   * nothing wraps mid-word. `rotate address` arms: the old address keeps
   * collecting for fourteen days, but anyone holding it should not.
   *
   * `rotated` is the desk page's own, bound, so a rotation shows in both.
   */

  /** @typedef {Awaited<ReturnType<typeof rotateRelay>>} Relay */
  /** @type {{ relay: Relay, rotated: Relay | null, failures: { id: string, receivedAt: string, message: string }[], fixtures: boolean }} */
  let { relay, rotated = $bindable(), failures, fixtures } = $props();

  /* The gate's other two states, `?relay=never|paused`, fixtures only. */
  let scene = $state("");
  const shown = $derived.by(() => {
    const base = rotated ?? relay;
    if (scene === "never") return { ...base, lastReceived: "nothing yet" };
    if (scene === "paused") return { ...base, ingest: "paused" };
    return base;
  });
  const paused = $derived(shown.ingest === "paused");
  const never = $derived(shown.lastReceived === "nothing yet");
  const listening = $derived(!paused && /listen|connect/i.test(shown.status));

  /** @type {"rotate" | "pause" | "resume" | null} */
  let working = $state(null);
  /** @type {string | null} */
  let problem = $state(null);
  let canShare = $state(false);

  /** @param {"rotate" | "pause" | "resume"} action */
  async function act(action) {
    if (working) return;
    working = action;
    problem = null;
    try {
      rotated = await rotateRelay(action);
      scene = "";
      wake(action === "rotate" ? "new address · the old one collects for 14 more days"
        : action === "pause" ? "ingest paused · mail is held until you resume" : "ingest resumed");
    } catch {
      problem = action === "rotate"
        ? "not rotated — your address is unchanged. try again"
        : `not ${action === "pause" ? "paused" : "resumed"} — Orbit could not reach your relay`;
    } finally {
      working = null;
    }
  }

  const usable = $derived(shown.address !== "no address yet");
  async function copy() {
    if (!usable) return;
    try {
      await navigator.clipboard.writeText(shown.address);
      wake("copied · your relay address");
    } catch {
      wake("not copied — your browser kept the clipboard closed", { failure: true });
    }
  }
  async function share() {
    try { await navigator.share({ title: "My Orbit relay address", text: shown.address }); } catch { /* dismissed */ }
  }

  /** @param {string} iso */
  const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });

  onMount(() => {
    canShare = typeof navigator.share === "function";
    if (fixtures) scene = new URLSearchParams(location.search).get("relay") ?? "";
  });
</script>

<div class="rl-pocket" class:paused>
  <Sky />
  <div class="rl-art" aria-hidden="true">
    <svg viewBox="0 0 400 400" preserveAspectRatio="xMidYMid meet">
      <g class="rl-waves" fill="none">
        <circle cx="200" cy="200" r="60"/><circle cx="200" cy="200" r="60"/><circle cx="200" cy="200" r="60"/>
      </g>
      <circle class="rl-orbit" cx="200" cy="200" r="150" fill="none"/>
      <circle class="rl-orbit" cx="200" cy="200" r="104" fill="none"/>
      <g class="rl-craft"><circle cx="350" cy="200" r="4"/></g>
      <path class="rl-bowl" d="M160 214a44 44 0 0 0 80 0z"/>
      <path class="rl-mast" d="M200 214v-38"/>
      <circle class="rl-core" cx="200" cy="172" r="7"/>
    </svg>
  </div>

  <main class="rl-column">
    <header class="rl-head rl-rise" style:--i="0">
      <h1 class="p-card-title rl-title">Your relay</h1>
      <p class="p-prose rl-sentence">Forward a document to your private address and it arrives in your review queue.</p>
    </header>

    <section class="p-card rl-rise" style:--i="1" aria-label="Your address">
      <button class="rl-address" disabled={!usable} onclick={copy} aria-label="Copy your relay address, {shown.address}">
        <span class="rl-addr">{shown.address}</span>
        <span class="rl-copy" aria-hidden="true">{usable ? "tap to copy" : ""}</span>
      </button>
      {#if canShare && usable}
        <button class="p-pill act-accent wide rl-share" onclick={share}>share</button>
      {/if}

      <div class="rl-fields">
        <div class="rl-field">
          <span class="rl-label">status</span>
          <b class:ok={listening} class:warm={paused}>{paused ? "paused · not collecting" : shown.status}</b>
        </div>
        <div class="rl-field">
          <span class="rl-label">last received</span>
          {#if never}
            <span class="rl-value quiet p-prose">nothing yet — forward a document to try it</span>
          {:else}
            <span class="rl-value">{shown.lastReceived}</span>
          {/if}
        </div>
        <div class="rl-field">
          <span class="rl-label">ingest</span>
          <b class:ok={!paused} class:warm={paused}>{shown.ingest}</b>
        </div>
      </div>

      <div class="rl-acts">
        <ArmButton label={working === "rotate" ? "rotating…" : "rotate address"} armedLabel="tap again" name="Rotate your relay address"
                   danger={false} class="act-warm" onfire={() => act("rotate")} />
        <button class="p-pill {paused ? 'act-ok' : ''}" disabled={working !== null}
                onclick={() => act(paused ? "resume" : "pause")}>
          {working === "pause" ? "pausing…" : working === "resume" ? "resuming…" : paused ? "resume" : "pause ingest"}</button>
      </div>
      {#if problem}<p class="p-error" role="alert">{problem}</p>{/if}
    </section>

    {#if failures.length}
      <!-- #434: arrived-but-unreadable mail, in the server's own bounded words. -->
      <section class="p-card rl-rise" style:--i="2" aria-labelledby="rl-failed">
        <h2 class="p-caps" id="rl-failed">Arrived, but could not be read</h2>
        {#each failures as failure (failure.id)}
          <div class="rl-failure">
            <span class="rl-date">{day(failure.receivedAt)}</span>
            <p class="p-prose">{failure.message}</p>
          </div>
        {/each}
      </section>
    {/if}

    <footer class="rl-notes rl-rise p-prose" style:--i="3">
      <p>Every person gets their own relay. Nothing is created without your review.</p>
      <p>Outbound reminder email is set by your administrator.</p>
    </footer>
  </main>
</div>

<style>
  /* THE DIALECT SWITCH: the same query as $lib/pocket/media.js. The desk's
     satellites, card and vignette go; its chrome stays. */
  .rl-pocket{display:none}
  @media (max-width:900px), (max-height:600px){
    .rl-pocket{display:block;position:relative;min-height:100dvh}
    /* Doubled to outrank relay.css's `.relay-page .satellites ~ .stage`. */
    :global(.relay-page.relay-page > div:is(.satellites, .stage, .vignette)){display:none}
  }

  /* THE DISH (§1.10, §5.2): whole at 390, dimmed one step, fixed, transform
     only. Rings go out from it while it listens; paused, they stop. */
  .rl-art{position:fixed;left:50%;top:calc(env(safe-area-inset-top) - 40px);width:420px;height:420px;
    transform:translateX(-50%);z-index:1;pointer-events:none;opacity:.6}
  .rl-art svg{width:100%;height:100%;overflow:visible}
  .rl-waves circle{stroke:var(--ok);stroke-width:1.2;transform-origin:200px 172px;opacity:0;
    animation:rl-wave 3.6s ease-out infinite}
  .rl-waves circle:nth-child(2){animation-delay:1.2s}
  .rl-waves circle:nth-child(3){animation-delay:2.4s}
  @keyframes rl-wave{0%{transform:scale(.15);opacity:.7}100%{transform:scale(2.4);opacity:0}}
  .rl-orbit{stroke:var(--chart-line, var(--line));stroke-width:1;stroke-dasharray:2 6}
  .rl-craft{transform-origin:200px 200px;animation:rl-orbit 90s linear infinite;fill:var(--accent)}
  @keyframes rl-orbit{to{transform:rotate(360deg)}}
  .rl-bowl{fill:color-mix(in srgb, var(--ink-mid) 30%, transparent);stroke:var(--ink-mid);stroke-width:1.2}
  .rl-mast{stroke:var(--ink-mid);stroke-width:1.2}
  .rl-core{fill:var(--ok);animation:p-breathe 2.4s ease-in-out infinite}
  .paused .rl-waves circle,.paused .rl-core,.paused .rl-craft{animation:none}
  .paused .rl-core{fill:var(--warm)}
  :global(:is([data-theme=dawn],[data-theme=clouds])) .rl-art{opacity:.45}
  :global([data-theme=retrograde]) .rl-core{filter:drop-shadow(0 0 2.5px var(--bloom))}

  .rl-column{position:relative;z-index:2;box-sizing:border-box;max-width:var(--p-column);margin:0 auto;
    padding:calc(var(--p-chrome) + env(safe-area-inset-top) + 200px) var(--p-gutter)
      calc(96px + env(safe-area-inset-bottom))}
  .rl-head{text-align:center;margin:0 0 16px}
  .rl-title{margin:0 0 6px}
  .rl-sentence{margin:0 auto;max-width:30ch;color:var(--ink-mid)}

  .rl-rise{animation:rl-rise 420ms var(--p-ease) both;animation-delay:calc(var(--i, 0) * 70ms + 60ms)}
  @keyframes rl-rise{from{opacity:0;transform:translateY(10px)}}

  /* The address: the desk's dashed alias, full width, 14px mono. */
  .rl-address{appearance:none;box-sizing:border-box;width:100%;min-height:64px;padding:10px 16px;margin:0 0 8px;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;cursor:pointer;
    border:1.5px dashed color-mix(in srgb, var(--accent) 60%, var(--line));border-radius:18px;
    background:color-mix(in srgb, var(--accent) 7%, var(--panel));-webkit-tap-highlight-color:transparent;
    transition:background-color 120ms,border-color 120ms}
  .rl-address:active{background:color-mix(in srgb, var(--accent) 16%, var(--panel));border-style:solid}
  .rl-address:disabled{cursor:default;border-color:var(--line)}
  .rl-address:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .rl-addr{font:.875rem/1.35 var(--mono);color:var(--accent-text);overflow-wrap:anywhere;text-align:center}
  .rl-address:disabled .rl-addr{color:var(--ink-quiet)}
  .rl-copy{font:var(--p-type-caps)/1 var(--mono);letter-spacing:var(--p-type-caps-track);text-transform:uppercase;
    color:var(--ink-quiet)}
  .rl-copy:empty{display:none}
  .rl-share{margin:0 0 8px}

  /* Label above value (§2.9): nothing wraps mid-word. */
  .rl-fields{margin:4px 0 0}
  .rl-field{display:flex;flex-direction:column;gap:3px;padding:10px 2px;border-bottom:1px solid var(--line-soft)}
  .rl-label{font:var(--p-type-caps)/1.4 var(--mono);letter-spacing:var(--p-type-caps-track);text-transform:uppercase;
    color:var(--ink-quiet)}
  .rl-field b,.rl-value{font:500 var(--p-type-meta)/1.45 var(--mono);color:var(--ink);overflow-wrap:anywhere}
  .rl-value.quiet{font-family:var(--ui);font-weight:400;color:var(--ink-mid)}
  .rl-field b.ok{color:var(--ok-text)}
  .rl-field b.warm{color:var(--warm-text)}

  .rl-acts{display:flex;flex-wrap:wrap;gap:var(--p-pill-gap);margin:16px 0 0}
  .rl-acts > :global(*){flex:1 1 40%;white-space:nowrap}

  .rl-failure{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--line-soft)}
  .rl-failure:first-of-type{border-top:0;padding-top:0}
  .rl-date{flex:none;width:52px;font:500 var(--p-type-meta)/1.5 var(--mono);color:var(--ink-mid)}
  .rl-failure p{margin:0;color:var(--overdue-text)}

  .rl-notes{color:var(--ink-quiet);text-align:center;padding:4px 8px 0}
  .rl-notes p{margin:0 0 4px}

  @media (prefers-reduced-motion:reduce){
    .rl-rise,.rl-waves circle,.rl-craft,.rl-core{animation:none}
  }
</style>
