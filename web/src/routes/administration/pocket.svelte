<script>
  import { onMount, tick } from "svelte";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import ChooserCard from "$lib/editing/ChooserCard.svelte";
  import { inertPage } from "$lib/pocket/focus.js";
  import { wake } from "$lib/pocket/wake.js";
  import { deletionNameMatches } from "$lib/data/household.js";
  import { ago, dayMonth, dayMonthYear, initials, plural } from "$lib/format.js";
  import { SETUP_LINK_FIXTURES } from "$lib/data/fixtures/admin.js";
  import { BAND_VAR } from "$lib/data/bands.js";
  import { prefersReducedMotion } from "$lib/motion.js";
  import { NAME_LIMIT } from "$lib/arrival/stage.js";
  import {
    ALIAS_GRACE_DAYS, JOB_KINDS, JOB_STATES, SETUP_LINK_DAYS, blankMailDraft, providerAsk, daysLeft, probeWords, fetchNowRefusal, fetchNowWords,
    expired, failedHalvesOf, freshInvite, ingestShort, jobCountsOf, jobMetaOf, jobsOf, lapsesShort, mailDraftOf, exportsKeptShort, megabytes, documentsOwed,
    openFor, plainly, sendWords, shortDay, stamp, systemDotsOf, tellsOf, testMetaOf, testVerdict, versionLine,
    namesOf, notMailedWords, providerHost,
    SENDING_HOW_HREF, SENDING_NOT_SET, blankSendDraft, importSkippedWords, mailboxSubmissionHost, sendDraftOf, sendingOutcomeWords, sendingRowsOf,
  } from "./words.js";
  import {
    canRemove, closeConfirm, loadProviders, openConfirm, providerRows, providerState, removeNow, signedOutToo,
  } from "./providers.js";
  import {
    card, commandMail, deleteSystemNow, inviteLocalUser, issueSetupLink, makeSystem, placePerson, restoreSystem,
    runMailTest, retryJob, saveSending, setArchiveStorage, setContact, setDisabled, setMailLimit, setUploadLimit,
  } from "./acts.svelte.js";

  /*
   * ADMINISTRATION ON A PHONE (#1123, proposal §2.12 and §2.11; owner
   * decisions §25 and §19). Rendered beside the desk's grid and chosen by CSS
   * (the switch at the foot of the styles), as the household and create are.
   * It shares the desk page's state where the server's rules live there: the
   * step-up challenge (ADR-0023 §5), the typed invite that survives a trip to
   * the identity provider, and the whole-screen re-read after every act.
   *
   * On a phone the page is mostly for "is it healthy" and "let someone in",
   * so, top to bottom on the station's own sky (its labels hidden, §1.10):
   *   the title, its one line, and a tell for anything failing further down
   *   the jump strip: plain anchors to each card, not tabs
   *   ALERTS first, when there are any: one sentence and one pill each
   *   PEOPLE: invite someone is a sheet; a tap opens a person's row (§1.1)
   *   SYSTEMS: new system is a sheet; a system on the clock (§2.11, §19)
   *     keeps `restore` on show and `delete now` in its opened row
   *   PUBLIC CONTACT; MAIL, the mailbox and sending, with its two tests (#1071, #1629)
   *   OPERATIONS; DOCUMENT JOBS (#1071), then the version line
   *
   * A row's acts open in place on a tap (review round §1.1), not behind a
   * swipe. The setup link is never shown on this screen, on either dialect
   * (owner, 2026-09-09): what it reports is where the link went and when it
   * lapses.
   */

  /** @typedef {NonNullable<Awaited<ReturnType<typeof import('$lib/data/workspace.js').readAdminScreen>>>} AdminView */
  /** @typedef {{ email: string, displayName: string, expiresInDays: number }} Draft */
  /** @typedef {(intent: string, open: () => void, report?: (message: string) => void, about?: { resend?: { personId: string, days: number } }) => Promise<void>} Challenge */
  /** @typedef {NonNullable<AdminView["users"]>[number]} Person */
  /** @typedef {AdminView["households"][number]} System */

  /** @type {{ view: AdminView | null, fixtures: boolean, actorHasPassword: boolean, provenIntent: string, resumedResendPersonId: string | null, draft: Draft, challenge: Challenge, reread: () => Promise<void>, spent: () => void, screenProblem: string | null, screenRefused: boolean, onretry: () => void }} */
  let { view, fixtures, actorHasPassword, provenIntent, resumedResendPersonId, draft = $bindable(), challenge, reread, spent, screenProblem, screenRefused, onretry } = $props();

  /* A panel whose read failed says so with a "try again" (#1442), as
     settings does on the phone (#1195): the whole screen is re-read, and a
     re-read that fails again keeps the screen it has. */
  /* A second failure is said, not swallowed (#1443). `emptyAnswer` is the
     screen a press came back with while some card was still failed; the
     cards still failed on it say so. reread() still resolves when a card's own
     read fails again, so that counts as well as a rejected read. Any other
     re-read replaces the screen, so a card that fails for the first time
     afterwards does not say "tried again". A press while its re-read is out
     is ignored, so an older answer cannot land over a newer one. */
  /** @type {AdminView | null} */
  let emptyAnswer = $state.raw(null);
  const stillNoAnswer = $derived(emptyAnswer !== null && emptyAnswer === view);
  let retrying = $state(false);
  const tryAgain = async () => {
    if (retrying) return;
    retrying = true;
    try {
      await reread();
      emptyAnswer = view && Object.values(view.failed).some(Boolean) ? view : null;
    } catch {
      /* the screen it has stays, and its failed cards say so */
      emptyAnswer = view;
    } finally {
      retrying = false;
    }
  };

  const people = $derived(view?.users ?? []);
  const systems = $derived(view?.households ?? []);
  const meId = $derived(view?.user?.id ?? null);

  /* ── alerts: the four notices the desk stands first in its grid ───────── */
  /** @typedef {{ id: "rotation" | "locked" | "damaged" | "bundle", title: string, say: string }} Alert */
  const alerts = $derived.by(() => {
    /** @type {Alert[]} */
    const list = [];
    if (!view) return list;
    const rotation = view.rotation;
    if (rotation?.inProgress) {
      list.push({ id: "rotation", title: "Key rotation in progress", say: rotation.secondKeyLoaded
        ? `Open ${rotation.startedAt ? openFor(rotation.startedAt) : "since an unrecorded time"}. Every document stays readable, but it is meant to be brief.`
        : "Started and never recorded as finished. Check where it got to before changing anything." });
    }
    if (view.metadata?.locked) {
      list.push({ id: "locked", title: "Encrypted details are locked",
        say: "The encryption key isn’t available, so notes, references and mail-in extracts can’t be read, and item editing is paused." });
    }
    if ((view.metadata?.damagedValues ?? 0) > 0) {
      list.push({ id: "damaged", title: "Damaged encrypted details",
        say: `${plural(view.metadata?.damagedValues ?? 0, "value")} failed the integrity check and can’t be recovered.` });
    }
    if (view.recoveryBundle && !view.recoveryBundle.exported) {
      list.push({ id: "bundle", title: "No recovery bundle exported",
        say: "If the encryption key is lost with no bundle to recover it, every document is gone for good." });
    }
    return list;
  });
  /** @type {Alert | null} */
  let reading = $state(null);
  let readingOpen = $state(false);

  /* ── the tells: failures further down the page, said at the top (#1071) ─ */
  /* words.js's tellsOf, with the failing services the desk leaves to its grid. */
  const TELL_ID = { jobs: "ad-documents", operations: "ad-operations", mail: "ad-mail" };
  const tells = $derived.by(() => tellsOf(view, jobs, { services: true }).map(({ card: at, text }) => ({ id: TELL_ID[at], word: text })));

  /* ── the jump strip: anchors, so it works without script ──────────────── */
  const JUMPS = [
    ["people", "ad-people"], ["systems", "ad-systems"], ["contact", "ad-contact"],
    ["mail", "ad-mail"], ["operations", "ad-operations"], ["documents", "ad-documents"],
  ];
  /**
   * A smooth arrival where motion is welcome; the anchor alone otherwise.
   * @param {MouseEvent} event @param {string} id
   */
  function jump(event, id) {
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    const still = prefersReducedMotion();
    target.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    history.replaceState(history.state, "", `#${id}`);
    target.focus({ preventScroll: true });
  }

  /* ── people ───────────────────────────────────────────────────────────── */
  /* `busy` is the person being placed. */
  const peopleCard = $state({ busy: /** @type {string | null} */ (null), problem: /** @type {string | null} */ (null) });
  /** @type {?(import("./acts.svelte.js").Delivery & { userId?: string })} */
  let delivery = $state(null);

  let inviteOpen = $state(false);
  let inviteArmed = $state(false);
  let invitePassword = $state("");
  const inviteCard = $state(card());

  function openInvite() {
    inviteCard.problem = null;
    inviteArmed = false;
    invitePassword = "";
    inviteOpen = true;
  }

  /** @param {number} days @param {-1 | 1} by */
  const stepped = (days, by) => Math.min(SETUP_LINK_DAYS.max, Math.max(SETUP_LINK_DAYS.min, Number(days) + by));

  async function invite() {
    if (inviteCard.busy) return;
    if (!inviteArmed && provenIntent !== "local_user_create") {
      await challenge("local_user_create", () => (inviteArmed = true), (message) => (inviteCard.problem = message));
      return;
    }
    await inviteLocalUser(draft, invitePassword, {
      card: inviteCard, actorHasPassword, reread, wake,
      landed: (made) => {
        delivery = made;
        inviteArmed = false;
        invitePassword = "";
        spent();
        inviteOpen = false;
        if (!made.sendError) draft = freshInvite();
      },
    });
  }

  /* A fresh setup link: the person's own act, and the Retry under a failed
     send. Issuing one kills the earlier link (ADR-0023 §3). */
  /** @type {Person | null} */
  let resendFor = $state(null);
  let resendOpen = $state(false);
  let resendDays = $state(SETUP_LINK_DAYS.fallback);
  let resendPassword = $state("");
  const resendCard = $state(card());

  /** @param {Person} person */
  function openResend(person) {
    peopleCard.problem = null;
    challenge("setup_link_issue", () => {
      resendFor = person;
      resendDays = SETUP_LINK_DAYS.fallback;
      resendPassword = "";
      resendCard.problem = null;
      resendOpen = true;
    }, (message) => (peopleCard.problem = message), { resend: { personId: person.id, days: SETUP_LINK_DAYS.fallback } });
  }

  async function resend() {
    const person = resendFor;
    if (!person) return;
    await issueSetupLink(person.id, resendDays, resendPassword, {
      card: resendCard, actorHasPassword, wake,
      landed: (answer) => {
        resendOpen = false;
        resendPassword = "";
        spent();
        if (delivery?.userId === person.id) delivery = { ...answer, userId: person.id };
      },
    });
  }

  /* Placing a person in a system (§11, #453): the systems are the rows. */
  /** @type {Person | null} */
  let placing = $state(null);
  let placeOpen = $state(false);
  /** @param {System} system */
  async function placeIn(system) {
    const person = placing;
    if (!person) return;
    placeOpen = false;
    await placePerson(person, system, { card: peopleCard, reread, wake });
  }

  /**
   * The acts behind a person's row (§2.12, review round §2.6): a tap opens
   * it. None on your own row, and none on any row while the session read
   * failed, since which row is yours is then unknown. Each keeps its full
   * accessible name.
   * @param {Person} person
   * @returns {import('$lib/pocket/row.js').RowAct[]}
   */
  const personActs = (person) => person.id === meId || view?.failed.session ? [] : [
    { label: "place", name: `Place ${person.displayName} in a system`, tone: "accent",
      onact: () => { placing = person; placeOpen = true; } },
    { label: "link", name: `Send ${person.displayName} a new setup link`, tone: "accent",
      onact: () => openResend(person) },
    person.disabledAt
      ? { label: "enable", name: `Enable ${person.displayName}`, tone: "ok", onact: () => disable(person, false) }
      /* §2.6: disable arms. The wake still offers undo (§1.13) once it has
         fired. */
      : { label: "disable", name: `Disable ${person.displayName}`, arms: true, onact: () => disable(person, true) },
  ];

  /** @param {Person} person @param {boolean} off */
  const disable = (person, off) => setDisabled(person, off, { card: peopleCard, reread, wake });

  /* ── systems ──────────────────────────────────────────────────────────── */
  let systemOpen = $state(false);
  let systemName = $state("");
  let systemPassword = $state("");
  const systemCard = $state(card());
  /** @type {string | null} */
  let systemsProblem = $state(null);

  function openNewSystem() {
    systemsProblem = null;
    challenge("system_create", () => {
      systemName = "";
      systemPassword = "";
      systemCard.problem = null;
      systemOpen = true;
    }, (message) => (systemsProblem = message));
  }

  /** Choosing the owner is the submit, as on the desk (#1052). @param {Person} owner */
  async function createSystemFor(owner) {
    if (systemCard.busy) return;
    if (!systemName.trim()) { systemCard.problem = "name the system first"; return; }
    await makeSystem(systemName.trim(), owner, systemPassword, {
      card: systemCard, actorHasPassword, reread, wake,
      landed: () => {
        const named = systemName.trim();
        systemOpen = false;
        systemPassword = "";
        spent();
        wake(`${named} is made · ${owner.displayName} owns it`);
      },
    });
  }

  /* A system's ring wears its real due-state dots, as on the desk (words.js). */
  /** @param {System} system */
  const dotsOf = (system) => (view ? systemDotsOf(system, view.today) : []);
  /* Round 3 §3.9: members and items at rest; the owner is the panel's. */
  /** @param {System} system */
  const systemMeta = (system) =>
    `${plural(system.memberCount ?? 0, "member")} · ${plural((system.items ?? []).length, "item")}`;

  /* A system on the clock (§2.11, §19 "56 b the row", "57 admin only"). */
  const recoverable = $derived(view?.recoverable ?? []);
  /** What was said on a row after its act, keyed by the system's id. @type {Record<string, { ok: boolean, text: string }>} */
  let clockSaid = $state({});
  /** @typedef {{ id: string, name: string, deleteAfter: string }} OnTheClock */
  let doomed = $state(/** @type {OnTheClock | null} */ (null));
  let doomOpen = $state(false);
  let typedName = $state("");
  /** @type {string | null} */
  let doomProblem = $state(null);
  const nameOk = $derived(doomed ? deletionNameMatches(typedName, doomed.name) : false);
  async function deleteNow() {
    const row = doomed;
    if (!row) return;
    doomProblem = null;
    await deleteSystemNow(row, typedName, {
      gone, reread, wake,
      landed: () => (doomOpen = false),
      refused: (words) => (doomProblem = `not deleted — ${words}`),
    });
  }
  /** Rows replaced by their said-line after a hard delete, keyed by the system's id. */
  let gone = $state(/** @type {Record<string, string>} */ ({}));
  /** @param {{ id: string, name: string, deleteAfter: string }} row @returns {import('$lib/pocket/row.js').RowAct[]} */
  const clockActs = (row) => [
    { label: "delete now", name: `Delete ${row.name} now, for good`, danger: true,
      onact: () => { doomed = row; typedName = ""; doomProblem = null; doomOpen = true; } },
  ];

  /* ── public contact (#860) ────────────────────────────────────────────── */
  let contactOpen = $state(false);
  let contactDraft = $state("");
  const contactCard = $state(card());
  function openContact() {
    contactDraft = view?.contact?.address ?? "";
    contactCard.problem = null;
    contactOpen = true;
  }
  /** The sheet closes once the command lands. @param {{ action: "set", address: string } | { action: "clear" }} partial */
  const sendContact = (partial) =>
    setContact(view?.contact, partial, { card: contactCard, reread, wake, landed: () => (contactOpen = false) });

  /* ── upload size limit (#1285) ───────────────────────────────────────── */
  let uploadLimitOpen = $state(false);
  /** @type {number | null} */
  let uploadLimitDraft = $state(null);
  const uploadLimitCard = $state(card());
  function openUploadLimit() {
    const current = view?.uploadLimit;
    uploadLimitDraft = current ? Math.round(current.maxBytes / 1048576) : null;
    uploadLimitCard.problem = null;
    uploadLimitOpen = true;
  }
  /* The sheet closes once the command lands; a failed re-read after it is
     woken as done-but-unread, as every act here does ($lib/data/landed.js). */
  /** @param {{ action: "set", megabytes: number } | { action: "default" }} partial */
  const sendUploadLimit = (partial) => setUploadLimit(view?.uploadLimit, partial, {
    card: uploadLimitCard, reread, wake,
    landed: () => (uploadLimitOpen = false),
  });

  /* ── exports kept (#1792): one sheet, three inputs, the mail limit's foot ─ */
  let archiveStorageOpen = $state(false);
  /** @type {{ retentionHours: number | null, keepPerHousehold: number | null, maxTotalGigabytes: number | null }} */
  let archiveStorageDraft = $state({ retentionHours: null, keepPerHousehold: null, maxTotalGigabytes: null });
  const archiveStorageCard = $state(card());
  function openArchiveStorage() {
    const current = view?.archiveStorage;
    archiveStorageDraft = current
      ? { retentionHours: current.retentionHours, keepPerHousehold: current.keepPerHousehold, maxTotalGigabytes: Math.max(1, Math.round(current.maxTotalBytes / 1073741824)) }
      : { retentionHours: null, keepPerHousehold: null, maxTotalGigabytes: null };
    archiveStorageCard.problem = null;
    archiveStorageOpen = true;
  }
  /** @param {{ action: "set", retentionHours: number, keepPerHousehold: number, maxTotalGigabytes: number } | { action: "default" }} partial */
  const sendArchiveStorage = (partial) => setArchiveStorage(view?.archiveStorage, partial, {
    card: archiveStorageCard, reread, wake,
    landed: () => (archiveStorageOpen = false),
  });
  const archiveStorageOverridden = $derived(Object.values(view?.archiveStorage?.overrides ?? {}).some((value) => value !== null));

  /* ── mail size limit (#1388): the upload limit's sheet, with the mail
     numbers (1 to 50 MB, default 25 MB) ────────────────────────────────── */
  let mailLimitOpen = $state(false);
  /** @type {number | null} */
  let mailLimitDraft = $state(null);
  const mailLimitCard = $state(card());
  function openMailLimit() {
    const current = view?.mailLimit;
    mailLimitDraft = current ? Math.round(current.maxBytes / 1048576) : null;
    mailLimitCard.problem = null;
    mailLimitOpen = true;
  }
  /** @param {{ action: "set", megabytes: number } | { action: "default" }} partial */
  const sendMailLimit = (partial) => setMailLimit(view?.mailLimit, partial, {
    card: mailLimitCard, reread, wake,
    landed: () => (mailLimitOpen = false),
  });

  /* ── the Mail card's mailbox (#743) ──────────────────────────────────── */
  /* `busy` names the button that is out. */
  const mailCard = $state({
    busy: /** @type {string | null} */ (null),
    problem: /** @type {string | null} */ (null),
    outcome: /** @type {string | null} */ (null),
    fetched: /** @type {{ messagesRead: number, receiptsRecorded: number, reasons: Record<string, number>, reason?: string | null } | null} */ (null),
  });
  let mailPassword = $state("");
  let rotateOpen = $state(false);
  let editOpen = $state(false);
  let mailDraft = $state(blankMailDraft());
  /* #1468: the provider profile is a pressed value that stands the chooser card's tiles as a sheet */
  let providerOpen = $state(false);
  /** @param {boolean} refocus */
  function closeProvider(refocus) {
    providerOpen = false;
    if (refocus) tick().then(() => document.getElementById("ad-mb-provider")?.focus({ preventScroll: true }));
  }
  /** The page behind the chooser sheet is inert while it stands. @param {HTMLElement} seat */
  function holdSeat(seat) {
    const restore = inertPage(seat);
    return { destroy: restore };
  }

  function openMailEditor() {
    const current = view?.mailbox;
    if (current?.configured) mailDraft = mailDraftOf(current);
    mailPassword = "";
    mailCard.problem = null;
    editOpen = true;
  }

  /**
   * One mailbox action (./acts.svelte.js). A refused credential keeps its
   * sheet open, minus the password.
   * @param {string} label @param {object} command
   */
  const mailAction = (label, command) => commandMail(label, command, {
    card: mailCard, reread,
    landed: (closes) => {
      if (closes) { editOpen = false; rotateOpen = false; }
      mailPassword = "";
    },
  });
  const mailOk = $derived(mailCard.outcome === "verified" || mailCard.outcome === "delivered" || mailCard.outcome === "fetched");

  /* The two tests (#1071): the server remembers each one's last answer
     (owner, 2026-09-19: "the server remembers the last mail-test result
     so the pill survives a reload — Yes") — read the same way the desk
     layout reads it, off the screen's own re-read, rather than the
     throwaway local copy this used to keep, which forgot everything on a
     reload (#1151 A1-Q6). */
  /** The default for testRow's argument, which gives the snippet its type
   * without a type comment in the markup (the Rolldown trap). */
  const MAILBOX_TEST = /** @type {"mailbox" | "relay"} */ ("mailbox");
  /* Why this start could not copy the SMTP_* lines (#1629): null once
     sending is set, or when there was nothing to copy. */
  const importSkipped = $derived(view?.operations?.mailSending?.importSkipped ?? null);
  const mailProbes = $derived(view?.operations?.mailProbes ?? { mailbox: null, relay: null });
  /* `busy` names the test that is out. */
  const testCard = $state({ busy: /** @type {"mailbox" | "relay" | null} */ (null), problem: /** @type {string | null} */ (null) });

  /* ── the Mail card's sending (#1629, direction J) ────────────────────────
     The editor is a sheet, like the mailbox's. The password is write-only:
     typed, sent once, cleared, never read back. */
  const sendCard = $state({ busy: false, problem: /** @type {string | null} */ (null), outcome: /** @type {string | null} */ (null) });
  let sendOpen = $state(false);
  let sendPassword = $state("");
  let sendDraft = $state(blankSendDraft(null));

  /** Picks the security, moving the port with it while it still holds the
   * other choice’s usual port (587 STARTTLS, 465 TLS).
   * @param {"starttls" | "implicit_tls"} security */
  function pickSecurity(security) {
    const usual = { starttls: 587, implicit_tls: 465 };
    const other = security === "starttls" ? "implicit_tls" : "starttls";
    if (Number(sendDraft.port) === usual[other]) sendDraft.port = usual[security];
    sendDraft.security = security;
  }

  function openSendEditor() {
    const current = view?.sending;
    const mailbox = view?.mailbox;
    sendDraft = current?.via ? sendDraftOf(current) : blankSendDraft(mailbox?.configured ? mailbox : null);
    sendPassword = "";
    sendCard.outcome = null;
    sendCard.problem = null;
    sendOpen = true;
  }

  function submitSending() {
    const sender = { senderName: sendDraft.senderName, senderAddress: sendDraft.senderAddress };
    const expectedVersion = view?.sending?.version ?? null;
    const command = sendDraft.via === "mailbox"
      ? { action: /** @type {const} */ ("set"), expectedVersion, via: /** @type {const} */ ("mailbox"), ...sender }
      : {
          action: /** @type {const} */ ("set"), expectedVersion, via: /** @type {const} */ ("account"),
          host: sendDraft.host, port: Number(sendDraft.port), security: sendDraft.security, user: sendDraft.user,
          password: sendPassword, ...sender,
        };
    saveSending(command, {
      card: sendCard, reread, wake,
      landed: (closes) => { if (closes) sendOpen = false; sendPassword = ""; },
    });
  }

  /* Rotate every address (§2.12 7): the administrator chooses how long the
     old addresses keep working, 0 to 90 days, starting at the relay's own
     standard grace (words.js's ALIAS_GRACE_DAYS). */
  let aliasOpen = $state(false);
  let graceDays = $state(ALIAS_GRACE_DAYS);
  /** @param {number} by */
  const graceStep = (by) => (graceDays = Math.min(90, Math.max(0, graceDays + by)));

  /* ── document jobs (#1071) ───────────────────────────────────────────── */
  /** @type {import("./words.js").Retried} */
  let retried = $state({});
  const jobs = $derived(jobsOf(view?.operations?.documentJobs ?? [], retried));
  const jobCounts = $derived(jobCountsOf(jobs));
  const clock = $derived(view?.now ?? new Date().toISOString());
  const jobsCard = $state(card());

  /* ── operations (#1000) ───────────────────────────────────────────────── */
  /** @type {Record<string, string>} */
  const BODY = { ok: "ok", warm: "soon", overdue: "over", "ink-quiet": "ended" };
  /* The band's token from BAND_VAR, in its text-safe variant (--ok-text,
     --warm-text, --overdue-text exist in every pack, packs.css). */
  /** @param {string} band */
  const bandText = (band) => `var(${BAND_VAR[band]}-text)`;
  /** @type {Record<string, string>} */
  const INK = {
    ok: bandText("ok"),
    warm: bandText("due-soon"),
    overdue: bandText("overdue"),
    "ink-quiet": "var(--ink-quiet)",
  };
  /** "healthy · 40s ago" → the word on the trail, the rest as the meta. @param {string} detail */
  const split = (detail) => {
    const [word, ...rest] = detail.split(" · ");
    return { word, rest: rest.join(" · ") };
  };
  /** @type {number | null} */
  let serviceAt = $state(null);
  let serviceOpen = $state(false);
  const service = $derived(serviceAt === null || !view ? null : view.services?.[serviceAt] ?? null);
  const serviceRaw = $derived(serviceAt === null ? null : view?.health?.services[serviceAt] ?? null);

  /* ── sign-in providers (#1676, ADR-0041 §6): the desk's card, on the phone ───
     The state is ./providers.js; the read and the post (readProviderLinks,
     removeProviderLinks) are ./acts.svelte.js, shared with the desk; this is
     the same card in the pocket's dialect, its confirm and result in place
     under the row (design/v19/provider-removal/round-3). The two-tap is the kit's
     ArmButton, so there is no arm of our own to disarm. */
  const providers = $state(providerState());
  const noArm = { disarm() {} };
  let providersGone = false;
  onMount(() => {
    if (!fixtures) loadProviders(providers, () => providersGone);
    return () => { providersGone = true; };
  });
  /** "send again" is the person's own "new setup link" sheet. @param {string} userId */
  function sendAgain(userId) {
    const person = people.find((one) => one.id === userId);
    if (person) openResend(person);
  }

  /* Under fixtures `?localuser=` names a delivery, as on the desk, so both
     outcomes of an invitation can be photographed (#915). */
  onMount(() => {
    if (!fixtures) return;
    const wanted = new URLSearchParams(location.search).get("localuser");
    if (wanted) delivery = /** @type {any} */ (SETUP_LINK_FIXTURES)[wanted] ?? SETUP_LINK_FIXTURES.sent;
  });
  /* Back from the identity provider with a proof: pick the errand up where
     it was left (#1151 A1-F2) — one sheet per intent, the same way the
     desk reopens its own form under each. `system_create` has nothing
     typed to restore yet (the challenge fires before the name field is
     ever shown), so reopening empty is already the fix; `setup_link_issue`
     needs the person back, carried from the desk's sessionStorage draft
     since this layout's own `resendFor` is a whole Person, not an id. */
  $effect(() => {
    if (!view) return;
    if (provenIntent === "local_user_create") inviteOpen = true;
    if (provenIntent === "system_create") { systemName = ""; systemOpen = true; }
    if (provenIntent === "setup_link_issue" && resumedResendPersonId) {
      const person = view.users?.find((one) => one.id === resumedResendPersonId);
      if (person) {
        resendFor = person;
        resendDays = SETUP_LINK_DAYS.fallback;
        resendPassword = "";
        resendOpen = true;
      }
    }
  });
