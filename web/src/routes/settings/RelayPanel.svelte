<script>
  import { resolve } from "$app/paths";
  import { onMount, tick } from "svelte";
  import { dayMonth, plural } from "$lib/format.js";
  import { createArm } from "$lib/arm.js";
  import { ADMIN_PAUSED_WORDS, copyRelayAddress, relayAddressLabel } from "$lib/relay-address.js";
  import { ROTATE_UNCHANGED, ROTATE_UNKNOWN, addSender, readRelay, removeSender, rotateRelay, rotateRelayReconciled, sendSenderCheck } from "$lib/data/workspace.js";
  import { failureWords } from "$lib/pocket/words.js";
  import {
    checkRow, LINK_CHECKED, LINK_FAILED, alreadyCheckedWords, refusalWords, SENDING, sentWords,
    withLearnt, ADD, ADD_PLACEHOLDER, AT_LIMIT, atLimit, extraRow, extrasOf, NOT_ADDED, NOT_REMOVED, REMOVE, REMOVE_ARMED, SEND_CHECK,
    removeArmedWords, withCheckSent,
  } from "./mail/sender.js";
  import {
    ARMED_WORDS, NO_MAILBOX_ADMIN, NO_MAILBOX_LINK, NO_MAILBOX_MEMBER, NOTHING_YET, READY_WORDS, RELAY_NOT_READ, relayShape,
  } from "./relay-shape.js";

  /**
   * YOUR RELAY ON THE DESK (#1509, direction N): the `your relay` tab of the
   * Mail card, ported from design/v19/relay-settings/round-2/n-relay-tab.html.
   * Two halves, `Your relay` left and `Sending addresses` right; with no
   * household mailbox, the address slot and one line, nothing else.
   *
   * Every piece is the relay's old page's, moved here whole: the
   * dashed address that copies (#1658), the `.kv` rows, `rotate address`
   * with its armed second press (lib/arm.js, #1151 S7) and `pause ingest`
   * beside it (#744, #746), the sender check (#1410) and the extra sending
   * addresses with the add box (#1650), the `.said` answer line, and mail
   * that arrived but could not be read (#434). Only what applies is drawn
   * (relay-shape.js). The closing note is gone (owner, note 56144).
   *
   * Nothing here can name another member: every write acts on the session's
   * own member, and names a sending row by its id, never by address.
   *
   * `shared` is the Settings page's, handed to the phone's layout as well, so
   * a rotation, an added address or a check sent shows in both.
   */
  /** @typedef {Awaited<ReturnType<typeof readRelay>>} Relay */
  /**
   * @type {{
   *   relay: Relay,
   *   shared: { rotated: Relay | null, sentExpires: string | null, checked: boolean, working: boolean },
   *   failures: import('$lib/data/workspace.js').MailFailure[],
   *   waiting: number,
   *   admin: boolean,
   *   live: boolean,
   *   landing: "verified" | "unverified" | null,
   *   onlanded?: () => void,
   * }}
   */
  let { relay: loaded, shared, failures, waiting, admin, live, landing, onlanded = () => {} } = $props();

  const relay = $derived(shared.rotated ?? loaded);
  const shape = $derived(relayShape(relay));
  /* A rotate, pause or resume in flight is the page's, not this panel's: the
     panel is drawn only while its tab is chosen, and a switch away and back
     must still find the buttons held until the answer lands. */
  const working = $derived(shared.working);
  /* Rotating is destructive (the old address stops collecting new mail), so
     it arms first; "pause ingest" beside it is reversible and stays a single tap. */
  let armedRotate = $state(false);
  const rotateArm = createArm({ onchange: (next) => (armedRotate = Boolean(next)) });
  /* #1810 W-S1/S2: removing a sending address loses it (and any mail held for
     it) for good, so it arms too. One arm for the list, keyed by row id. */
  let armedRemove = $state(/** @type {string | null} */ (null));
  const removeArm = createArm({ onchange: (next) => (armedRemove = typeof next === "string" ? next : null) });
  $effect(() => () => removeArm.disarm());
  /* #1810 W-R1: the relay read failed; the tab's own `try again` re-reads it. */
  let retrying = $state(false);
  /** @type {?HTMLElement} */
  let notReadLine = $state(null);
  /** @type {?HTMLElement} */
  let statusLine = $state(null);
  /** @type {string | null} */
  let problem = $state(null);
  /* Good news, in the status line (the sender check's 202, an address
     already checked, the link that worked). */
  let said = $state("");
  /** @type {?HTMLElement} */
  let problemLine = $state(null);
  /** @type {?HTMLElement} */
  let saidLine = $state(null);
  /** @type {?HTMLButtonElement} */
  let checkButton = $state(null);
  let sending = $state(false);
  const sender = $derived.by(() => {
    if (!relay.sender) return null;
    return withLearnt(relay.sender, { sentExpires: shared.sentExpires, checked: shared.checked });
  });
  const row = $derived(sender ? checkRow(sender) : null);
  const senders = $derived(relay.senders ?? []);
  const extras = $derived(extrasOf(senders));
  const full = $derived(atLimit(senders));
  /* What is typed in the add input; kept when the add is refused. */
  let typed = $state("");
  /* One extra-row press at a time: `add`, or the id of the row pressed. */
  let senderBusy = $state(/** @type {string | null} */ (null));
  const usable = $derived(shape.mailbox);

  /** @param {string} words */
  const refuse = async (words) => {
    problem = words;
    said = "";
    await tick();
    problemLine?.focus();
  };

  /** @param {"rotate" | "pause" | "resume"} action */
  const act = async (action) => {
    if (shared.working) return;
    shared.working = true;
    problem = null;
    said = "";
    try {
      if (action === "rotate") {
        /* #1810 W-R2: a lost answer is re-read, and the screen says what it shows. */
        const outcome = await rotateRelayReconciled(relay.address);
        if (outcome.relay) shared.rotated = outcome.relay;
        if (outcome.rotated === null) await refuse(ROTATE_UNKNOWN);
        else if (!outcome.rotated) await refuse(ROTATE_UNCHANGED);
      } else {
        shared.rotated = await rotateRelay(action);
      }
    } catch {
      /* #1151 W2-R6: the same words as the phone's own copy of this act. */
      await refuse(action === "rotate"
        ? ROTATE_UNCHANGED
        : `not ${action === "pause" ? "paused" : "resumed"} — Orbit could not reach your relay`);
    } finally {
      shared.working = false;
    }
  };
  /* The body is empty: the registered address is the only one the server will check. */
  const sendCheck = async () => {
    if (sending || !sender) return;
    sending = true;
    problem = null;
    said = "";
    /** @type {"button" | "said" | "alert"} */
    let focusOn = "button";
    try {
      const sent = await sendSenderCheck();
      shared.sentExpires = sent.expiresAt;
      said = sentWords(sent.address ?? sender.address);
    } catch (error) {
      const already = alreadyCheckedWords(error);
      if (already !== null) {
        /* The button stays held until the re-read answers. If it cannot, the
           server has still said so: the row follows it. */
        try { shared.rotated = await readRelay(); } catch { shared.checked = true; }
        said = already;
        focusOn = "said";
      } else {
        problem = refusalWords(error);
        focusOn = "alert";
      }
    } finally {
      sending = false;
    }
    await tick();
    (focusOn === "button" ? checkButton : focusOn === "said" ? saidLine : problemLine)?.focus();
  };
  /* #1650: the server's answer is the whole list, which replaces the read's. */
  /** @param {import("$lib/data/workspace.js").RelaySenderRow[]} list */
  const keepSenders = (list) => { shared.rotated = { ...(shared.rotated ?? loaded), senders: list }; };
  const addOne = async () => {
    const address = typed.trim();
    if (senderBusy !== null || full || !address) return;
    senderBusy = "add";
    problem = null;
    said = "";
    try {
      keepSenders(await addSender(address));
      typed = "";
    } catch (error) {
      await refuse(refusalWords(error, NOT_ADDED));
    } finally {
      senderBusy = null;
    }
  };
  /* The relay only: the same `shared.rotated` the sender check writes, so both
     layouts recover together. A second failure keeps the line, and focuses it. */
  const retryRead = async () => {
    if (retrying) return;
    retrying = true;
    try {
      shared.rotated = await readRelay();
      /* The button is gone with the line: focus the status row, not the body. */
      await tick();
      statusLine?.focus();
    } catch {
      await tick();
      notReadLine?.focus();
    } finally {
      retrying = false;
    }
  };
  /** @param {import("$lib/data/workspace.js").RelaySenderRow} extra */
  const removeOne = async (extra) => {
    if (senderBusy !== null) return;
    senderBusy = extra.id;
    problem = null;
    said = "";
    try {
      keepSenders(await removeSender(extra.id));
    } catch (error) {
      await refuse(refusalWords(error, NOT_REMOVED));
    } finally {
      senderBusy = null;
    }
  };
  /** @param {import("$lib/data/workspace.js").RelaySenderRow} extra */
  const checkOne = async (extra) => {
    if (senderBusy !== null) return;
    senderBusy = extra.id;
    problem = null;
    said = "";
    try {
      const sent = await sendSenderCheck(extra.id);
      keepSenders(withCheckSent(senders, extra.id, sent.expiresAt ?? null));
      said = sentWords(sent.address ?? extra.address);
    } catch (error) {
      const already = alreadyCheckedWords(error);
      if (already !== null) {
        try { shared.rotated = await readRelay(); } catch { /* the row says what the read last said */ }
        said = already;
      } else {
        await refuse(refusalWords(error));
      }
    } finally {
      senderBusy = null;
    }
  };

  /* #1151 S7: the first tap arms, the second fires; an unfired arm relaxes
     after four seconds, on scroll, on Escape and on a tap elsewhere. */
  /** @param {MouseEvent & { currentTarget: HTMLElement }} event */
  const tapRotate = (event) => {
    if (rotateArm.tap(true, event.currentTarget)) act("rotate");
  };
  /** @param {MouseEvent & { currentTarget: HTMLElement }} event @param {import("$lib/data/workspace.js").RelaySenderRow} extra */
  const tapRemove = (event, extra) => {
    if (removeArm.tap(extra.id, event.currentTarget)) removeOne(extra);
  };
  const toggleIngest = () => {
    rotateArm.disarm();
    act(relay.ingest === "paused" ? "resume" : "pause");
  };

  /* The check email's link landed here (the page read ?sender= and cleared
     it); the phone's layout says it in its own way. */
  onMount(() => {
    if (!live || !landing) return;
    if (landing === "verified") said = LINK_CHECKED;
    if (landing === "unverified") refuse(LINK_FAILED);
    onlanded();
  });
