<script>
  /*
   * THE INLINE CHALLENGE (#915, ADR-0023 §5; composition §2.7).
   *
   * The field that opens under an armed sign-in-method action, and the two
   * buttons that finish or abandon it. One shape, whichever action opened it:
   * what a reader proves themselves with never changes between them, so
   * drawing it once is what keeps them consistent.
   *
   * A COMPONENT RATHER THAN A `{#snippet}` (#624/#782), the same reason
   * due-next/EntryRow.svelte and home/CorridorRow.svelte are components: the
   * identical markup inline in +page.svelte's template refused to build.
   * `vite dev` and `svelte-check` both accept it; the production rolldown
   * build crashes on it with an opaque "Unexpected token" pointing at an
   * unrelated line — bisected here to a `<form>` with an event handler inside
   * a snippet body. A component's `$props()` destructuring is a plain script
   * statement, so it is out of the trap's reach and takes a real prop type
   * besides.
   *
   * WHICH CHALLENGE IS ASKED FOR is the caller's answer, not this file's:
   * `hasPassword` is what ADR-0023 §5 branches on, and a reader without one
   * has already been re-authenticated at their provider by the time this is
   * drawn — so there is nothing left here to ask them for.
   */

  /**
   * @type {{
   *   hasPassword: boolean,
   *   wantsNewPassword?: boolean,
   *   confirmLabel: string,
   *   busy?: boolean,
   *   problem?: string | null,
   *   currentPassword: string,
   *   newPassword: string,
   *   onconfirm: () => void,
   *   oncancel: () => void,
   * }}
   */
  let {
    hasPassword,
    wantsNewPassword = false,
    confirmLabel,
    busy = false,
    problem = null,
    currentPassword = $bindable(""),
    newPassword = $bindable(""),
    onconfirm,
    oncancel,
  } = $props();

  /** @param {SubmitEvent} event */
  function submit(event) {
    event.preventDefault();
    onconfirm();
  }
</script>

<form class="challenge" onsubmit={submit}>
  {#if hasPassword}
    <label>current password
      <input type="password" autocomplete="current-password" bind:value={currentPassword} required /></label>
  {:else}
    <p class="challengenote">Your identity provider has just confirmed it is you.</p>
  {/if}
  {#if wantsNewPassword}
    <label>new password
      <input type="password" autocomplete="new-password" bind:value={newPassword} required /></label>
  {/if}
  <div class="challengerow">
    <button type="submit" disabled={busy}>{confirmLabel}</button>
    <button type="button" onclick={oncancel}>cancel</button>
  </div>
  {#if problem}<div class="note">{problem}</div>{/if}
</form>
