<script>
  /**
   * #1437: the entry that already holds a file, as a 44px row the phone opens
   * it from (design/v19/duplicate-alert/round-1, ReviewCard's `.rv-paper`
   * grammar): the paper mark, the file's name and "on <entry>" on two lines
   * so the entry's name is never cut, and the chevron. Used by the Add
   * form's reading card and the review card alike.
   *
   * @typedef {{ held: import('$lib/data/workspace.js').AlreadyHeld & { entry: { itemId: string, title: string } }, disabled?: boolean, onopen: () => void }} Props
   */
  /** @type {Props} */
  let { held, disabled = false, onopen } = $props();
</script>

<button type="button" class="dup-row" {disabled} aria-label="open {held.displayName} on {held.entry.title}" onclick={onopen}>
  <span class="p-paper" aria-hidden="true">◆</span><span class="nm"><b>{held.displayName}</b><span>on {held.entry.title}</span></span><span class="chev" aria-hidden="true">›</span>
</button>

<style>
  .dup-row{display:flex;align-items:center;gap:8px;width:100%;min-height:var(--p-hit);margin:12px 0 0;padding:0 12px;box-sizing:border-box;
    border:1px solid var(--line-soft);border-radius:12px;background:none;color:var(--ink);text-align:left;cursor:pointer;font:var(--p-type-meta) var(--ui)}
  .dup-row:disabled{cursor:default;opacity:.55}
  .dup-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .dup-row .p-paper{flex:none}
  .nm{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px;padding:8px 0;line-height:1.3}
  .nm b{font-weight:500;overflow-wrap:anywhere}
  .nm span{color:var(--ink-quiet);font-family:var(--mono);font-size:var(--p-type-caps);overflow-wrap:anywhere}
  .chev{color:var(--ink-quiet);font-size:1.1rem;line-height:1}
</style>