</script>

<div class="ad-pocket">
  <main class="ad-column">
    <header class="ad-head p-land" style:--i="0">
      <svg class="ad-glyph" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
        <circle class="ad-orbit" cx="28" cy="28" r="22" fill="none"/>
        <circle class="ad-orbit soft" cx="28" cy="28" r="14" fill="none"/>
        <circle cx="28" cy="28" r="3" style="fill:var(--sun)"/>
        <g class="ad-craft">
          <rect x="44" y="26.6" width="12" height="2.8" rx=".6"/>
          <rect x="48.6" y="21.5" width="2.8" height="13" rx=".6" class="ad-array"/>
        </g>
      </svg>
      <div class="ad-named">
        <h1 class="p-title">Administration</h1>
        <p class="ad-sub">{view ? `${view.users ? `${plural(people.length, "person", "people")} · ` : ""}${plural(systems.length, "system")}` : ""}</p>
      </div>
    </header>

    {#if tells.length}
      <nav class="ad-tells p-land" style:--i="0" aria-label="Needs you">
        {#each tells as tell (tell.word)}
          <a class="ad-tell" href="#{tell.id}" onclick={(event) => jump(event, tell.id)}>{tell.word}</a>
        {/each}
      </nav>
    {/if}

    <!-- THE JUMP STRIP (§2.12): the one page that has one, because it is the
         longest screen. Anchors, not tabs: nothing is selected, and each is a
         plain link that works without script. -->
    <nav class="ad-jump p-land" style:--i="1" aria-label="Jump to a card">
      {#each JUMPS as [word, id], i (id)}
        <a class="ad-chip" href="#{id}" style:--j={i} onclick={(event) => jump(event, id)}><span>{word}</span></a>
      {/each}
    </nav>

    {#if screenProblem && !view}
      <section class="p-card ad-card" aria-label="Administration">
        <p class="p-error ad-inset ad-lastline" role="alert">{screenProblem}
          {#if !screenRefused}<button class="p-pill filled" onclick={onretry}>try again</button>{/if}</p>
      </section>
    {:else if !view}
      <section class="p-card ad-card ad-loading" aria-label="Loading administration">
        <div class="p-unlit"></div><div class="p-unlit"></div><div class="p-unlit"></div>
      </section>
    {:else}
      {#if view.failed.rotation || view.failed.metadata || view.failed.recoveryBundle}
        <section class="ad-alerts" aria-label="Alerts not shown" data-ad="alerts-failed">
          {#if view.failed.rotation}
            <p class="p-error ad-inset ad-lastline" role="alert">key rotation not shown — Orbit could not reach its status{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
          {/if}
          {#if view.failed.metadata}
            <p class="p-error ad-inset ad-lastline" role="alert">encrypted-details health not shown — Orbit could not reach it{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
          {/if}
          {#if view.failed.recoveryBundle}
            <p class="p-error ad-inset ad-lastline" role="alert">recovery bundle status not shown — Orbit could not reach it{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
          {/if}
        </section>
      {/if}
      {#if alerts.length}
        <section class="ad-alerts" aria-label="Alerts" data-ad="alerts">
          {#each alerts as alert, i (alert.id)}
            <article class="p-card ad-alert" style:--i={2 + i} aria-labelledby="ad-alert-{alert.id}">
              <h2 class="ad-alert-head" id="ad-alert-{alert.id}">
                <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
                  <path d="M9 2.2 16.4 15H1.6L9 2.2Z"/><path d="M9 6.6v4.1"/><path d="M9 12.8v.05"/>
                </svg>{alert.title}</h2>
              <p class="p-prose ad-alert-say">{alert.say}</p>
              <button class="p-pill act-warm wide" onclick={() => { reading = alert; readingOpen = true; }}>what to do</button>
            </article>
          {/each}
        </section>
      {/if}

      <!-- PEOPLE (§2.12 4). -->
      <section class="p-card ad-card ad-flush" class:proposed={!view.failed.users && people.length <= 1} style:--i="3"
               id="ad-people" tabindex="-1" aria-labelledby="ad-people-head" data-ad="people" data-row-group>
        <div class="ad-cardhead">
          <h2 class="p-caps" id="ad-people-head">People{#if view.users}<span class="p-count">{people.length}</span>{/if}</h2>
          <button class="p-pill act-accent" onclick={openInvite}>invite someone</button>
        </div>
        {#if delivery?.sendError}
          <div class="ad-said warn" role="status">
            <p>{delivery.sentTo} was created, but {sendWords(delivery.sendError)}</p>
            {#if delivery.userId}
              {@const who = people.find((one) => one.id === delivery?.userId)}
              {#if who}<button class="p-pill act-accent" onclick={() => openResend(who)}>retry</button>{/if}
            {/if}
          </div>
        {:else if delivery}
          <p class="ad-said ok" role="status">setup link sent · lapses {lapsesShort(delivery.expiresAt)}</p>
        {/if}
        {#each people as person (person.id)}
          {@const standing = person.disabledAt ? "disabled" : view.peopleMeta[person.id]}
          <!-- Round 3 §3.9: the email alone at rest (R5's one exception);
               the systems they are in are the panel's first line. -->
          {#snippet personDetail()}<div class="p-kv"><span>{standing}</span></div>{/snippet}
          <Row title="{person.displayName}{person.id === meId ? ' · you' : ''}"
               meta={person.email}
               trail={person.isInstanceAdmin ? "admin" : "user"}
               trailTone={person.isInstanceAdmin ? "var(--accent-text)" : ""} acts={personActs(person)}
               detail={standing ? personDetail : undefined}>
            {#snippet mark()}<span class="p-avatar" class:owner={person.isInstanceAdmin} class:ad-off={person.disabledAt}>{initials(person.displayName)}</span>{/snippet}
          </Row>
        {/each}
        {#if view.failed.session}
          <p class="p-error ad-inset ad-lastline" role="alert">your own row not marked and people's actions hidden — Orbit could not confirm who is signed in{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
        {/if}
        {#if view.failed.users}
          <p class="p-error ad-inset ad-lastline" role="alert">people not shown — Orbit could not reach the list of people{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
        {:else}
          {#if people.length <= 1}<p class="p-empty ad-inset">only you so far</p>{/if}
        {/if}
        {#if peopleCard.problem}<p class="p-error ad-inset ad-lastline" role="alert">{peopleCard.problem}</p>{/if}
      </section>

      <!-- SYSTEMS (§2.12 5). -->
      <section class="p-card ad-card ad-flush" class:proposed={systems.length === 0} style:--i="4"
               id="ad-systems" tabindex="-1" aria-labelledby="ad-systems-head" data-ad="systems" data-row-group>
        <div class="ad-cardhead">
          <h2 class="p-caps" id="ad-systems-head">Systems<span class="p-count">{systems.length}</span></h2>
          <button class="p-pill act-accent" onclick={openNewSystem}>new system</button>
        </div>
        {#each systems as system (system.id)}
          {#snippet systemDetail()}<div class="p-kv"><span>owner</span><b>{view?.owners[system.id]}</b></div>{/snippet}
          <Row title={system.name} meta={systemMeta(system)}
               detail={view.owners[system.id] ? systemDetail : undefined}>
            {#snippet mark()}
              <svg class="ad-ring" width="30" height="30" viewBox="0 0 34 34" aria-hidden="true">
                <circle cx="17" cy="17" r="13" fill="none" style="stroke:var(--chart-line)"/>
                <circle cx="17" cy="17" r="2.6" style="fill:var({system.id === view.primary ? '--sun' : '--ink-mid'})"/>
                {#each dotsOf(system) as dot (dot.cx + "-" + dot.cy)}
                  <circle cx={dot.cx} cy={dot.cy} r={dot.r} style="fill:var({dot.tone})" opacity=".85"/>
                {/each}
              </svg>
            {/snippet}
          </Row>
        {:else}
          {#if !recoverable.length}<p class="p-empty ad-inset">no systems yet</p>{/if}
        {/each}
        {#if view.failed.owners}
          <p class="p-error ad-inset ad-lastline" role="alert">owners not shown — Orbit could not reach every system’s members{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
        {/if}
        {#each Object.entries(gone) as [id, text] (id)}
          <p class="ad-said ok" role="status">{text}</p>
        {/each}
        <!-- ON THE CLOCK (§2.11, §19): the system's own row carries the state;
             `restore` stays on show because it is the point of the row, and
             `delete now` sits in the row's opened panel (§1.1). Never on the
             household page. -->
        {#each recoverable.filter((row) => !gone[row.id]) as row (row.id)}
          <!-- Round 3 §3.9: the state and the days at rest; the date sits in
               the panel beside `delete now`. -->
          {#snippet clockDetail()}<div class="p-kv"><span>gone for good</span><b>{dayMonth(row.deleteAfter)}</b></div>{/snippet}
          <Row title={row.name} metaFace="ui"
               meta={expired(row, view?.now) ? "past its window · removing"
                 : `deleted · ${plural(daysLeft(row.deleteAfter, view?.now), "day")} left`}
               acts={expired(row, view?.now) ? [] : clockActs(row)} detail={expired(row, view?.now) ? undefined : clockDetail}>
            {#snippet mark()}
              <svg class="ad-ring ad-clockring" width="30" height="30" viewBox="0 0 34 34" aria-hidden="true">
                <circle cx="17" cy="17" r="13" fill="none"/>
                <circle cx="17" cy="17" r="2.6"/>
              </svg>
            {/snippet}
            {#snippet below()}
              {#if clockSaid[row.id]}
                <p class="ad-clocksaid" class:bad={!clockSaid[row.id].ok} role="status">{clockSaid[row.id].text}</p>
              {/if}
              {#if !expired(row, view?.now)}
                <ArmButton label="restore" armedLabel="tap again to restore {row.name}" name="Restore {row.name}"
                           danger={false} class="act-accent" onfire={() => restoreSystem(row, clockSaid, reread)} />
              {/if}
            {/snippet}
          </Row>
        {/each}
        {#if systemsProblem}<p class="p-error ad-inset ad-lastline" role="alert">{systemsProblem}</p>{/if}
      </section>

      <!-- SIGN-IN PROVIDERS (#1676, ADR-0041 §6, round 3 "the one line"): the desk's
           card on the phone. A .kv row per provider that is off with links left,
           the confirm in place under it, problem lines. Absent when there is
           nothing to remove. -->
      {#if providerRows(providers).length}
        <section class="p-card ad-card ad-flush" style:--i="4" id="providers-card" tabindex="-1" aria-labelledby="ad-prov-head" data-ad="providers">
          <div class="cardhead"><h2 class="p-caps" id="ad-prov-head">Sign-in providers</h2></div>
          {#each providerRows(providers) as row (row.issuer)}
            {@const provider = row.provider}
            {@const done = row.done}
            <div class="kv">
              <span>{providerHost(row.issuer)}</span>
              {#if done}
                {#if done.count === 1}<span><b class="on">removed</b> &middot; 1 link &middot; {done.at} today</span>
                {:else}<span><b class="on">removed</b> &middot; {done.count} links &middot; {done.at} today</span>{/if}
              {:else if provider}
                {@const openIt = () => openConfirm(providers, provider)}
                <span><b>off</b> &middot; {provider.members.length} linked &middot; {provider.stranded.length} without a password</span>
                {#if canRemove(providers)}
                  <button class="p-pill" onclick={openIt}>remove links&hellip;</button>
                {:else if providers.links?.viewerIsPrimary}
                  <span class="note"><a href="/settings#sign-in-methods">set a password in Settings first</a></span>
                {:else}
                  <span class="note">only the primary administrator, {providers.links?.primary?.displayName}, can do this</span>
                {/if}
              {/if}
            </div>
            {#if provider && providers.refusal === row.issuer}
              {@const needy = provider.stranded.map((one) => one.displayName)}
              <p class="p-error ad-inset" role="alert">not started &mdash; outgoing mail isn&rsquo;t set up, and
                {#if needy.length > 1}{namesOf(needy)} need a setup link. Set it up under <a class="ad-link" href="#ad-mail">Mail</a> first.
                {:else}{needy[0]} needs a setup link. Set it up under <a class="ad-link" href="#ad-mail">Mail</a> first.{/if}</p>
            {/if}
            {#if provider && providers.open === row.issuer}
              {@const needy = provider.stranded.map((one) => one.displayName)}
              {@const cancel = () => closeConfirm(providers, noArm)}
              {@const fire = () => removeNow(providers, noArm, provider)}
              <form class="mailboxform" onsubmit={(event) => event.preventDefault()}>
                <p class="mailboxnote">
                  {#if needy.length === 1}{needy[0]} has no password, so a setup link is mailed, good for {SETUP_LINK_DAYS.fallback} days.
                  {:else if needy.length > 1}{namesOf(needy)} have no password, so each is mailed a setup link good for {SETUP_LINK_DAYS.fallback} days.{/if}
                  {#if signedOutToo(providers, provider, view)}You signed in through it today, so you&rsquo;ll be signed out too.{/if}
                </p>
                <label>your password
                  <input class="p-input" type="password" autocomplete="current-password" enterkeyhint="done" bind:value={providers.password} required /></label>
                <div class="mailboxrow">
                  <ArmButton wide class="dangerbtn" disabled={providers.card.busy || providers.password === ""}
                             label={provider.members.length === 1 ? "remove 1 link" : `remove ${provider.members.length} links`}
                             armedLabel="tap again to remove {provider.members.length} links"
                             onfire={fire} />
                  <button type="button" class="p-pill" onclick={cancel}>cancel</button>
                </div>
              </form>
            {/if}
            {#if done}
              {#if done.sent > 0}
                <p class="ad-sent ad-inset">
                  {#if done.sent === done.planned}
                    {#if done.planned === 1}Setup link sent to 1 person{:else}Setup links sent to {done.planned} people{/if}, valid until {done.until}
                  {:else if done.sent === 1}Setup link sent to {done.sent} of {done.planned} people, valid until {done.until}
                  {:else}Setup links sent to {done.sent} of {done.planned} people, valid until {done.until}{/if}
                </p>
              {/if}
              {#each done.notMailed as one (one.userId)}
                {@const again = () => sendAgain(one.userId)}
                <p class="p-error ad-inset" role="alert">{one.name} not sent &mdash; {notMailedWords(one.reason)}<button class="retry p-pill" onclick={again}>send again</button></p>
              {/each}
            {/if}
          {/each}
          {#if providers.card.problem}<p class="p-error ad-inset" role="alert">{providers.card.problem}</p>{/if}
        </section>
      {/if}

      <!-- PUBLIC CONTACT (§2.12 6, #860). -->
      <section class="p-card ad-card ad-flush" style:--i="5" id="ad-contact" tabindex="-1"
               aria-labelledby="ad-contact-head" data-ad="contact">
        <div class="ad-cardhead"><h2 class="p-caps" id="ad-contact-head">Public contact</h2></div>
        {#if view.contact}
          <Row title={view.contact.address ?? "not set"}
               trail={view.contact.address ? "change" : "set"} trailTone="var(--accent-text)"
               trailName={view.contact.address ? "change the public contact" : "set the public contact"}
               onactivate={openContact}>
            {#snippet mark()}<span class="ad-kmark">@</span>{/snippet}
          </Row>
        {:else if view.failed.contact}
          <p class="p-error ad-inset ad-lastline" role="alert">not shown — Orbit could not reach the public contact{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
        {:else}
          <p class="p-empty ad-inset">not set</p>
        {/if}
      </section>

      <!-- UPLOAD SIZE LIMIT (#1285): absent where the route cannot answer. -->
      {#if view.failed.uploadLimit}
        <section class="p-card ad-card ad-flush" style:--i="5" id="ad-uploads" tabindex="-1"
                 aria-labelledby="ad-uploads-head" data-ad="uploads">
          <div class="ad-cardhead"><h2 class="p-caps" id="ad-uploads-head">Upload size limit</h2></div>
          <p class="p-error ad-inset ad-lastline" role="alert">not shown — Orbit could not reach the upload limit{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
        </section>
      {/if}
      {#if view.uploadLimit}
        {@const limit = view.uploadLimit}
        <section class="p-card ad-card ad-flush" style:--i="5" id="ad-uploads" tabindex="-1"
                 aria-labelledby="ad-uploads-head" data-ad="uploads">
          <div class="ad-cardhead"><h2 class="p-caps" id="ad-uploads-head">Upload size limit</h2></div>
          <Row title={megabytes(limit.maxBytes)}
               meta={limit.overrideBytes === null ? "the default" : "set here"}
               trail="change" trailTone="var(--accent-text)" trailName="change the upload size limit"
               onactivate={openUploadLimit}>
            {#snippet mark()}<span class="ad-kmark">↑</span>{/snippet}
          </Row>
          <p class="ad-note ad-inset ad-lastline">A reverse proxy in front of Orbit must allow uploads at least this large —
            <a href="https://github.com/tomlawesome/orbit/blob/main/docs/installing.md#what-you-need" target="_blank" rel="noopener noreferrer">see the install guide</a>.</p>
        </section>
      {/if}

      <!-- EXPORTS KEPT (#1792): how long, how many per system, how much space. -->
      {#if view.failed.archiveStorage}
        <section class="p-card ad-card ad-flush" style:--i="5" id="ad-archives" tabindex="-1"
                 aria-labelledby="ad-archives-head" data-ad="archives">
          <div class="ad-cardhead"><h2 class="p-caps" id="ad-archives-head">Exports kept</h2></div>
          <p class="p-error ad-inset ad-lastline" role="alert">not shown — Orbit could not reach the export settings{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
        </section>
      {/if}
      {#if view.archiveStorage}
        <section class="p-card ad-card ad-flush" style:--i="5" id="ad-archives" tabindex="-1"
                 aria-labelledby="ad-archives-head" data-ad="archives">
          <div class="ad-cardhead"><h2 class="p-caps" id="ad-archives-head">Exports kept</h2></div>
          <Row title="Exports kept"
               meta={exportsKeptShort(view.archiveStorage, " per system")}
               trail="change" trailTone="var(--accent-text)" trailName="change the export settings"
               onactivate={openArchiveStorage}>
            {#snippet mark()}<span class="ad-kmark">↓</span>{/snippet}
          </Row>
        </section>
      {/if}

      <!-- MAIL (§2.12 7, §15, #743; one card, #1629 direction J): the
           Mailbox, then Sending, the two tests in the head. -->
      <section class="p-card ad-card ad-flush" style:--i="6" id="ad-mail" tabindex="-1"
               aria-labelledby="ad-mail-head" data-ad="mail">
        <div class="ad-cardhead">
          <h2 class="p-caps" id="ad-mail-head">Mail</h2>
          <div class="p-pills ad-headpills">
            <button class="p-pill act-accent" disabled={testCard.busy !== null} onclick={() => runMailTest("mailbox", { card: testCard, reread })}>test this mailbox</button>
            <button class="p-pill act-accent" disabled={testCard.busy !== null} onclick={() => runMailTest("relay", { card: testCard, reread })}>test outgoing mail</button>
          </div>
        </div>
        {#snippet testRow(which = MAILBOX_TEST)}
          {@const probe = mailProbes[which]}
          {@const verdict = probe ? testVerdict(probe.result) : null}
          <Row title={which === "mailbox" ? "mailbox test" : "outgoing mail test"} metaFace="ui" meta={testMetaOf(which, testCard.busy, mailProbes)}>
            {#snippet mark()}<span class="p-body {testCard.busy === which ? 'up breathing' : verdict?.tone ?? 'ended'}"></span>{/snippet}
            {#snippet end()}
              {#if verdict || testCard.busy === which}
                <span class="ad-state {testCard.busy === which ? 'up ad-checking' : verdict?.tone ?? ''}">{testCard.busy === which ? "checking…" : verdict?.word}</span>
              {/if}
            {/snippet}
          </Row>
        {/snippet}
        <p class="p-caps ad-inset">Mailbox</p>
        {#if view.failed.relay}
          <p class="p-error ad-inset ad-lastline" role="alert">not shown — Orbit could not reach the mail settings{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
        {/if}
        {#each view.relay ?? [] as [label, value, extra] (label)}
          <Row title={label} meta={label === "ingest" ? ingestShort(value) : value} trail={extra === "on" ? "on" : ""} trailTone="var(--ok-text)">
            {#snippet mark()}<span class="p-body {extra === 'on' ? 'ok' : 'ended'}"></span>{/snippet}
          </Row>
        {/each}
        <!-- The mailbox test after the mailbox's own rows (#1629, J). -->
        {@render testRow("mailbox")}
        {#if testCard.problem}<p class="p-error ad-inset ad-lastline" role="alert">{testCard.problem}</p>{/if}
        {#if view.mailbox?.configured}
          <Row title="every address"
               trail="rotate" trailTone="var(--warm-text)" trailName="rotate every address"
               onactivate={() => { graceDays = ALIAS_GRACE_DAYS; mailCard.problem = null; aliasOpen = true; }}>
            {#snippet mark()}<span class="ad-kmark">↻</span>{/snippet}
          </Row>
        {/if}
        <!-- #1388: the mail size limit, a mailbox fact, after the mailbox rows. -->
        {#snippet mailLimitRow()}
          {#if view.failed.mailLimit}
            <p class="p-error ad-inset" role="alert">largest message not shown — Orbit could not reach the mail limit{stillNoAnswer ? " (tried again, still no answer)" : ""}
              <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
          {/if}
          {#if view.mailLimit}
            <Row title="largest message"
                 meta="{megabytes(view.mailLimit.maxBytes)} · {view.mailLimit.overrideBytes === null ? 'the default' : 'set here'}"
                 trail="change" trailTone="var(--accent-text)" trailName="change the largest mail message"
                 onactivate={openMailLimit}>
              {#snippet mark()}<span class="ad-kmark">↓</span>{/snippet}
            </Row>
          {/if}
        {/snippet}
        {#if view.mailbox}
          {@const mailbox = view.mailbox}
          <Row title="verification" meta="{plainly(mailbox.verificationState)} · {shortDay(mailbox.verifiedAt)}"
               trail={mailbox.verificationState === "verified" ? "passed" : mailbox.verificationState === "failed" ? "failed" : ""}
               trailTone={mailbox.verificationState === "failed" ? "var(--overdue-text)" : "var(--ok-text)"}>
            {#snippet mark()}<span class="p-body {mailbox.verificationState === 'verified' ? 'ok' : mailbox.verificationState === 'failed' ? 'over' : 'ended'}"></span>{/snippet}
          </Row>
          {#each failedHalvesOf(mailbox.health) as said (said)}
            <p class="ad-said warn ad-inset" role="alert">{said} · the server log names the reason</p>
          {/each}
          {#if mailbox.configured}
            {#each [
              ["credential set", `${shortDay(mailbox.credentialSetAt)}${mailbox.credentialSetBy ? ` · ${mailbox.credentialSetBy}` : ""}`],
              ["address shape", mailbox.aliasPattern ?? "—"],
              ["envelope header", mailbox.trustedRecipientHeader || "not set"],
              ["provider profile", mailbox.providerProfile],
              ["tls name", mailbox.tlsServerName || mailbox.host],
            ] as [label, value] (label)}
              <Row title={label} meta={value}>
                {#snippet mark()}<span class="p-body ended"></span>{/snippet}
              </Row>
            {/each}
            {@render mailLimitRow()}
            <div class="ad-foot">
              <div class="p-pills">
                <button class="p-pill act-accent" disabled={mailCard.busy !== null || fetchNowRefusal(mailbox) !== ""}
                        onclick={() => mailAction("fetch", { action: "fetch_now" })}>{mailCard.busy === "fetch" ? "fetching…" : "fetch now"}</button>
                <button class="p-pill act-accent" onclick={openMailEditor}>change mailbox</button>
                <button class="p-pill act-accent" disabled={mailCard.busy !== null}
                        onclick={() => mailAction("probe", { action: "probe" })}>{mailCard.busy === "probe" ? "probing…" : "run setup probe"}</button>
                <button class="p-pill act-warm" disabled={mailCard.busy !== null}
                        onclick={() => mailAction("enabled", { action: mailbox.enabled ? "disable" : "enable", expectedVersion: mailbox.version })}>
                  {mailbox.enabled ? "pause ingest" : "resume ingest"}</button>
                <button class="p-pill" disabled={mailCard.busy !== null}
                        onclick={() => { mailPassword = ""; mailCard.problem = null; rotateOpen = true; }}>rotate password</button>
              </div>
              <ArmButton label="remove credential" armedLabel="tap again to remove the credential" wide
                         onfire={() => mailAction("remove", { action: "remove", expectedVersion: mailbox.version })} />
            </div>
          {:else}
            {@render mailLimitRow()}
            <div class="ad-foot"><button class="p-pill act-accent wide" onclick={openMailEditor}>set up mailbox</button></div>
          {/if}
        {:else}
          {@render mailLimitRow()}
        {/if}
        {#if mailCard.outcome}<p class="ad-said {mailOk ? 'ok' : 'warn'} ad-lastline" role="status">{mailCard.fetched ? fetchNowWords(mailCard.outcome, mailCard.fetched) : probeWords(mailCard.outcome, view?.mailbox?.providerProfile)}</p>{/if}
        {#if view?.mailbox?.configured && fetchNowRefusal(view.mailbox)}<p class="ad-said ended ad-inset ad-lastline">fetch now is off: {fetchNowRefusal(view.mailbox)}</p>{/if}
        {#if mailCard.problem}<p class="p-error ad-inset ad-lastline" role="alert">{mailCard.problem}</p>{/if}

        <p class="p-caps ad-inset">Sending</p>
        {#if view.failed.sending}
          <p class="p-error ad-inset ad-lastline" role="alert">sending not shown — Orbit could not reach the sending settings{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
        {:else}
          {@const sending = view.sending}
          {#if sending?.via}
            {@const rows = sendingRowsOf(sending, view.now ?? new Date().toISOString())}
            <Row title="sends as" meta={rows.sendsAs}>
              {#snippet mark()}<span class="p-body ended"></span>{/snippet}
            </Row>
            <!-- Two rows, not one wrapped line: a phone meta is one line
                 and never trimmed (Row, R8). -->
            <Row title="via {rows.viaWho}" meta={sending.host ?? "no mailbox set"}>
              {#snippet mark()}<span class="p-body ended"></span>{/snippet}
            </Row>
            {#if sending.host}
              <Row title="port" meta={rows.viaPort}>
                {#snippet mark()}<span class="p-body ended"></span>{/snippet}
              </Row>
            {/if}
            <Row title="password" meta={sending.password === "mailbox" ? "the mailbox’s"
              : sending.credentialSetBy ? `set by ${sending.credentialSetBy} · ${dayMonthYear(sending.credentialSetAt ?? "")}`
                : sending.password === "set" ? "set" : "not set"}>
              {#snippet mark()}<span class="p-body ended"></span>{/snippet}
            </Row>
            <Row title="last sent" meta={rows.lastSent ? `${rows.lastSent.what} · ${rows.lastSent.when}` : "nothing yet"}>
              {#snippet mark()}<span class="p-body ended"></span>{/snippet}
            </Row>
            {@render testRow("relay")}
            {#if !sending.configured}<p class="ad-said warn ad-inset" role="alert">{SENDING_NOT_SET}</p>{/if}
            {#if sending.source === "imported"}
              <p class="ad-said ad-inset" role="status"><span>copied from .env-orbit on {dayMonthYear(sending.setAt ?? "")} · the SMTP lines there can go now</span>
                <a class="p-quiet" href={SENDING_HOW_HREF} target="_blank" rel="noopener noreferrer">how</a></p>
            {/if}
          {:else}
            {@render testRow("relay")}
            <p class="ad-said warn ad-inset" role="alert">{SENDING_NOT_SET}</p>
            {#if importSkipped}
              <p class="ad-said ad-inset" role="status"><span>the SMTP lines in .env-orbit could not be copied: {importSkippedWords(importSkipped.reason)} · set sending up here</span>
                <a class="p-quiet" href={SENDING_HOW_HREF} target="_blank" rel="noopener noreferrer">how</a></p>
            {/if}
          {/if}
          <div class="ad-foot"><button class="p-pill act-accent wide" onclick={openSendEditor}>{sending?.via ? "change sending…" : "set up sending…"}</button></div>
          {#if sendCard.outcome && !sendOpen}<p class="ad-said {sendCard.outcome === 'verified' ? 'ok' : 'warn'} ad-lastline" role="status">{sendingOutcomeWords(sendCard.outcome)}</p>{/if}
          {#if sendCard.problem && !sendOpen}<p class="p-error ad-inset ad-lastline" role="alert">{sendCard.problem}</p>{/if}
        {/if}
      </section>

      <!-- OPERATIONS (§2.12 8, #1000): tap a row for its last check. -->
      <section class="p-card ad-card ad-flush" style:--i="7" id="ad-operations" tabindex="-1"
               aria-labelledby="ad-ops-head" data-ad="operations">
        <div class="ad-cardhead"><h2 class="p-caps" id="ad-ops-head">Operations</h2></div>
        {#if view.failed.services}
          <p class="p-error ad-inset ad-lastline" role="alert">not shown — Orbit could not reach the service checks{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
        {/if}
        {#each view.services ?? [] as [tone, name, detail], at (name)}
          {@const words = split(detail)}
          <Row title={name} meta={words.rest} trail={words.word} trailTone={INK[tone] ?? ""}
               onactivate={() => { serviceAt = at; serviceOpen = true; }}>
            {#snippet mark()}<span class="p-body {BODY[tone] ?? 'ended'}" class:breathing={tone === "warm"}></span>{/snippet}
          </Row>
        {/each}
      </section>

      <!-- DOCUMENT JOBS (#1071, #1055 round 2): one row per job, kind only,
           the reason on the row for good, `retry` on show on a failed row. -->
      {#if view.failed.operations}
        <section class="p-card ad-card ad-flush" style:--i="8" id="ad-documents" tabindex="-1"
                 aria-labelledby="ad-docs-head" data-ad="documents">
          <div class="ad-cardhead"><h2 class="p-caps" id="ad-docs-head">Document jobs</h2></div>
          <p class="p-error ad-inset ad-lastline" role="alert">not shown — Orbit could not reach the document jobs{stillNoAnswer ? " (tried again, still no answer)" : ""}
            <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
        </section>
      {/if}
      {#if view.operations}
        <section class="p-card ad-card ad-flush" class:proposed={jobs.length === 0} style:--i="8"
                 id="ad-documents" tabindex="-1" aria-labelledby="ad-docs-head" data-ad="documents">
          <div class="ad-cardhead">
            <h2 class="p-caps" id="ad-docs-head">Document jobs</h2>
            {#if jobCounts}<p class="ad-count">{jobCounts}</p>{/if}
          </div>
          {#each jobs as job (job.id)}
            {@const state = JOB_STATES[job.status] ?? { word: job.status, tone: "" }}
            {#snippet jobDetail()}
              <div class="p-kv"><span>tries</span><b>{job.attempts}</b></div>
              <div class="p-kv"><span>last tried</span><b>{ago(job.updatedAt, clock)}</b></div>
            {/snippet}
            <Row title={JOB_KINDS[job.kind] ?? job.kind} metaFace="ui" meta={jobMetaOf(job, clock, retried)}
                 detail={job.status === "failed" || job.status === "retry" ? jobDetail : undefined}>
              {#snippet mark()}<span class="p-body {state.tone || 'ended'}" class:failed={job.status === "failed"}></span>{/snippet}
              {#snippet end()}<span class="ad-state {state.tone}">{state.word}</span>{/snippet}
              {#snippet below()}
                {#if job.status === "failed"}
                  <button class="p-pill act-accent" aria-label="Retry the {(JOB_KINDS[job.kind] ?? job.kind).toLowerCase()}"
                          onclick={() => retryJob(job, { card: jobsCard, retried, wake })}>retry</button>
                {/if}
              {/snippet}
            </Row>
          {:else}
            <p class="p-empty ad-inset">no document jobs yet</p>
          {/each}
          <!-- #1433 D20 (note 55173): the kept page previews, Orbit's own data outside every quota. -->
          {#if view.previews}
            <Row title={megabytes(view.previews.bytes)} meta="page previews kept" />
            <Row title={documentsOwed(view.previews.pending)} meta="not yet drawn" />
          {/if}
          {#if jobsCard.problem}<p class="p-error ad-inset" role="alert">{jobsCard.problem}</p>{/if}
        </section>
      {/if}

      {#if view.instance}
        <p class="ad-strip">{versionLine(view.instance)}</p>
      {:else if view.failed.instance}
        <p class="p-error ad-inset" role="alert">version not shown — Orbit could not reach this instance’s build{stillNoAnswer ? " (tried again, still no answer)" : ""}
          <button class="p-pill filled" disabled={retrying} onclick={tryAgain}>try again</button></p>
      {/if}
    {/if}
  </main>

  <!-- ── sheets ─────────────────────────────────────────────────────────── -->
  <Sheet bind:open={readingOpen} size="callout" title={reading?.title ?? "What to do"}>
    {#if reading?.id === "rotation" && view?.rotation}
      <p class="p-prose ad-sheet-say">{view.rotation.startedAt
        ? `Open ${openFor(view.rotation.startedAt)} · since ${stamp(view.rotation.startedAt)}.` : "The start time was not recorded."}</p>
      {#if view.rotation.secondKeyLoaded}
        <p class="p-prose ad-sheet-say">Orbit is holding two encryption keys while the rotation runs. Every document stays readable —
          this is safe, but it is meant to be brief. Finish the procedure: run the rewrap, promote the new key, remove the old
          one — “Rotating the document key-encryption key” in the administrator guide has the steps.</p>
      {:else}
        <p class="p-prose ad-sheet-say">A rotation was started and never recorded as finished, and this instance is no longer
          holding the second key. Check where the rotation got to before changing anything — see “Rotating the document
          key-encryption key” in the administrator guide.</p>
      {/if}
    {:else if reading?.id === "locked" && view?.metadata}
      <p class="p-prose ad-sheet-say">Orbit’s encryption key is not available, so encrypted notes, references and mail-in
        extracts can’t be read or written — notes or references on {view.metadata.lockedItems} items and
        {view.metadata.lockedReceipts} mail-in messages are affected, and item editing is paused. The data is intact and
        unlocks the moment the key is restored. “Restoring the document key-encryption key” in the administrator guide has
        the steps.</p>
    {:else if reading?.id === "damaged" && view?.metadata}
      <p class="p-prose ad-sheet-say">{view.metadata.damagedValues} values have failed their integrity check and can’t be
        recovered — notes or references on {view.metadata.damagedItems} items, and {view.metadata.damagedReceipts} mail-in
        messages. Each occurrence is in the logs with its row and column. Overwriting a damaged value repairs the record; a
        damaged mail-in message can be re-forwarded. Counted as they’re encountered, so the number can grow as items are
        opened.</p>
    {:else if reading?.id === "bundle"}
      <p class="p-prose ad-sheet-say">If the encryption key is ever lost with no recovery bundle to recover it, every
        document, all encrypted metadata, and — once account addresses are encrypted — every stored address are gone for
        good. Run <code>bash scripts/backup.sh</code> then <code>bash scripts/export-recovery-bundle.sh &lt;backup.tar&gt;</code> to make one.</p>
      <p class="p-prose ad-sheet-say">Keep its two parts apart: the bundle file on storage separate from this instance, and
        its passphrase in a password manager or on paper — never both together, because that separation is what keeps
        anyone who gets hold of the file alone from being able to use it. This reappears after every encryption-key
        rotation, because a bundle wrapped under the previous key can no longer recover the current one. “Exporting a
        recovery bundle” in the administrator guide has the steps.</p>
    {/if}
  </Sheet>

  <Sheet bind:open={inviteOpen} size="callout" title="Invite someone">
    <form id="ad-invite-form" onsubmit={(event) => { event.preventDefault(); invite(); }}>
      <label class="ad-label" for="ad-inv-email">email</label>
      <input id="ad-inv-email" class="p-input" type="email" inputmode="email" autocomplete="off" enterkeyhint="next"
             placeholder="newcomer@example.com" bind:value={draft.email} required>
      <label class="ad-label" for="ad-inv-name">display name</label>
      <input id="ad-inv-name" class="p-input" autocomplete="off" enterkeyhint="done" placeholder="their name"
             bind:value={draft.displayName} required>
      <p class="ad-label" id="ad-inv-days">link valid for</p>
      <div class="ad-stepper" role="group" aria-labelledby="ad-inv-days">
        <button type="button" class="p-pill" aria-label="One day fewer" disabled={Number(draft.expiresInDays) <= SETUP_LINK_DAYS.min}
                onclick={() => (draft.expiresInDays = stepped(draft.expiresInDays, -1))}>−</button>
        <output aria-live="polite">{plural(Number(draft.expiresInDays), "day")}</output>
        <button type="button" class="p-pill" aria-label="One day more" disabled={Number(draft.expiresInDays) >= SETUP_LINK_DAYS.max}
                onclick={() => (draft.expiresInDays = stepped(draft.expiresInDays, 1))}>+</button>
      </div>
      {#if inviteArmed && actorHasPassword}
        <label class="ad-label" for="ad-inv-current">your current password</label>
        <input id="ad-inv-current" class="p-input" type="password" autocomplete="current-password" enterkeyhint="send"
               bind:value={invitePassword} required>
      {/if}
      <p class="ad-note">Orbit mails them a link to choose their own password. The link is never shown here.</p>
      {#if inviteCard.problem}<p class="p-error" role="alert">{inviteCard.problem}</p>{/if}
    </form>
    {#snippet foot()}
      <button class="p-pill filled" type="submit" form="ad-invite-form" disabled={inviteCard.busy}>
        {inviteCard.busy ? "creating…" : inviteArmed || provenIntent === "local_user_create" ? "create and send the link" : "create"}</button>
    {/snippet}
  </Sheet>

  <Sheet bind:open={resendOpen} size="callout" title="New setup link">
    {#if resendFor}
      <form id="ad-resend-form" onsubmit={(event) => { event.preventDefault(); resend(); }}>
        <p class="p-prose ad-sheet-say">A fresh link goes to {resendFor.email ?? resendFor.displayName}. The one before it stops working.</p>
        <p class="ad-label" id="ad-re-days">link valid for</p>
        <div class="ad-stepper" role="group" aria-labelledby="ad-re-days">
          <button type="button" class="p-pill" aria-label="One day fewer" disabled={resendDays <= SETUP_LINK_DAYS.min}
                  onclick={() => (resendDays = stepped(resendDays, -1))}>−</button>
          <output aria-live="polite">{plural(resendDays, "day")}</output>
          <button type="button" class="p-pill" aria-label="One day more" disabled={resendDays >= SETUP_LINK_DAYS.max}
                  onclick={() => (resendDays = stepped(resendDays, 1))}>+</button>
        </div>
        {#if actorHasPassword}
          <label class="ad-label" for="ad-re-current">your current password</label>
          <input id="ad-re-current" class="p-input" type="password" autocomplete="current-password" enterkeyhint="send"
                 bind:value={resendPassword} required>
        {/if}
        {#if resendCard.problem}<p class="p-error" role="alert">{resendCard.problem}</p>{/if}
      </form>
    {/if}
    {#snippet foot()}
      {#if resendFor}
        <button class="p-pill filled" type="submit" form="ad-resend-form" disabled={resendCard.busy}>{resendCard.busy ? "sending…" : "send it"}</button>
      {/if}
    {/snippet}
  </Sheet>

  <Sheet bind:open={placeOpen} size="list" title="Place {placing?.displayName ?? 'them'} in a system">
    <div class="ad-flushrows">
      {#each systems as system (system.id)}
        <Row title={system.name} meta={systemMeta(system)} trail="place" trailTone="var(--accent-text)"
             trailName="place {placing?.displayName ?? 'them'} in {system.name}" onactivate={() => placeIn(system)}>
          {#snippet mark()}<span class="ad-kmark">◯</span>{/snippet}
        </Row>
      {/each}
    </div>
  </Sheet>

  <!-- A list, not the review round's callout (§1.2 names "new system" a
       callout): its owner is picked from a row per person, which can run
       past a callout's fold, so it stays a list until the design says which. -->
  <Sheet bind:open={systemOpen} size="list" title="New system">
    <label class="ad-label" for="ad-sys-name">name</label>
    <input id="ad-sys-name" class="p-input" autocomplete="off" enterkeyhint="next" placeholder="Seaside Cottage"
           maxlength={NAME_LIMIT} bind:value={systemName}>
    {#if actorHasPassword}
      <label class="ad-label" for="ad-sys-current">your current password</label>
      <input id="ad-sys-current" class="p-input" type="password" autocomplete="current-password" enterkeyhint="next"
             bind:value={systemPassword}>
    {/if}
    <p class="ad-label" id="ad-sys-owner">who will own it · tap to make it</p>
    <div class="ad-flushrows" role="group" aria-labelledby="ad-sys-owner">
      {#each people as person (person.id)}
        <Row title="{person.displayName}{person.id === meId ? ' · you' : ''}" meta={person.email ?? ""}
             trail="owner" trailTone="var(--accent-text)" trailName="make it, owned by {person.displayName}"
             onactivate={() => createSystemFor(person)}>
          {#snippet mark()}<span class="p-avatar">{initials(person.displayName)}</span>{/snippet}
        </Row>
      {/each}
    </div>
    {#if systemCard.problem}<p class="p-error" role="alert">{systemCard.problem}</p>{/if}
  </Sheet>

  <Sheet bind:open={contactOpen} size="callout" title="Public contact">
    <form id="ad-contact-form" onsubmit={(event) => { event.preventDefault(); sendContact({ action: "set", address: contactDraft }); }}>
      <label class="ad-label" for="ad-contact-field">address</label>
      <input id="ad-contact-field" class="p-input" type="email" inputmode="email" autocomplete="off" enterkeyhint="done"
             placeholder="ops@example.com" bind:value={contactDraft} required>
      <p class="ad-note">Shown on the sign-in door if it ever can’t open safely — never a real administrator’s own mailbox.
        Anyone can read it, signed in or not.</p>
      {#if contactCard.problem}<p class="p-error" role="alert">{contactCard.problem}</p>{/if}
    </form>
    {#snippet foot()}
      <button class="p-pill filled" type="submit" form="ad-contact-form" disabled={contactCard.busy}>{contactCard.busy ? "saving…" : "save"}</button>
      {#if view?.contact?.address}
        <button class="p-pill danger" type="button" disabled={contactCard.busy} onclick={() => sendContact({ action: "clear" })}>clear</button>
      {/if}
    {/snippet}
  </Sheet>

  <Sheet bind:open={uploadLimitOpen} size="callout" title="Upload size limit">
    <form id="ad-uploads-form" onsubmit={(event) => { event.preventDefault();
      if (uploadLimitDraft !== null) sendUploadLimit({ action: "set", megabytes: uploadLimitDraft }); }}>
      <label class="ad-label" for="ad-uploads-field">limit in MB</label>
      <input id="ad-uploads-field" class="p-input" type="number" inputmode="numeric" step="1" enterkeyhint="done"
             min={view?.uploadLimit ? Math.round(view.uploadLimit.minBytes / 1048576) : 1}
             max={view?.uploadLimit ? Math.round(view.uploadLimit.ceilingBytes / 1048576) : 100}
             bind:value={uploadLimitDraft} required>
      {#if view?.uploadLimit}
        <p class="ad-note">From {megabytes(view.uploadLimit.minBytes)} to {megabytes(view.uploadLimit.ceilingBytes)}. It applies to
          the next upload; documents already kept are unaffected. Mail has its own limit, under Mail.</p>
      {/if}
      {#if uploadLimitCard.problem}<p class="p-error" role="alert">{uploadLimitCard.problem}</p>{/if}
    </form>
    {#snippet foot()}
      <button class="p-pill filled" type="submit" form="ad-uploads-form" disabled={uploadLimitCard.busy}>{uploadLimitCard.busy ? "saving…" : "save"}</button>
      {#if view?.uploadLimit && view.uploadLimit.overrideBytes !== null}
        <button class="p-pill" type="button" disabled={uploadLimitCard.busy}
                onclick={() => sendUploadLimit({ action: "default" })}>use the default</button>
      {/if}
    {/snippet}
  </Sheet>

  <Sheet bind:open={archiveStorageOpen} size="callout" title="Exports kept">
    <form id="ad-archives-form" onsubmit={(event) => { event.preventDefault();
      const { retentionHours, keepPerHousehold, maxTotalGigabytes } = archiveStorageDraft;
      if (retentionHours !== null && keepPerHousehold !== null && maxTotalGigabytes !== null) {
        sendArchiveStorage({ action: "set", retentionHours, keepPerHousehold, maxTotalGigabytes });
      } }}>
      <label class="ad-label" for="ad-archives-hours">kept for, in hours</label>
      <input id="ad-archives-hours" class="p-input" type="number" inputmode="numeric" step="1" enterkeyhint="next"
             min={view?.archiveStorage?.bounds.retentionHours[0] ?? 1} max={view?.archiveStorage?.bounds.retentionHours[1] ?? 720}
             bind:value={archiveStorageDraft.retentionHours} required>
      <label class="ad-label" for="ad-archives-count">exports kept per system</label>
      <input id="ad-archives-count" class="p-input" type="number" inputmode="numeric" step="1" enterkeyhint="next"
             min={view?.archiveStorage?.bounds.keepPerHousehold[0] ?? 1} max={view?.archiveStorage?.bounds.keepPerHousehold[1] ?? 10}
             bind:value={archiveStorageDraft.keepPerHousehold} required>
      <label class="ad-label" for="ad-archives-space">space for all exports, in GB</label>
      <input id="ad-archives-space" class="p-input" type="number" inputmode="numeric" step="1" enterkeyhint="done"
             min={view?.archiveStorage?.bounds.maxTotalGigabytes[0] ?? 1} max={view?.archiveStorage?.bounds.maxTotalGigabytes[1] ?? 102400}
             bind:value={archiveStorageDraft.maxTotalGigabytes} required>
      <p class="ad-note">From 1 to 720 hours, 1 to 10 per system, 1 GB and up. A shorter time applies to exports already
        written. When a system has more than its number, the oldest goes; when all exports pass the space, the oldest
        downloaded one goes first.</p>
      {#if archiveStorageCard.problem}<p class="p-error" role="alert">{archiveStorageCard.problem}</p>{/if}
    </form>
    {#snippet foot()}
      <button class="p-pill filled" type="submit" form="ad-archives-form" disabled={archiveStorageCard.busy}>{archiveStorageCard.busy ? "saving…" : "save"}</button>
      {#if archiveStorageOverridden}
        <button class="p-pill" type="button" disabled={archiveStorageCard.busy}
                onclick={() => sendArchiveStorage({ action: "default" })}>use the defaults</button>
      {/if}
    {/snippet}
  </Sheet>

  <Sheet bind:open={mailLimitOpen} size="callout" title="Largest mail message">
    <form id="ad-mail-limit-form" onsubmit={(event) => { event.preventDefault();
      if (mailLimitDraft !== null) sendMailLimit({ action: "set", megabytes: mailLimitDraft }); }}>
      <label class="ad-label" for="ad-mail-limit-field">limit in MB</label>
      <input id="ad-mail-limit-field" class="p-input" type="number" inputmode="numeric" step="1" enterkeyhint="done"
             min={view?.mailLimit ? Math.round(view.mailLimit.minBytes / 1048576) : 1}
             max={view?.mailLimit ? Math.round(view.mailLimit.ceilingBytes / 1048576) : 50}
             bind:value={mailLimitDraft} required>
      {#if view?.mailLimit}
        <p class="ad-note">From {megabytes(view.mailLimit.minBytes)} to {megabytes(view.mailLimit.ceilingBytes)}. It applies to the
          next message collected; a message larger than this is refused and shown in the inbox as too large.
          Documents already kept are unaffected.</p>
      {/if}
      {#if mailLimitCard.problem}<p class="p-error" role="alert">{mailLimitCard.problem}</p>{/if}
    </form>
    {#snippet foot()}
      <button class="p-pill filled" type="submit" form="ad-mail-limit-form" disabled={mailLimitCard.busy}>{mailLimitCard.busy ? "saving…" : "save"}</button>
      {#if view?.mailLimit && view.mailLimit.overrideBytes !== null}
        <button class="p-pill" type="button" disabled={mailLimitCard.busy}
                onclick={() => sendMailLimit({ action: "default" })}>use the default ({megabytes(view.mailLimit.defaultBytes)})</button>
      {/if}
    {/snippet}
  </Sheet>

  <Sheet bind:open={rotateOpen} size="callout" title="Rotate the mailbox password">
    <form id="ad-rotate-form" onsubmit={(event) => { event.preventDefault();
      if (view?.mailbox) mailAction("rotate", { action: "rotate", expectedVersion: view.mailbox.version, password: mailPassword }); }}>
      <label class="ad-label" for="ad-rot-pass">new password</label>
      <input id="ad-rot-pass" class="p-input" type="password" autocomplete="new-password" enterkeyhint="done"
             bind:value={mailPassword} required>
      <p class="ad-note">It is proven against the provider before it’s kept; a refusal leaves the old one working.</p>
      {#if mailCard.problem}<p class="p-error" role="alert">{mailCard.problem}</p>{/if}
    </form>
    {#snippet foot()}
      <button class="p-pill filled" type="submit" form="ad-rotate-form" disabled={mailCard.busy !== null}>
        {mailCard.busy === "rotate" ? "verifying…" : "verify and rotate"}</button>
    {/snippet}
  </Sheet>

  <Sheet bind:open={editOpen} size="full" title={view?.mailbox?.configured ? "Change the mailbox" : "Set up the mailbox"}>
    <form id="ad-mailbox-form" class="ad-form" onsubmit={(event) => { event.preventDefault();
      if (view?.mailbox) mailAction("set", { action: "set", expectedVersion: view.mailbox.version, ...mailDraft, password: mailPassword }); }}>
      <label class="ad-label" for="ad-mb-host">host</label>
      <input id="ad-mb-host" class="p-input" autocomplete="off" autocapitalize="off" bind:value={mailDraft.host} required>
      <label class="ad-label" for="ad-mb-port">port</label>
      <input id="ad-mb-port" class="p-input" type="number" inputmode="numeric" min="1" max="65535" bind:value={mailDraft.port} required>
      <label class="ad-label" for="ad-mb-user">account</label>
      <input id="ad-mb-user" class="p-input" autocomplete="off" autocapitalize="off" placeholder="intake@example.com"
             bind:value={mailDraft.accountUser} required>
      <label class="ad-label" for="ad-mb-folder">folder</label>
      <input id="ad-mb-folder" class="p-input" autocapitalize="off" bind:value={mailDraft.mailbox} required>
      <label class="ad-label" for="ad-mb-tls">tls name</label>
      <input id="ad-mb-tls" class="p-input" autocapitalize="off" placeholder="same as host" bind:value={mailDraft.tlsServerName}>
      <label class="ad-label" for="ad-mb-provider">provider</label>
      <button type="button" id="ad-mb-provider" class="p-input ad-pick" aria-haspopup="dialog" aria-expanded={providerOpen}
              onclick={() => { providerOpen = !providerOpen; }}>{mailDraft.providerProfile}</button>
      {#if providerOpen}
        <div class="ad-chseat" data-chooser-card use:holdSeat>
          <div class="ad-chscrim" aria-hidden="true" onclick={() => closeProvider(false)}></div>
          <ChooserCard ask={providerAsk(mailDraft.providerProfile)} layout="sheet"
                       onpick={(profile) => { mailDraft.providerProfile = profile; closeProvider(true); }} onclose={() => closeProvider(true)} />
        </div>
      {/if}
      <label class="ad-label" for="ad-mb-header">envelope header</label>
      <input id="ad-mb-header" class="p-input" autocapitalize="off" bind:value={mailDraft.trustedRecipientHeader} required>
      <label class="ad-label" for="ad-mb-poll">poll seconds</label>
      <input id="ad-mb-poll" class="p-input" type="number" inputmode="numeric" min="30" max="3600" bind:value={mailDraft.pollSeconds} required>
      <label class="ad-label" for="ad-mb-pass">password</label>
      <input id="ad-mb-pass" class="p-input" type="password" autocomplete="new-password" bind:value={mailPassword} required>
      <p class="ad-note">Relay addresses are plus-addresses of this account, so it has to be one the provider delivers
        sub-addressed mail to. The password is stored encrypted and never shown again.</p>
      {#if mailCard.problem}<p class="p-error" role="alert">{mailCard.problem}</p>{/if}
    </form>
    {#snippet foot()}
      <button class="p-pill filled" type="submit" form="ad-mailbox-form" disabled={mailCard.busy !== null}>
        {mailCard.busy === "set" ? "verifying…" : "verify and save"}</button>
    {/snippet}
  </Sheet>

  <Sheet bind:open={sendOpen} size={sendDraft.via === "account" ? "full" : "callout"} title={view?.sending?.via ? "Change sending" : "Set up sending"}>
    {@const submission = mailboxSubmissionHost(view?.mailbox)}
    <form id="ad-sending-form" class="ad-form" onsubmit={(event) => { event.preventDefault(); submitSending(); }}>
      <span class="ad-label" id="ad-send-through">send through</span>
      <div class="p-tabs" role="tablist" aria-labelledby="ad-send-through">
        <button type="button" role="tab" aria-selected={sendDraft.via === "mailbox"} disabled={!view?.mailbox?.configured}
                onclick={() => (sendDraft.via = "mailbox")}>the mailbox account</button>
        <button type="button" role="tab" aria-selected={sendDraft.via === "account"}
                onclick={() => (sendDraft.via = "account")}>another account</button>
      </div>
      {#if sendDraft.via === "account"}
        <label class="ad-label" for="ad-send-host">host</label>
        <input id="ad-send-host" class="p-input" autocomplete="off" autocapitalize="off" bind:value={sendDraft.host} required>
        <label class="ad-label" for="ad-send-port">port</label>
        <input id="ad-send-port" class="p-input" type="number" inputmode="numeric" min="1" max="65535" bind:value={sendDraft.port} required>
        <span class="ad-label" id="ad-send-security">security</span>
        <div class="p-tabs" role="tablist" aria-labelledby="ad-send-security">
          <button type="button" role="tab" aria-selected={sendDraft.security === "starttls"}
                  onclick={() => pickSecurity("starttls")}>STARTTLS</button>
          <button type="button" role="tab" aria-selected={sendDraft.security === "implicit_tls"}
                  onclick={() => pickSecurity("implicit_tls")}>TLS</button>
        </div>
        <label class="ad-label" for="ad-send-user">user</label>
        <input id="ad-send-user" class="p-input" autocomplete="off" autocapitalize="off" bind:value={sendDraft.user} required>
        <label class="ad-label" for="ad-send-pass">password</label>
        <input id="ad-send-pass" class="p-input" type="password" autocomplete="new-password" bind:value={sendPassword} required>
      {/if}
      <label class="ad-label" for="ad-send-name">sender name</label>
      <input id="ad-send-name" class="p-input" maxlength="80" bind:value={sendDraft.senderName} required>
      <label class="ad-label" for="ad-send-address">sender address</label>
      <input id="ad-send-address" class="p-input" type="email" autocapitalize="off" bind:value={sendDraft.senderAddress} required>
      {#if sendDraft.via === "mailbox"}
        <p class="ad-note">via {submission}, port 587, STARTTLS, signed in as {view?.mailbox?.accountUser ?? ""}</p>
      {/if}
      <p class="ad-note">Orbit signs in to the server before saving. The password is never shown again.</p>
      {#if sendCard.outcome && sendCard.outcome !== "verified"}<p class="p-error" role="alert">{sendingOutcomeWords(sendCard.outcome)}</p>{/if}
      {#if sendCard.problem}<p class="p-error" role="alert">{sendCard.problem}</p>{/if}
    </form>
    {#snippet foot()}
      <button class="p-pill filled" type="submit" form="ad-sending-form" disabled={sendCard.busy}>
        {sendCard.busy ? "verifying…" : "verify and save"}</button>
    {/snippet}
  </Sheet>

  <Sheet bind:open={doomOpen} size="callout" title="Delete {doomed?.name ?? 'it'} now?">
    {#if doomed}
      <p class="p-prose ad-sheet-say">Deleting now skips the {plural(daysLeft(doomed.deleteAfter, view?.now), "day")}. Nothing comes back
        after this — not for you, not for anyone.</p>
      <label class="ad-label" for="ad-doom-name">type the system’s name exactly to wake the button</label>
      <input id="ad-doom-name" class="p-input" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"
             placeholder={doomed.name} bind:value={typedName}>
      {#if doomProblem}<p class="p-error" role="alert">{doomProblem}</p>{/if}
    {/if}
    {#snippet foot()}
      {#if doomed}
        {#if nameOk}
          <ArmButton label="delete for good" armedLabel="tap again to delete for good" onfire={deleteNow} />
        {:else}
          <button class="p-pill danger" disabled>delete for good</button>
        {/if}
      {/if}
    {/snippet}
  </Sheet>

  <Sheet bind:open={aliasOpen} size="callout" title="Rotate every address">
    <p class="p-prose ad-sheet-say">Every member gets a new relay address. Mail sent to an old one still arrives until its
      grace runs out.</p>
    <p class="ad-label" id="ad-grace">old addresses keep working for</p>
    <div class="ad-stepper" role="group" aria-labelledby="ad-grace">
      <button type="button" class="p-pill" aria-label="Seven days fewer" disabled={graceDays <= 0} onclick={() => graceStep(-7)}>−</button>
      <output aria-live="polite">{plural(graceDays, "day")}</output>
      <button type="button" class="p-pill" aria-label="Seven days more" disabled={graceDays >= 90} onclick={() => graceStep(7)}>+</button>
    </div>
    {#if mailCard.problem}<p class="p-error" role="alert">{mailCard.problem}</p>{/if}
    {#snippet foot()}
      <ArmButton label="rotate every address" armedLabel="tap again to rotate every address"
                 onfire={() => { if (view?.mailbox) mailAction("alias", { action: "rotate_alias_key", expectedVersion: view.mailbox.version, graceDays }).then(() => { if (!mailCard.problem) { aliasOpen = false; wake("every address is new · the old ones keep working for " + plural(graceDays, "day")); } }); }} />
    {/snippet}
  </Sheet>

  <Sheet bind:open={serviceOpen} size="callout" title={service ? service[1] : "Service"}>
    {#if service}
      <div class="p-kv"><span>state</span><b class={BODY[service[0]] ?? ""}>{split(service[2]).word}</b></div>
      {#if serviceRaw}
        <div class="p-kv"><span>last checked</span><b>{stamp(serviceRaw.checkedAt)}</b></div>
        {#if serviceRaw.signaturesAt}<div class="p-kv"><span>signatures from</span><b>{stamp(serviceRaw.signaturesAt)}</b></div>{/if}
        {#if serviceRaw.lastSuccessAt}<div class="p-kv"><span>last success</span><b>{stamp(serviceRaw.lastSuccessAt)}</b></div>{/if}
        {#if serviceRaw.lastErrorAt}<div class="p-kv"><span>last error</span><b class="over">{stamp(serviceRaw.lastErrorAt)}</b></div>{/if}
      {:else}
        <div class="p-kv"><span>last check</span><b>{split(service[2]).rest || "as shown"}</b></div>
      {/if}
    {/if}
  </Sheet>
</div>

<style>
  /* #1468: the provider profile's pressed value and its chooser sheet's seat */
  .ad-pick{display:flex;align-items:center;text-align:left;cursor:pointer;font:var(--p-type-input) var(--ui);color:var(--ink);background:none}
  .ad-chseat{position:fixed;left:0;right:0;bottom:0;z-index:70}
  .ad-chscrim{position:fixed;inset:0;z-index:-1}
  /* THE DIALECT SWITCH: the same query as $lib/pocket/media.js. The desk's
     grid goes; its chrome stays (on a phone Chrome.svelte draws the kit's
     top chrome and the hatch), and so does the station, the page's
     observatory personality (CON-9), with every label it draws hidden
     because the screen's edge would cut them (§1.10) and the art dimmed one
     step (§5.2). */
  .ad-pocket{display:none}
  @media (max-width:839.98px), (max-height:479.98px){
    .ad-pocket{display:block;position:relative;min-height:100dvh}
    :global(.mission-page > .page){display:none}
    :global(.mission-page :is(.station, .chartback) text){display:none}
    /* The station keeps clear of the title: it fades in below the head, so
       its arrays are never drawn through a word. */
    :global(.mission-page .station-backdrop .station){opacity:.6;
      -webkit-mask-image:linear-gradient(to bottom, transparent 0, transparent 24%, #000 52%);
      mask-image:linear-gradient(to bottom, transparent 0, transparent 24%, #000 52%)}
    :global(.mission-page .station-backdrop .chartback){opacity:calc(var(--chart-alpha, 1) * .6)}
  }

  .ad-column{position:relative;z-index:2;box-sizing:border-box;max-width:var(--p-column);margin:0 auto;
    padding:calc(var(--p-chrome) + env(safe-area-inset-top) + 8px) var(--p-gutter)
      calc(var(--p-kb, 0px) + 40px + env(safe-area-inset-bottom))}

  /* The head: the observatory's mark, a craft on its orbit round the sun. */
  .ad-head{display:flex;align-items:center;gap:14px;margin:4px 0 12px}
  .ad-glyph{flex:none;overflow:visible}
  .ad-orbit{stroke:var(--chart-line, var(--line));stroke-width:1.1}
  .ad-orbit.soft{stroke:var(--chart-line-soft, var(--line-soft));stroke-dasharray:2 3}
  .ad-craft{fill:var(--ink-mid);transform-origin:28px 28px;animation:ad-fly 48s linear infinite}
  .ad-array{fill:var(--accent)}
  @keyframes ad-fly{to{transform:rotate(360deg)}}
  :global([data-theme=retrograde]) .ad-array{filter:drop-shadow(0 0 2.5px var(--bloom))}
  .ad-named{min-width:0}
  .ad-sub{margin:6px 0 0;font:var(--p-type-meta)/1.5 var(--mono);color:var(--ink-quiet)}

  /* The tells (#1071's family): uppercase pills, each a link to its card. */
  .ad-tells{display:flex;flex-wrap:wrap;gap:var(--p-pill-gap);margin:0 0 12px}
  .ad-tell{display:inline-flex;align-items:center;min-height:var(--p-hit);padding:0 14px;box-sizing:border-box;
    border-radius:22px;border:1px solid color-mix(in srgb, var(--overdue) 55%, transparent);
    background:color-mix(in srgb, var(--overdue) 10%, var(--panel));color:var(--overdue-text);
    font:600 var(--p-type-caps)/1 var(--mono);letter-spacing:var(--p-type-caps-track);text-transform:uppercase;
    text-decoration:none}
  .ad-tell:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

  /* THE JUMP STRIP: 36px chips drawn inside a 44px hit, scrolling sideways
     when the words outrun the width. */
  .ad-jump{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;margin:0 calc(var(--p-gutter) * -1) 8px;
    padding:0 var(--p-gutter);scroll-padding-inline:var(--p-gutter);
    -webkit-mask-image:linear-gradient(90deg, transparent 0, #000 var(--p-gutter), #000 calc(100% - var(--p-gutter)), transparent 100%);
    mask-image:linear-gradient(90deg, transparent 0, #000 var(--p-gutter), #000 calc(100% - var(--p-gutter)), transparent 100%)}
  .ad-jump::-webkit-scrollbar{display:none}
  .ad-chip{flex:none;display:flex;align-items:center;min-height:var(--p-hit);min-width:var(--p-hit);text-decoration:none;
    animation:ad-chip 360ms var(--p-ease) both;animation-delay:calc(180ms + var(--j) * 45ms)}
  .ad-chip span{display:flex;align-items:center;height:36px;padding:0 14px;box-sizing:border-box;border-radius:18px;
    /* --ink-mid is not one of packs.css's measured text companions (#491);
       --ink-quiet is the one built to clear 4.5:1 as words on this card's own
       translucent --panel, same as .ad-sub/.ad-kmark/.ad-count below. */
    border:1px solid var(--line);background:var(--panel);color:var(--ink-quiet);
    font:var(--p-type-meta)/1 var(--mono);white-space:nowrap}
  .ad-chip:active span{border-color:var(--accent);background:color-mix(in srgb, var(--accent) 14%, transparent);color:var(--accent-text)}
  .ad-chip:focus-visible{outline:none}
  .ad-chip:focus-visible span{outline:2px solid var(--accent);outline-offset:2px}
  @keyframes ad-chip{from{opacity:0;transform:translateX(12px)}}

  /* Cards arrive in turn, never in sync (§1.9). */

  .ad-card{margin-top:var(--p-card-gap);scroll-margin-top:16px}
  .ad-card:focus{outline:none}
  .ad-flush{padding:0 0 4px}
  .ad-cardhead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
    padding:8px var(--p-gutter) 4px}
  .ad-cardhead .p-caps{margin:0}
  .ad-inset{margin-left:var(--p-gutter);margin-right:var(--p-gutter)}
  /* The Mailbox and Sending heads keep the group gap above (#1629, J). */
  .ad-inset.p-caps{margin-top:var(--p-group-above)}
  .ad-lastline{margin-bottom:12px}
  .ad-flushrows{margin:8px calc(var(--p-card-pad) * -1) 0}
  /* An address is the meta line and is never cut: it wraps (§2.12). */
  .ad-pocket :global(.p-row .meta){overflow-wrap:anywhere}
  /* Three acts in the tray: 8px sides rather than the kit's 10, and the
     meta size (13px, above the floor) rather than 14px, so they fit at 360
     (#1123). Scoped to this page's people rows. */
  [data-ad=people] :global([data-row-acts] .p-pill){padding:0 8px;font-size:var(--p-type-meta)}
  .ad-kmark{font:var(--p-type-body)/1 var(--mono);color:var(--ink-quiet)}
  .ad-ring{display:block;margin:-3px}
  .ad-loading{padding:8px var(--p-gutter)}

  /* SIGN-IN PROVIDERS (#1676, round 3): the desk's .kv row, wrapping so the button
     or the quiet line drops under it on the right; the confirm is the page's
     .mailboxform; the problem lines are .p-error. */
  .kv{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px 14px;
    padding:12px var(--p-gutter);border-bottom:1px solid var(--line-soft);font:var(--p-type-meta)/1.5 var(--ui);color:var(--ink-mid)}
  .kv b{color:var(--ink);font-weight:500}
  .kv .on{color:var(--ok-text)}
  .kv > .p-pill,.kv > .note{margin-left:auto}
  .kv .note{color:var(--ink-quiet);text-align:right}
  .kv .note a{display:inline-flex;align-items:center;min-height:var(--p-hit);color:var(--accent-text)}
  .ad-link{display:inline-flex;align-items:center;min-height:var(--p-hit)}
  .mailboxform{display:grid;gap:10px;padding:12px var(--p-gutter) 4px}
  .mailboxform label{display:flex;flex-direction:column;gap:4px;font:var(--p-type-meta)/1.4 var(--ui);color:var(--ink-quiet)}
  .mailboxnote{font:var(--p-type-meta)/1.5 var(--ui);color:var(--ink-quiet);margin:0}
  .mailboxrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .ad-sent{font:var(--p-type-meta)/1.5 var(--ui);color:var(--ok-text);margin:8px 0 0}
  .retry{margin-left:8px}

  /* What an act said, kept on the card until the next one (§1.13). */
  .ad-said{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:4px var(--p-gutter) 8px;
    font:var(--p-type-meta)/1.5 var(--ui);animation:p-errin 200ms var(--p-ease) both}
  .ad-said p{margin:0;flex:1 1 60%}
  .ad-said.ok{color:var(--ok-text)}
  .ad-said.warn{color:var(--warm-text)}

  /* ALERTS: amber-edged, one sentence and one pill each (§2.12 3). */
  .ad-alerts{display:flex;flex-direction:column;gap:var(--p-card-gap);margin-top:var(--p-card-gap)}
  .ad-alert{position:relative;overflow:hidden;border-color:color-mix(in srgb, var(--warm) 55%, var(--line-soft));
    box-shadow:inset 3px 0 0 var(--warm)}
  .ad-alert::after{content:"";position:absolute;inset:0;pointer-events:none;
    background:linear-gradient(100deg, color-mix(in srgb, var(--warm) 9%, transparent), transparent 60%)}
  .ad-alert-head{display:flex;align-items:center;gap:8px;margin:0 0 8px;
    font:var(--p-type-caps)/1.4 var(--mono);letter-spacing:var(--p-type-caps-track);text-transform:uppercase;
    color:var(--warm-text)}
  .ad-alert-head svg{flex:none;fill:none;stroke:var(--warm-text);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
  .ad-alert-say{margin:0 0 12px;color:var(--ink-mid)}

  .ad-foot{display:flex;flex-direction:column;gap:var(--p-pill-gap);padding:12px var(--p-gutter) 8px}
  .ad-strip{margin:24px 0 0;text-align:center;font:var(--p-type-caps)/1.6 var(--mono);letter-spacing:.1em;
    text-transform:uppercase;color:var(--ink-quiet)}

  /* Forms inside sheets. */
  .ad-label{display:block;font:var(--p-type-caps)/1.4 var(--mono);letter-spacing:var(--p-type-caps-track);
    text-transform:uppercase;color:var(--ink-quiet);margin:16px 0 6px}
  .ad-label:first-child{margin-top:4px}
  .ad-note{margin:12px 0 0;font:var(--p-type-meta)/1.5 var(--ui);color:var(--ink-quiet)}
  /* A link inside the note keeps the pocket's 44px tap floor: vertical
     padding on an inline box widens what a finger hits without moving the
     line it sits on, and it reads at the controls' colour: the browser's
     own link blue fails WCAG AA contrast here (#1285). */
  .ad-note a{padding:14px 0;color:var(--ink-mid)}
  .ad-sheet-say{color:var(--ink-mid);margin:4px 0 12px}
  .ad-sheet-say code{font:var(--p-type-meta) var(--mono);color:var(--ink)}
  .ad-stepper{display:flex;align-items:center;gap:12px}
  .ad-stepper .p-pill{width:var(--p-hit);padding:0;justify-content:center;font:500 1.25rem/1 var(--mono)}
  .ad-stepper output{min-width:6em;text-align:center;font:500 var(--p-type-body)/1 var(--mono);color:var(--ink)}
  .p-pill:disabled{opacity:.45;cursor:default;box-shadow:none}

  /* The state pill (#1071's ADMIN pill family): FAILED red, RETRYING amber,
     RUNNING and QUEUED blue, DONE plain. Words, never colour alone. */
  .ad-state{display:inline-flex;align-items:center;height:26px;padding:0 10px;box-sizing:border-box;border-radius:13px;
    border:1px solid var(--line);color:var(--ink-mid);background:var(--panel);
    font:600 var(--p-type-caps)/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;white-space:nowrap}
  .ad-state.over{border-color:color-mix(in srgb, var(--overdue) 60%, transparent);color:var(--overdue-text);
    background:color-mix(in srgb, var(--overdue) 12%, var(--panel))}
  .ad-state.soon{border-color:color-mix(in srgb, var(--warm) 60%, transparent);color:var(--warm-text)}
  .ad-state.up{border-color:color-mix(in srgb, var(--upcoming) 60%, transparent);color:var(--upcoming-text, var(--upcoming))}
  .ad-state.ok{border-color:color-mix(in srgb, var(--ok) 60%, transparent);color:var(--ok-text)}
  .ad-checking{animation:p-breathe 2.4s ease-in-out infinite}
  .ad-count{margin:0;font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet);flex:1 1 100%}
  .ad-headpills{flex:1 1 100%}

  /* A disabled person dims; their row still opens to enable. */
  .ad-off{opacity:.45;border-style:dashed}

  /* On the clock (§2.11, #1001): a dashed red ring, a red sun. */
  .ad-clockring circle:first-child{stroke:var(--overdue);stroke-dasharray:3 3;animation:ad-tick 60s linear infinite;
    transform-origin:17px 17px}
  .ad-clockring circle:last-child{fill:var(--overdue)}
  @keyframes ad-tick{to{transform:rotate(-360deg)}}
  .ad-clocksaid{margin:0;flex:1 1 100%;font:var(--p-type-meta)/1.5 var(--ui);color:var(--ok-text);
    animation:p-errin 200ms var(--p-ease) both}
  .ad-clocksaid.bad{color:var(--overdue-text)}

  @media (prefers-reduced-motion:reduce){
    .ad-craft,.ad-chip,.ad-said,.ad-checking,.ad-clockring circle,.ad-clocksaid{animation:none}
  }
</style>
