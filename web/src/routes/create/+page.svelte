<script>
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import "./create.css";
  import { mountCreate } from "./create.behaviour.js";
  import { mountConstellations } from "$lib/backdrops/constellations.js";
  import { readHome } from "$lib/data/workspace.js";
  import { rollSeed, seedFromWorkspace } from "$lib/sky.js";

  /**
   * New entry — the full form (CON-9: "create = genesis"). Reached from the
   * north-star drawer's "open the full form" link (CON-12), which offers type
   * chips and a drop target for the quick path; this screen is the considered
   * one.
   *
   * The form's own idea is progressive disclosure: it opens as a name, five
   * type chips and a drop target, and only unfolds the rest once you have
   * started. Nothing is assumed and nothing is asked twice.
   *
   * Built from design/v19/create-v3.html (#474/#475/#476) and owned here from
   * that point on. Three rulings: the backdrop carries this instance's own
   * households, the card grows from its centre, and dropping a document
   * splits the screen into the form and a reading lane (create.css has the
   * detail). The living backdrop is $lib/backdrops/constellations.js, ported
   * from the same sheet — this file only mounts it and tears it down, the
   * same shape as settings/mail/+page.svelte's relay.
   */
  let { data } = $props();

  /** @type {?HTMLDivElement} */
  let backdropRoot = null;

  onMount(() => {
    const formTeardown = mountCreate();
    let disposed = false;
    let backdropTeardown = () => {};
    /* The backdrop's households come through the same seam home's sky does
       (readHome → galaxyOf). The one seed follows home's own pattern: pinned
       to the workspace under fixtures, so the fidelity gate can compare one
       deterministic sky against the mockup's; rolled fresh otherwise. */
    readHome().then((view) => {
      if (disposed) return;
      const seed = data?.fixtures ? seedFromWorkspace(view.primary ?? "") : rollSeed();
      backdropTeardown = mountConstellations(
        /** @type {HTMLDivElement} */ (backdropRoot),
        { seed, galaxy: view.galaxy, primary: view.primary },
      );
    });
    return () => {
      disposed = true;
      formTeardown();
      backdropTeardown();
    };
  });
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <title>Orbit — new entry</title>
</svelte:head>

<div class="backdrop" bind:this={backdropRoot} aria-hidden="true"></div>

