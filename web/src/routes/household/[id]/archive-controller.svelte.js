import { onMount } from "svelte";
import { clockOf, dayMonth, localZone, plural } from "$lib/format.js";
import {
  importPortableArchive,
  previewPortableArchive,
  readSignInMethods,
  startStepUp,
  fetchPortableArchiveState,
  retryPortableArchive,
  startPortableArchive,
  wordsOf,
} from "$lib/data/workspace.js";
import { archiveFileProblem, checkFileReadable, exportLive, FILE_CHANGED_WORDS, fileChangedSincePicked, nextPhase, passphraseFloor, passphraseLength, passphraseProblem, previewSlice, progressWords } from "./archive.js";
import { tabArrows } from "$lib/tabs.js";

/*
 * THE ARCHIVE CARD'S ONE STATE MACHINE (#1354), held once for the desk's
 * DeskArchive.svelte (#1002) and the phone's PocketArchive.svelte (#1122).
 * The two differ in how the recent-authentication challenge (#1132) is shown
 * (inline on the desk, a Sheet on the phone), in the desk's own two-tap
 * button (the phone has ArmButton), and in the phone's wake lines; the acts,
 * the phases and the refusals are the same, so they live here. Call it from
 * a component's script, since it mounts a hook. It takes:
 *   householdId, limits   read when needed, so each is a getter;
 *   tabIdPrefix           the tab buttons' id prefix, for the arrow keys;
 *   wake                  the phone's line at the foot of the screen (the
 *                         desk passes none).
 */

/* #1151 W2-R1: set just before the step-up redirect, cleared on the way
   back in. sessionStorage, not a query param — the identity provider owns
   `returnTo` and this reader's own tab is the only place this needs to be
   read. */
const STEPUP_RETURN_FLAG = "orbit-archive-stepup-return";

const quiet = () => {};

/* #1774: how often the card reads a live export job. */
const EXPORT_POLL_MS = 2_000;
/* The failed line when the job carries no words of its own. */
const EXPORT_FAILED_WORDS = "Orbit could not write the archive";

/** @param {unknown} error */
const codeOf = (error) => /** @type {{ code?: string }} */ (error)?.code;

/** @param {unknown} error */
const needsProof = (error) => /** @type {{ code?: string }} */ (error)?.code === "recent_authentication_required";

/** A refusal in the server's words, but a file that is not an archive (#1566), or one that changed
    after it was chosen (#1605 W-R12), in the card's own. @param {unknown} error */
const refusalWords = (error) => fileChangedSincePicked(error)
  ? FILE_CHANGED_WORDS
  : /** @type {{ code?: string }} */ (error)?.code === "archive_invalid"
    ? "this file is not an Orbit archive"
    : wordsOf(error);

/**
 * @param {{
 *   householdId: () => string,
 *   limits: () => import("$lib/data/engine-limits.js").EngineLimits | null,
 *   tabIdPrefix: string,
 *   wake?: (words: string) => void,
 * }} on
 */
