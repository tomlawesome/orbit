<script>
  import "$lib/atmosphere.css";
  import Chrome from "$lib/Chrome.svelte";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import NorthStar from "$lib/pocket/NorthStar.svelte";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import Sky from "$lib/pocket/Sky.svelte";
  import { mountReorder } from "$lib/pocket/reorder.js";
  import { wake } from "$lib/pocket/wake.js";
  import { firstClause } from "$lib/pocket/words.js";

  /*
   * The kit (#1120): every pocket part at rest, on one fixtures-only page,
   * so the fidelity harness can drive them in a real browser and a reviewer
   * can see them together. Not a screen: no reader reaches it.
   */
  const user = { displayName: "Emma Lawson" };

  let callout = $state(false);
  let list = $state(false);
  let full = $state(false);

  let members = $state([
    { id: "rob", name: "Rob Lawson", role: "owner" },
    { id: "ada", name: "Ada Lawson", role: "member" },
    { id: "tom", name: "Tom Lawson", role: "member" },
  ]);
  /** @param {string} id */
  function removeMember(id) {
    const index = members.findIndex((m) => m.id === id);
    const [gone] = members.splice(index, 1);
    wake(`${gone.name} removed`, { undo: () => members.splice(index, 0, gone) });
  }

  let sections = $state(["Home", "Car", "Health", "Money"]);
  /**
   * @param {number} from
   * @param {number} to
   */
  function reorder(from, to) {
    const [moved] = sections.splice(from, 1);
    sections.splice(to, 0, moved);
  }
  /**
   * @param {number} index
   * @param {-1 | 1} direction
   */
  function move(index, direction) {
    const to = index + direction;
    if (to < 0 || to >= sections.length) return;
    reorder(index, to);
  }
</script>

<svelte:head><title>Orbit · pocket kit</title></svelte:head>

<Sky />
<Chrome {user} household={{ name: "Lawson Home", canManage: true }} current="" />