</script>

<div class="relay-card">
  <!-- Snippets live inside the card, not at the root: a root snippet after a
       @type comment breaks the rolldown build (#1130). -->
  {#snippet addressPill()}
    <button class="alias copy" disabled={!usable} onclick={() => copyRelayAddress(relay.address)} aria-label={relayAddressLabel(relay.address)}>
      <span class="dish {shape.dish}" aria-hidden="true"><span></span><span></span><span></span><i></i></span>
      <span class="addr">{relay.address}</span>
      <small aria-hidden="true">{usable ? "click to copy" : ""}</small>
    </button>
  {/snippet}

  {#snippet statusRow()}
    <div class="kv" tabindex="-1" bind:this={statusLine}><span>status</span><b class={shape.tone}>{shape.status}</b></div>
  {/snippet}

  {#snippet waitingRow()}
    <div class="kv"><span>waiting for review</span><a href={resolve("/inbox")}>{plural(waiting, "arrival")} — open your inbox →</a></div>
  {/snippet}

  {#if shape.unavailable}
    <!-- #1810 W-R1: the read failed, so none of the relay's parts are drawn
         (a pill would say "no address yet", which is not known). -->
    <p class="problem" role="alert" tabindex="-1" bind:this={notReadLine}>{RELAY_NOT_READ}</p>
    <div class="btns"><button class="pri" disabled={retrying} onclick={retryRead}>try again</button></div>
  {:else if !shape.mailbox}
    <!-- No household mailbox: the slot and the explanation, nothing that cannot work yet. -->
    {@render addressPill()}
    {@render statusRow()}
    {#if shape.unset}
      <p class="note guide only" role="status">
        {#if admin}{NO_MAILBOX_ADMIN} · <a href={`${resolve("/administration")}#mail-card`}>{NO_MAILBOX_LINK}</a>{:else}{NO_MAILBOX_MEMBER}{/if}
      </p>
    {/if}
  {:else}
    <div class="halves">
      <div class="half">
        <!-- The mock-up's tab draws no label here (the tab says it); kept for
             assistive tech, unseen, as the right half's is seen. -->
        <div class="sr-only">Your relay</div>
        {@render addressPill()}
        {#if !shape.usable}<p class="note guide" role="status">{READY_WORDS}</p>{/if}
        {@render statusRow()}
        {#if relay.adminPaused}<p class="note" role="status">{ADMIN_PAUSED_WORDS}</p>{/if}
        {#if shape.usable}
          <div class="kv"><span>last received</span>{#if relay.lastReceived === "nothing yet"}<b class="quiet">{NOTHING_YET}</b>{:else}<span>{relay.lastReceived}</span>{/if}</div>
          <div class="kv"><span>ingest</span><b class={relay.ingest === "paused" ? "warm" : "on"}>{relay.ingest}</b></div>
        {/if}
        {@render waitingRow()}
        {#if shape.usable}
          <div class="btns"><button class="pri warm" disabled={working} aria-expanded={armedRotate} onclick={tapRotate}>{armedRotate ? "tap again to rotate" : "rotate address"}</button><button disabled={working || relay.adminPaused} onclick={toggleIngest}>{relay.ingest === "paused" ? "resume ingest" : "pause ingest"}</button></div>
          {#if armedRotate}<p class="said" role="status">{ARMED_WORDS}</p>{/if}
        {/if}
      </div>
      <div class="half">
        <div class="sublabel">Sending addresses</div>
        {#if row && sender}
          <div class="kv"><span>sending from</span><span>{sender.address}</span></div>
          <div class="kv"><span>sender check</span><b class={row.tone === "warm" ? "warm" : "on"}>{row.says}</b></div>
        {/if}
        <!-- The extras stand on their own (#1650 review): a member with no
             readable seeded row still lists, removes and adds them. -->
        {#each extras as extra (extra.id)}
          {@const line = extraRow(extra)}
          <div class="kv extra">
            <span class="extra-address">{extra.address}</span>
            <span class="extra-end">
              <b class:warm={line.tone === "warm"} class:on={line.tone === "ok"}>{line.says}</b>
              {#if line.canCheck}<button class="txt" disabled={senderBusy !== null} onclick={() => checkOne(extra)}>{SEND_CHECK}</button>{/if}
              <button class="txt quiet" disabled={senderBusy !== null} onclick={(event) => tapRemove(event, extra)}>{armedRemove === extra.id ? REMOVE_ARMED : REMOVE}</button>
            </span>
          </div>
          {#if armedRemove === extra.id}<p class="said" role="status">{removeArmedWords(extra)}</p>{/if}
        {/each}
        <div class="add-sender">
          <input type="email" autocomplete="email" placeholder={ADD_PLACEHOLDER} aria-label={ADD_PLACEHOLDER} bind:value={typed}
                 disabled={full} onkeydown={(event) => { if (event.key === "Enter") addOne(); }} />
          <button class="fill" disabled={senderBusy !== null || full || !typed.trim()} onclick={addOne}>{ADD}</button>
        </div>
        {#if full}<p class="note at-limit">{AT_LIMIT}</p>{/if}
        {#if row?.button}
          <div class="btns"><button class="pri" bind:this={checkButton} disabled={sending} onclick={sendCheck}>{sending ? SENDING : row.button}</button></div>
        {/if}
        {#if problem}<p class="problem" role="alert" tabindex="-1" bind:this={problemLine}>{problem}</p>{/if}
        <p class="said" role="status" tabindex="-1" bind:this={saidLine}>{said}</p>
      </div>
    </div>
  {/if}
  {#if failures.length}
    <!-- #434: arrived-but-unreadable mail, in the server's own bounded words. -->
    <div class="failures">
      <h2>arrived, but could not be read</h2>
      {#each failures as failure (failure.id)}
        <div class="kv"><span>{dayMonth(failure.receivedAt)}</span><span>{failureWords(failure)} · {failure.message}</span></div>
      {/each}
    </div>
  {/if}
</div>