export function createArchiveController({ householdId, limits, tabIdPrefix, wake = quiet }) {
  /* The engine's numbers (#1336): the passphrase floor the buttons wait for. */
  const passphraseMin = $derived(passphraseFloor(limits()));

  let tab = $state(/** @type {"out" | "in"} */ ("out"));

  /* ── take it with you ─────────────────────────────────────────────────── */
  let outPhase = $state(/** @type {"rest" | "form" | "queued" | "writing" | "written"} */ ("rest"));
  /* #1774: the export is a background job; the card follows the last one it read. */
  let job = $state(/** @type {import('$lib/data/workspace.js').ArchiveExportJob | null} */ (null));
  /* A failed job the card is showing: its words and its one control, in place of the form's fields. */
  let failure = $state(/** @type {import('$lib/data/workspace.js').ArchiveExportJob | null} */ (null));
  /* A start or a retry is on its way: a read must not move the card under it. */
  let sending = $state(false);
  let passOut = $state("");
  let passAgain = $state("");
  let written = $state(/** @type {import('$lib/data/workspace.js').WrittenArchive | null} */ (null));
  /** @type {string | null} */
  let outProblem = $state(null);
  const outRefusal = $derived(passphraseProblem(passOut, passAgain, limits()));

  /* ── bring one in ─────────────────────────────────────────────────────── */
  let inPhase = $state(/** @type {"rest" | "chosen" | "looking" | "preview" | "bringing" | "done"} */ ("rest"));
  /** @type {File | null} */
  let file = $state(null);
  let passIn = $state("");
  let preview = $state(/** @type {import('$lib/data/workspace.js').ArchivePreview | null} */ (null));
  let brought = $state(0);
  /** @type {string | null} */
  let inProblem = $state(null);
  /** @type {HTMLInputElement | undefined} */
  let picker = $state();

  /* ── the recent-authentication challenge (#1132) ──────────────────────── */
  let challengeOpen = $state(false);
  /** @type {boolean | null} */
  let hasPassword = $state(null);
  let currentPassword = $state("");
  let proving = $state(false);
  /** @type {string | null} */
  let challengeProblem = $state(null);
  /** @type {((proof: string) => Promise<void>) | null} */
  let retry = null;
  /** The step-up intent the held act needs: one each way, so a proof for one cannot pay for the other.
      Reactive: the desk's panels branch on it to show the challenge under whichever act is holding it
      (the phone's Sheet does not read it). */
  let retryIntent = $state(/** @type {"archive_export" | "archive_import"} */ ("archive_export"));

  /**
   * Runs an archive act; if the server wants proof first, holds the act and
   * opens the challenge, which runs it again carrying the proof.
   * @param {(proof: string) => Promise<void>} act
   * @param {(words: string) => void} fail
   * @param {"archive_export" | "archive_import"} intent
   * @param {() => void} hold steps the act back to the screen the challenge sits on
   */
  async function guarded(act, fail, intent, hold) {
    try {
      await act("");
    } catch (error) {
      if (!needsProof(error)) { fail(refusalWords(error)); return; }
      /* How this reader proves it is them is asked BEFORE the challenge
         opens, and the act steps back to its screen in the same turn, so
         the challenge is drawn once, in its final place. Opened first and
         moved once the answer came, its field was rebuilt under a reader
         already typing in it, and what they typed was lost (pipeline 2382). */
      if (hasPassword === null) {
        hasPassword = await readSignInMethods().then((methods) => methods.local.set, () => true);
      }
      retry = act;
      retryIntent = intent;
      currentPassword = "";
      challengeProblem = null;
      hold();
      challengeOpen = true;
    }
  }

  /** The desk's cancel: closes the challenge and forgets the proof typed. */
  function cancelChallenge() {
    sending = false;
    challengeOpen = false;
    retry = null;
    currentPassword = "";
    challengeProblem = null;
  }

  /** The phone's Sheet closes itself; this only drops the held act. */
  function dropRetry() {
    sending = false;
    retry = null;
  }

  async function prove() {
    if (!retry || proving) return;
    proving = true;
    challengeProblem = null;
    try {
      await retry(currentPassword);
      challengeOpen = false;
      retry = null;
    } catch (error) {
      challengeProblem = needsProof(error) ? "that password did not match · try again" : wordsOf(error);
    } finally {
      proving = false;
    }
  }

  async function toProvider() {
    challengeProblem = null;
    try {
      /* The redirect below leaves this page entirely — the chosen file, its
         passphrase and the preview cannot survive that, browser-held state
         has nowhere to live across it. A flag saying only "an archive act
         sent this reader to the provider" can, and sessionStorage is the
         right shelf for it: gone the moment the tab closes, never the
         passphrase itself. */
      try { sessionStorage.setItem(STEPUP_RETURN_FLAG, "1"); } catch { /* storage refused: the redirect still happens, just without the notice on return */ }
      await startStepUp({ intent: retryIntent, returnTo: location.pathname });
    } catch (error) {
      try { sessionStorage.removeItem(STEPUP_RETURN_FLAG); } catch { /* nothing to clear */ }
      challengeProblem = wordsOf(error);
    }
  }

  /** @type {string | null} */
  let stepUpNotice = $state(null);

  /* Read, not consumed: the desk card and the phone card are both on the page (CSS
     picks which shows), so whichever mounted first and took the flag would
     leave the visible one with no notice. Both read it in their onMount and
     the flag is cleared a tick later, once both have. */
  onMount(() => {
    let returning = null;
    try { returning = sessionStorage.getItem(STEPUP_RETURN_FLAG); } catch { /* unreadable: treat as not returning */ }
    if (!returning) return;
    setTimeout(() => {
      try { sessionStorage.removeItem(STEPUP_RETURN_FLAG); } catch { /* already gone, or unreadable */ }
    }, 0);
    stepUpNotice = "back from signing in again · choose the file once more to carry on";
  });

  const readyUntil = $derived(written
    ? `${dayMonth(written.expiresAt, localZone())}, ${clockOf(written.expiresAt, localZone())}`
    : "");

  /* ── the export job (#1774): read on mount, every 2 s while it is live, once on return to the tab ── */
  const writingWords = $derived(progressWordsOf(job));
  /** @param {typeof job} current */
  function progressWordsOf(current) {
    return progressWords(current?.bytesDone ?? null, current?.bytesTotal ?? null, "");
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let pollTimer = null;
  let mounted = false;

  /** The next read, while the job is live and the card is on the page. */
  function schedule() {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    if (mounted && exportLive({ export: job })) pollTimer = setTimeout(readExport, EXPORT_POLL_MS);
  }

  /* Latest request wins: a read's answer counts only if no read, start or
     retry began after it, so an older answer landing late can never move the
     card back (or fire the wake twice). */
  let readSeq = 0;

  async function readExport() {
    pollTimer = null;
    const seq = ++readSeq;
    try {
      const state = await fetchPortableArchiveState(householdId());
      if (seq !== readSeq) return;
      apply(state);
    } catch {
      /* Unread this time: the card keeps what it showed and reads again on the next tick. */
    }
    schedule();
  }

  /**
   * Moves the card to what the read says, unless the reader is in the middle
   * of something (typing a passphrase, a challenge, a send on its way).
   * @param {import('$lib/data/workspace.js').ArchiveExportState} state
   */
  function apply(state) {
    if (sending || challengeOpen || (outPhase === "form" && failure === null)) return;
    const before = job;
    job = state.export;
    written = state.latest;
    let phase = nextPhase(state);
    if (phase === "written" && !written) phase = "rest";
    if (phase === "form" && state.export) {
      failure = state.export;
      outProblem = `not written — ${state.export.failureMessage || EXPORT_FAILED_WORDS}`;
    } else {
      failure = null;
      outProblem = null;
    }
    outPhase = phase;
    /* The wake only for a job this page saw live, never for one found finished. */
    if (phase === "written" && before && exportLive({ export: before }) && before.id === state.export?.id) {
      wake(`the archive is written · download it before ${readyUntil}`);
    }
  }

  onMount(() => {
    mounted = true;
    const onVisible = () => { if (document.visibilityState === "visible") readExport(); };
    document.addEventListener("visibilitychange", onVisible);
    readExport();
    return () => {
      mounted = false;
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  });

  /* ── acts ─────────────────────────────────────────────────────────────── */
  function startExport() {
    failure = null;
    outProblem = null;
    outPhase = "form";
  }

  function cancelExport() {
    outPhase = "rest";
    passOut = "";
    passAgain = "";
    outProblem = null;
    failure = null;
  }

  /** A failed job whose key is gone: the form again, for a new passphrase. */
  function writeAgain() {
    failure = null;
    outProblem = null;
    outPhase = "form";
  }

  /** @param {import('$lib/data/workspace.js').ArchiveExportJob} started */
  function queued(started) {
    readSeq += 1; // a read sent before this answer is older than it
    job = started;
    failure = null;
    outProblem = null;
    passOut = "";
    passAgain = "";
    outPhase = "queued";
    schedule();
  }

  /** Another export of this household is already live: the card shows that one. */
  async function followLive() {
    sending = false;
    passOut = "";
    passAgain = "";
    failure = null;
    outPhase = "queued";
    await readExport();
  }

  /* The start stays on the form, its button held by `sending`, until the
     POST is answered: "queued" only once a job exists (never under the
     step-up challenge). `sending` spans the whole act, the challenge
     included, and is let go when it fails, holds for the challenge, or the
     challenge is left. */
  function writeArchive() {
    if (outRefusal || sending) return;
    outProblem = null;
    sending = true;
    guarded(async (proof) => {
      sending = true;
      let started;
      try {
        started = await startPortableArchive(householdId(), { passphrase: passOut, currentPassword: proof || undefined });
      } catch (error) {
        if (codeOf(error) !== "archive_export_in_progress") throw error;
        await followLive();
        return;
      }
      sending = false;
      queued(started);
    }, (words) => {
      sending = false;
      outProblem = `not written — ${words}`;
      outPhase = "form";
    }, "archive_export", () => { sending = false; outPhase = "form"; });
  }

  /** A failed job, again, with the key its start left (within the hour): no second passphrase. */
  function retryExport() {
    const failed = failure;
    if (!failed || sending) return;
    sending = true;
    guarded(async (proof) => {
      sending = true;
      let again;
      try {
        again = await retryPortableArchive(householdId(), failed.id, { currentPassword: proof || undefined });
      } catch (error) {
        const code = codeOf(error);
        if (code === "archive_export_key_gone") {
          /* The hour has passed: the form, for a new passphrase. */
          sending = false;
          failure = null;
          outProblem = `not written — ${wordsOf(error)}`;
          outPhase = "form";
          return;
        }
        if (code === "archive_export_conflict") {
          /* The job moved (another tab retried it): show what it is now. */
          sending = false;
          failure = null;
          outPhase = "queued";
          await readExport();
          return;
        }
        throw error;
      }
      sending = false;
      queued(again);
    }, (words) => {
      sending = false;
      outProblem = `not written — ${words}`;
      outPhase = "form";
    }, "archive_export", () => { sending = false; outPhase = "form"; });
  }

  /** @param {Event} event */
  async function chose(event) {
    const input = /** @type {HTMLInputElement} */ (event.currentTarget);
    const next = input.files?.[0] ?? null;
    input.value = "";
    if (inPhase === "bringing") return;
    if (!next) return;
    inProblem = archiveFileProblem(next, limits());
    preview = null;
    file = next;
    inPhase = inProblem ? "rest" : "chosen";
  }

  async function lookInside() {
    if (!file || passphraseLength(passIn) < passphraseMin) return;
    inProblem = null;
    inPhase = "looking";
    /* The file is never parsed here (#1566): the server says whether it is
       an archive, and `refusalWords` puts that in the card's words. Only its
       first 64 bytes are read, to send a v2 archive's head alone (#1390). */
    const chosen = file;
    await guarded(async (proof) => {
      preview = await previewPortableArchive(householdId(), { file: await previewSlice(chosen), passphrase: passIn, currentPassword: proof || undefined });
      inPhase = "preview";
    }, (words) => {
      inProblem = words;
      inPhase = "chosen";
    }, "archive_import", () => { inPhase = "chosen"; });
  }

  const bringCount = $derived(preview ? preview.items - preview.conflicts.length : 0);

  function bringIn() {
    if (!preview) return;
    const skip = preview.conflicts.map((one) => one.id);
    const chosen = file;
    if (!chosen) return;
    inProblem = null;
    inPhase = "bringing";
    guarded(async (proof) => {
      await checkFileReadable(chosen); // a file changed since it was picked stops here, not in the upload
      const result = await importPortableArchive(householdId(), { file: chosen, passphrase: passIn, skip, currentPassword: proof || undefined });
      brought = result.importedItems;
      inPhase = "done";
      passIn = "";
      wake(`brought in ${plural(brought, "entry", "entries")}`);
    }, (words) => {
      inProblem = `not brought in — ${words}`;
      inPhase = "preview";
    }, "archive_import", () => { inPhase = "preview"; });
  }

  function startOver() {
    file = null;
    preview = null;
    passIn = "";
    inProblem = null;
    inPhase = "rest";
  }

  /* §22's keyboard: one tab in the Tab order, ← → between them. */
  const tabKey = tabArrows(["out", "in"], {
    get: () => tab, set: (key) => (tab = key), id: (key) => `${tabIdPrefix}${key}`,
  });

  return {
    get tab() { return tab; }, set tab(next) { tab = next; },
    get passOut() { return passOut; }, set passOut(next) { passOut = next; },
    get passAgain() { return passAgain; }, set passAgain(next) { passAgain = next; },
    get passIn() { return passIn; }, set passIn(next) { passIn = next; },
    get currentPassword() { return currentPassword; }, set currentPassword(next) { currentPassword = next; },
    get challengeOpen() { return challengeOpen; }, set challengeOpen(next) { challengeOpen = next; },
    get picker() { return picker; }, set picker(next) { picker = next; },
    get passphraseMin() { return passphraseMin; },
    get outPhase() { return outPhase; },
    get failure() { return failure; },
    get sending() { return sending; },
    get writingWords() { return writingWords; },
    get written() { return written; },
    get outProblem() { return outProblem; },
    get outRefusal() { return outRefusal; },
    get inPhase() { return inPhase; },
    get file() { return file; },
    get preview() { return preview; },
    get brought() { return brought; },
    get inProblem() { return inProblem; },
    get hasPassword() { return hasPassword; },
    get proving() { return proving; },
    get challengeProblem() { return challengeProblem; },
    get retryIntent() { return retryIntent; },
    get stepUpNotice() { return stepUpNotice; },
    get bringCount() { return bringCount; },
    get readyUntil() { return readyUntil; },
    tabKey, startExport, cancelExport, writeArchive, retryExport, writeAgain, chose, lookInside, bringIn, startOver,
    cancelChallenge, dropRetry, prove, toProvider,
  };
}