<!-- §14 (#471): clicking off the form returns to the landing page — the same
     light-dismiss the item view has. -->
<div class="stage" onclick={(event) => { if (event.target === event.currentTarget) goto(resolve("/home")); }}>
  <div class="lanes">

  <form class="glass card" id="card">
    <input id="f-name" class="name-title" value="New Entry" aria-label="name" autocomplete="off">
    <div class="sub">add something to your orbit</div>

    <div class="field">
      <label>type</label>
      <div class="types" id="types">
        <button type="button" data-type="service" aria-pressed="false">&#9679; service</button>
        <button type="button" data-type="renewal" aria-pressed="false">&#9673; renewal</button>
        <button type="button" data-type="inspection" aria-pressed="false">&#9681; inspection</button>
        <button type="button" data-type="suggestion" aria-pressed="false">&#9675; suggestion</button>
        <button type="button" data-type="document" aria-pressed="false">&#9670; document</button>
      </div>
    </div>

    <div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="drop a document, or press enter to choose one">
      <div class="dz-main">drop a document — we'll read what we can</div>
      <div class="dz-hint mono">PDF, email or photo &middot; dates, amounts &amp; reference numbers extracted automatically</div>
      <div class="dz-held" id="dz-held">&#9670; <b id="dz-held-name"></b> &middot; <span id="dz-held-size"></span> &middot; held in the lane on the right</div>
    </div>

    <div class="disclose" id="disclose">
      <div class="disclose-inner"><div class="disclose-content">

        <div class="docnote mono" id="docnote">suggestions come from the document — nothing is saved until you accept</div>

        <div class="row2">
          <div class="field" id="field-provider">
            <label>provider</label>
            <input id="f-provider" placeholder="e.g. Aviva">
            <div class="tag">&#9670; from document <button type="button" class="accept" data-accept="field-provider">&#10003; accept</button></div>
          </div>
          <div class="field mono" id="field-ref">
            <label>reference / policy no.</label>
            <input id="f-ref" placeholder="e.g. POL-004471">
            <div class="tag">&#9670; from document <button type="button" class="accept" data-accept="field-ref">&#10003; accept</button></div>
          </div>
        </div>

        <div class="daterow">
          <div class="field f-date" id="field-date">
            <label>key date</label>
            <input id="f-date" type="date">
            <div class="tag">&#9670; from document <button type="button" class="accept" data-accept="field-date">&#10003; accept</button></div>
          </div>
          <div class="field f-recur">
            <label>recurrence</label>
            <select id="f-recur">
              <option value="once">one-off</option>
              <option value="monthly">monthly</option>
              <option value="yearly" selected>yearly</option>
            </select>
          </div>
        </div>

        <div class="row2">
          <div class="field" id="field-cost">
            <label>cost</label>
            <div class="prefix-wrap"><span class="prefix">&pound;</span>
              <input id="f-cost" type="number" min="0" step="0.01" placeholder="0.00"></div>
            <div class="tag">&#9670; from document <button type="button" class="accept" data-accept="field-cost">&#10003; accept</button></div>
          </div>
          <div class="field">
            <label>reminder</label>
            <select id="f-reminder">
              <option value="7">1 week before</option>
              <option value="14" selected>2 weeks before</option>
              <option value="30">1 month before</option>
            </select>
          </div>
        </div>

        <div class="field">
          <label>assign to</label>
          <select id="f-assign">
            <option value="">household &middot; shared</option>
            <option>Tom</option>
            <option>Sarah</option>
            <option>Isla</option>
          </select>
        </div>

        <div class="field">
          <label>notes</label>
          <textarea id="f-notes" rows="2" placeholder="anything else worth keeping"></textarea>
        </div>

        <div class="save-row">
          <button type="submit" class="btn-primary">Add to orbit</button>
          <a href={resolve("/home")} class="cancel-link">cancel</a>
        </div>

      </div></div>
    </div>
  </form>

  <!-- ruling 3 (#474): the reading lane, hidden until a document splits the
       screen. The top sheet stays the sheet's own honest placeholder — a
       real page-one render needs a server side that does not exist yet
       (#476) — so it is unreachable here; only "Focusing on the anomaly"
       shows while a document is held. -->
  <aside class="glass readcard" id="readcard" aria-live="polite">
    <h3 id="read-head">Reading your document</h3>

    <div class="focus">
      <svg class="reticle" viewBox="0 0 96 96" aria-hidden="true">
        <circle cx="48" cy="48" r="43" fill="none" stroke="var(--chart-line)" stroke-width="1"
                stroke-dasharray="3 7" opacity=".8"/>
        <g class="sweep">
          <line x1="48" y1="5" x2="48" y2="14" stroke="var(--accent)" stroke-width="1.2" opacity=".8"/>
          <line x1="48" y1="82" x2="48" y2="91" stroke="var(--accent)" stroke-width="1.2" opacity=".35"/>
        </g>
        <g class="pull" fill="none" stroke="var(--accent)" stroke-width="1.1" opacity=".7">
          <path d="M 26 18 H 18 V 26"/><path d="M 70 18 H 78 V 26"/>
          <path d="M 26 78 H 18 V 70"/><path d="M 70 78 H 78 V 70"/>
        </g>
        <circle cx="48" cy="48" r="16" fill="none" stroke="var(--chart-line)" stroke-width="1" opacity=".9"/>
        <circle cx="48" cy="48" r="1.8" fill="var(--accent)"/>
      </svg>
      <div class="focusline">Focusing on the anomaly</div>
      <div class="why">
        orbit is reading the pages it was given<br>
        nothing is saved, and nothing is assumed
      </div>
    </div>

    <div class="topsheet">
      <div class="sheet">
        <!-- Page one, sketched: a real render is not built yet (#476), so this
             placeholder shows the SHAPE of the confirmation. Paper is paper in
             every theme, so this frame does not take theme ink. -->
        <svg viewBox="0 0 300 424" role="img"
             aria-label="Snapshot of page one: a British Gas HomeCare annual service plan renewal">
          <rect width="300" height="424" fill="#fdfcf9"/>
          <g>
            <circle cx="30" cy="30" r="9.5" fill="none" stroke="#1f3c86" stroke-width="1.6"/>
            <path d="M 30 24.5 c 3.6 3 3.6 6.4 0 9.6 c -3.6 -3.2 -3.6 -6.6 0 -9.6 z" fill="#1f3c86"/>
            <text x="46" y="27" font-family="Inter,system-ui,sans-serif" font-size="9"
                  font-weight="700" letter-spacing="1.1" fill="#1f3c86">BRITISH GAS</text>
            <text x="46" y="37" font-family="Inter,system-ui,sans-serif" font-size="6"
                  letter-spacing=".7" fill="#7a8090">HOMECARE &#183; ANNUAL SERVICE PLAN</text>
            <text x="270" y="27" text-anchor="end" font-family="Inter,system-ui,sans-serif"
                  font-size="6.4" fill="#7a8090">Issued 14 Aug 2026</text>
            <text x="270" y="37" text-anchor="end" font-family="ui-monospace,Menlo,monospace"
                  font-size="6.4" fill="#7a8090">Account 8021 4417</text>
          </g>
          <line x1="20" y1="50" x2="280" y2="50" stroke="#d8d3c6" stroke-width="1"/>
          <g fill="#dcd8cc">
            <rect x="20" y="62" width="86" height="4.6" rx="2.3"/>
            <rect x="20" y="72" width="66" height="4.6" rx="2.3"/>
            <rect x="20" y="82" width="74" height="4.6" rx="2.3"/>
            <rect x="20" y="92" width="48" height="4.6" rx="2.3"/>
          </g>
          <text x="20" y="126" font-family="Inter,system-ui,sans-serif" font-size="11"
                font-weight="600" fill="#20293d">Your annual boiler service is due</text>
          <g fill="#dcd8cc">
            <rect x="20" y="138" width="260" height="4.6" rx="2.3"/>
            <rect x="20" y="148" width="244" height="4.6" rx="2.3"/>
            <rect x="20" y="158" width="176" height="4.6" rx="2.3"/>
          </g>
          <rect x="20" y="178" width="260" height="86" rx="3" fill="#f3f1ea" stroke="#ddd8ca"/>
          <g font-family="Inter,system-ui,sans-serif" font-size="7.4" fill="#77808f">
            <text x="32" y="199">Policy number</text>
            <text x="32" y="225">Service due</text>
            <text x="32" y="251">Annual charge</text>
          </g>
          <g font-size="8.6" fill="#20293d">
            <text x="268" y="199" text-anchor="end" font-family="ui-monospace,Menlo,monospace">BG-88214-HC</text>
            <text x="268" y="225" text-anchor="end" font-family="Inter,system-ui,sans-serif" font-weight="600">02 November 2026</text>
            <text x="268" y="251" text-anchor="end" font-family="Inter,system-ui,sans-serif" font-weight="600">&#163;144.00</text>
          </g>
          <g fill="#c79a2f">
            <rect class="lit" x="196" y="203" width="72" height="1.6" rx=".8"/>
            <rect class="lit" x="182" y="229" width="86" height="1.6" rx=".8"/>
            <rect class="lit" x="228" y="255" width="40" height="1.6" rx=".8"/>
          </g>
          <line x1="20" y1="196" x2="280" y2="196" stroke="#e4e0d4" stroke-width=".8"/>
          <line x1="20" y1="222" x2="280" y2="222" stroke="#e4e0d4" stroke-width=".8"/>
          <line x1="20" y1="248" x2="280" y2="248" stroke="#e4e0d4" stroke-width=".8"/>
          <g fill="#dcd8cc">
            <rect x="20" y="282" width="260" height="4.6" rx="2.3"/>
            <rect x="20" y="292" width="252" height="4.6" rx="2.3"/>
            <rect x="20" y="302" width="238" height="4.6" rx="2.3"/>
            <rect x="20" y="312" width="196" height="4.6" rx="2.3"/>
            <rect x="20" y="330" width="150" height="4.6" rx="2.3"/>
            <rect x="20" y="340" width="164" height="4.6" rx="2.3"/>
          </g>
          <line x1="20" y1="384" x2="280" y2="384" stroke="#e4e0d4" stroke-width=".8"/>
          <text x="20" y="397" font-family="ui-monospace,Menlo,monospace" font-size="6"
                fill="#9aa0ad">Page 1 of 4</text>
          <text x="280" y="397" text-anchor="end" font-family="ui-monospace,Menlo,monospace"
                font-size="6" fill="#9aa0ad">homecare-renewal-2026.pdf</text>
          <path d="M 300 396 L 284 424 L 300 424 Z" fill="#e9e5d9"/>
        </svg>
      </div>
      <div class="cap"><b>Page one of the file you added</b><br>
        the three lit lines are what orbit read across into the form</div>
      <div class="honest">sketched placeholder &mdash; page-one snapshots need a server render that does not exist yet (#476)</div>
      <div class="attach">
        <span class="file">&#9670; homecare-renewal-2026.pdf</span>
        <span>812 KB &middot; <span class="clean">scanned clean</span></span>
        <button type="button">not this one</button></div>
    </div>
  </aside>

  </div>
</div>

<div class="vignette"></div>
