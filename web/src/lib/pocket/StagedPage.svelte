<script>
  import { loadStagedPage } from "$lib/data/staged-page.js";
  import { plateOfName } from "$lib/data/belt.js";
  import Reader from "../../routes/item/[[id]]/Reader.svelte";

  /**
   * ONE DRAWING OF A WAITING PAGE (#1155): the phone's own copy of the
   * reading card's staged-paper states, for the inbox pocket sheet and the
   * review sheet's own unfold. `drawable` says whether pressing the paper
   * could ever show a page (a named PDF); `href` is only fetched when it is.
   *
   * `.bp-*` classes live in kit.css so the item page's own preview face can
   * share them rather than fork a second copy.
   *
   * @typedef {{
   *   href: string,
   *   name: string,
   *   drawable: boolean,
   *   reader?: boolean,
   *   itemTitle?: string,
   * }} Props
   */
  /** @type {Props} */
  let { href, name, drawable, reader = false, itemTitle = "" } = $props();

  /** @type {"honest" | "loading" | "page" | "gone" | "undrawable"} */
  let phase = $state("honest");
  let pageUrl = $state("");
  let readerOpen = $state(false);
  const plate = $derived(plateOfName(name));

  $effect(() => {
    // Referenced so the effect reruns when the href it names changes, even
    // though the honest branch below never fetches it.
    const target = href;
    if (!drawable || !target) { phase = "honest"; return; }
    phase = "loading";
    let current = "";
    const controller = new AbortController();
    loadStagedPage(target, controller.signal).then((result) => {
      if (result.kind === "page") { current = result.url; pageUrl = result.url; phase = "page"; }
      else phase = result.kind;
    }).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      phase = "undrawable";
    });
    return () => {
      controller.abort();
      if (current) URL.revokeObjectURL(current);
    };
  });
</script>

{#if phase === "page"}
  {#if reader}
    <button class="bp-page shown" aria-label="Read {name}" onclick={() => { readerOpen = true; }}>
      <span class="bp-under" aria-hidden="true"></span>
      <img src={pageUrl} alt="Page one of {name}" />
    </button>
  {:else}
    <div class="bp-page shown">
      <span class="bp-under" aria-hidden="true"></span>
      <img src={pageUrl} alt="Page one of {name}" />
    </div>
  {/if}
  <p class="bp-line quiet">not yet in orbit · attached on acceptance</p>
{:else if phase === "loading"}
  <div class="bp-page">
    <span class="bp-under" aria-hidden="true"></span>
  </div>
  <p class="bp-line quiet" aria-live="polite">Orbit is drawing the page</p>
{:else}
  <div class="bp-honest">
    <div class="bp-plate" aria-hidden="true">{plate}</div>
    {#if phase === "gone"}
      <p class="bp-line">This mail has gone.</p>
      <p class="bp-why">it burned up, or was decided from another screen</p>
    {:else if phase === "undrawable"}
      <p class="bp-line">Orbit could not draw a picture of this document.</p>
      <p class="bp-why">it scanned clean, and is still attached on acceptance</p>
    {:else}
      <p class="bp-line">Not yet in orbit.</p>
      <p class="bp-why">attached on acceptance</p>
    {/if}
  </div>
{/if}

{#if reader && phase === "page"}
  <Reader bind:open={readerOpen} doc={{ name }} itemTitle={itemTitle} onremove={async () => {}} staged
          previewSrc={pageUrl} />
{/if}