<main class="kit">
  <h1 class="p-title">Pocket kit</h1>

  <h2 class="p-caps">Type scale</h2>
  <section class="p-card" data-kit="type" style:--i="0">
    <p class="p-card-title">Card title, item name, 21px</p>
    <p class="t-sheet">Sheet title, 18px</p>
    <p class="t-body">Body, row title and inputs, 16px</p>
    <p class="t-meta">meta · T−16d · 29 Aug · 13px</p>
    <p class="p-caps flush">Caps label · 12px floor</p>
  </section>

  <h2 class="p-caps">Pills</h2>
  <section class="p-card p-pills" data-kit="pills" style:--i="1">
    <button class="p-pill filled">Add to orbit</button>
    <button class="p-pill">documents</button>
    <ArmButton label="remove" name="Remove the boiler service" onfire={() => wake("The boiler service removed")} />
    <ArmButton label="sign out →" armedLabel="tap again to sign out" wide onfire={() => wake("signed out (kit)")} />
  </section>

  <h2 class="p-caps">Rows · tap for acts</h2>
  <section class="p-card flushcard" data-kit="members" data-row-group style:--i="2">
    {#each members as m (m.id)}
      <Row title={m.name} meta={m.role} trail={m.role === "owner" ? "OWNER" : ""}
           acts={[
             { label: "hand over", name: `Hand over to ${m.name}`, tone: "accent", onact: () => wake(`Handed over to ${m.name}`) },
             { label: "remove", name: `Remove ${m.name}`, onact: () => removeMember(m.id), danger: true },
           ]}>
        {#snippet mark()}<span class="p-avatar" class:owner={m.role === "owner"}>{m.name.split(" ").map((w) => w[0]).join("")}</span>{/snippet}
      </Row>
    {/each}
  </section>

  <h2 class="p-caps">Rows · navigate, and acts that are the point</h2>
  <section class="p-card flushcard" data-kit="rows" style:--i="3">
    <Row title="Boiler service with a long name that ellipses" meta="Home · £84" trail="T−16d" trailSub="29 Aug"
         trailTone="var(--warm-text)" onactivate={() => (callout = true)}>
      {#snippet mark()}<span class="p-body soon"></span>{/snippet}
    </Row>
    <Row title="Car insurance" meta="Car · £412" trail="T−41d" trailSub="23 Oct" href="/kit#rows">
      {#snippet mark()}<span class="p-body ok"></span>{/snippet}
    </Row>
    <Row title="Energy bill, caught by your relay" meta="burns up in 12d · bill-sept.pdf">
      {#snippet mark()}<span class="p-body sug"></span>{/snippet}
      {#snippet below()}
        <button class="p-pill filled">Add to orbit</button>
        <button class="p-pill">Dismiss</button>
      {/snippet}
    </Row>
    <!-- Meta that is a sentence speaks the body face (metaFace="ui"), and at
         rest only its first clause (round 3 §1 R6, words.js). -->
    <Row title="A message from 09 Aug" metaFace="ui"
         meta={firstClause("Its attachment is a picture-only scan, and Orbit couldn’t read any text from it. You can add the item yourself and attach the file from Documents.")}>
      {#snippet mark()}<span class="p-body"></span>{/snippet}
    </Row>
  </section>

  <h2 class="p-caps">Rows · long-press to reorder</h2>
  <section class="p-card flushcard" data-kit="sections" data-row-group use:mountReorder={{ onreorder: reorder }} style:--i="4">
    {#each sections as name, index (name)}
      <Row title={name} meta="section" onmove={(direction) => move(index, direction)}
           acts={[
             ...(index > 0 ? [{ label: "move up", name: `Move ${name} up`, onact: () => move(index, -1) }] : []),
             ...(index < sections.length - 1 ? [{ label: "move down", name: `Move ${name} down`, onact: () => move(index, 1) }] : []),
           ]}>
        {#snippet mark()}<span class="p-aster" aria-hidden="true">✦</span>{/snippet}
      </Row>
    {/each}
  </section>

  <h2 class="p-caps">Pills · act colours</h2>
  <section class="p-card p-pills" data-kit="act-pills">
    <button class="p-pill act-ok">complete</button>
    <button class="p-pill act-up">reschedule</button>
    <button class="p-pill act-warm">snooze</button>
    <button class="p-pill act-accent">edit</button>
  </section>

  <h2 class="p-caps">Marks</h2>
  <section class="p-card marks" data-kit="marks">
    <span class="p-body over" title="overdue"></span>
    <span class="p-body soon" title="inspection"></span>
    <span class="p-body up con" title="renewal"></span>
    <span class="p-body ended exp" title="expiry"></span>
    <span class="p-body sug" title="suggested"></span>
    <span class="p-body ok breathing" title="breathing"></span>
    <span class="p-body failed" title="failed"></span>
    <span class="p-avatar">AL</span>
    <span class="p-avatar owner">RL</span>
    <span class="p-paper" aria-hidden="true">◆</span>
    <span class="p-aster" aria-hidden="true">✦</span>
  </section>

  <h2 class="p-caps">States</h2>
  <section class="p-card" data-kit="states">
    <div class="p-unlit"></div><div class="p-unlit"></div><div class="p-unlit"></div>
    <p class="p-empty">nothing in orbit yet · add an item</p>
    <button class="p-pill">try again</button>
    <p class="p-error">couldn't save — still here, try again</p>
  </section>
  <section class="p-card proposed" data-kit="empty">
    <p class="p-empty">nothing in this section yet</p>
    <button class="p-pill act-accent">add an item</button>
  </section>
  <section class="p-card danger" data-kit="danger">
    <h2 class="p-caps">Delete this household</h2>
    <p class="p-empty">every item and document goes, for everyone in it</p>
    <ArmButton label="delete household" name="Delete Lawson Home" onfire={() => wake("deleted (kit)")} />
  </section>

  <h2 class="p-caps">Sheets and the wake</h2>
  <section class="p-card p-pills" data-kit="sheets">
    <button class="p-pill" data-open="callout" onclick={() => (callout = true)}>callout</button>
    <button class="p-pill" data-open="list" onclick={() => (list = true)}>list</button>
    <button class="p-pill" data-open="full" onclick={() => (full = true)}>full</button>
    <button class="p-pill" data-wake onclick={() => wake("Boiler service completed", { undo: () => wake("Undone") })}>wake</button>
  </section>
  <div class="tail"></div>
</main>

<Sheet bind:open={callout} size="callout" title="Boiler service">
  <p class="t-meta">T−16d · 29 Aug · £84 · ◆ 2 documents</p>
  {#snippet foot()}
    <button class="p-pill filled">open →</button>
    <button class="p-pill">documents</button>
  {/snippet}
</Sheet>
<Sheet bind:open={list} size="list" title="Documents">
  {#each ["invoice-2025.pdf", "certificate.pdf", "manual.pdf", "photo-plate.jpg", "warranty.pdf", "quote-2026.pdf"] as doc (doc)}
    <Row title={doc} meta="scanned clean" trail="84 KB">{#snippet mark()}<span class="p-paper">◆</span>{/snippet}</Row>
  {/each}
</Sheet>
<Sheet bind:open={full} size="full" title="Edit item">
  <div class="kvs">
    <div class="p-kv">due <b class="soon">T−16d</b></div>
    <div class="p-kv">date <b>29 Aug</b></div>
    <div class="p-kv">cost <b>£84</b></div>
  </div>
  <label class="field">Name<input value="Boiler service" enterkeyhint="done"></label>
  <label class="field">Cost<input value="84.00" inputmode="decimal" enterkeyhint="done"></label>
  {#snippet foot()}<button class="p-pill filled">Save</button>{/snippet}
</Sheet>

<NorthStar />

<style>
  .kit{position:relative;z-index:2;max-width:var(--p-column);margin:0 auto;
    padding:calc(var(--p-chrome) + env(safe-area-inset-top) + 8px) var(--p-gutter) 40px;color:var(--ink)}
  :global(body){background:var(--bg);margin:0;font-family:var(--ui)}
  .t-sheet{font:600 var(--p-type-sheet)/1.3 var(--ui);margin:0 0 8px}
  .t-body{font:var(--p-type-body)/1.4 var(--ui);margin:0 0 8px}
  .t-meta{font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet);margin:0 0 8px}
  .flush{margin:0}
  .flushcard{padding:4px 0;overflow:hidden;display:flex;flex-direction:column}
  .marks{display:flex;flex-wrap:wrap;align-items:center;gap:18px}
  .kvs{margin-bottom:16px}
  .field{display:flex;flex-direction:column;gap:6px;font:var(--p-type-meta) var(--mono);color:var(--ink-quiet);margin-bottom:16px}
  .field input{font:var(--p-type-body) var(--ui);min-height:var(--p-hit);padding:0 12px;border-radius:10px;
    border:1px solid var(--line);background:var(--panel);color:var(--ink)}
  .tail{height:60vh}
</style>
