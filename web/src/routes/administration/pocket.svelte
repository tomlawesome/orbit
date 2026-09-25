<script>
  import { onMount } from "svelte";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import { wake } from "$lib/pocket/wake.js";
  import {
    addMember, commandContact, commandMailbox, createLocalUser, createSystem, hardDeleteHousehold,
    restoreHousehold, retryDocumentJob, sendSetupLink, setUserDisabled, testMail,
  } from "$lib/data/workspace.js";
  import { deletionNameMatches } from "$lib/data/household.js";
  import { ago } from "$lib/format.js";
  import { SETUP_LINK_FIXTURES } from "$lib/data/fixtures/admin.js";
  import { constellationPlanetsOf } from "$lib/data/chart.js";
  import { NAME_LIMIT } from "$lib/arrival/stage.js";
  import {
    JOB_KINDS, JOB_REASONS, JOB_STATES, SETUP_LINK_DAYS, initialsOf, lapses, openFor, plainly, sendWords,
    setupWords, stamp, testVerdict,
  } from "./words.js";

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
   *   PEOPLE: invite someone is a sheet; row acts behind a swipe (§25)
   *   SYSTEMS: new system is a sheet; a system on the clock (§2.11, §19)
   *     keeps `restore` on show and `delete now` behind the swipe
   *   PUBLIC CONTACT; MAIL MACHINERY with its two tests (#1071)
   *   OPERATIONS; DOCUMENT JOBS (#1071), then the version line
   *
   * Row acts are revealed only by a left/right swipe (§25): nothing extra at
   * rest. The setup link is never shown on this screen, on either dialect
   * (owner, 2026-09-09): what it reports is where the link went and when it
   * lapses.
   */

  /** @typedef {NonNullable<Awaited<ReturnType<typeof import('$lib/data/workspace.js').readAdminScreen>>>} AdminView */
  /** @typedef {{ email: string, displayName: string, expiresInDays: number }} Draft */
  /** @typedef {(intent: string, open: () => void, report?: (message: string) => void) => Promise<void>} Challenge */
  /** @typedef {AdminView["users"][number]} Person */
  /** @typedef {AdminView["households"][number]} System */

  /** @type {{ view: AdminView | null, fixtures: boolean, actorHasPassword: boolean, provenIntent: string, draft: Draft, challenge: Challenge, reread: () => Promise<void>, spent: () => void }} */
  let { view, fixtures, actorHasPassword, provenIntent, draft = $bindable(), challenge, reread, spent } = $props();

  /** @param {unknown} error */
  const said = (error) => /** @type {{ message?: string }} */ (error)?.message ?? String(error);
  /** @param {number} n @param {string} one @param {string} [many] */
  const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
        say: `${count(view.metadata?.damagedValues ?? 0, "value")} failed the integrity check and can’t be recovered.` });
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
  const tells = $derived.by(() => {
    /** @type {{ href: string, word: string }[]} */
    const list = [];
    if (!view) return list;
    const failing = view.services.filter(([tone]) => tone === "overdue" || tone === "warm");
    for (const [tone, name] of failing.slice(0, 2)) {
      list.push({ href: "#ad-operations", word: `${name} ${tone === "overdue" ? "down" : "retrying"}` });
    }
    if (failing.length > 2) list.push({ href: "#ad-operations", word: `${failing.length - 2} more failing` });
    const failedJobs = jobs.filter((job) => job.status === "failed").length;
    if (failedJobs) list.unshift({ href: "#ad-documents", word: `${count(failedJobs, "job")} failed` });
    if (tests.relay?.word === "failed") list.push({ href: "#ad-mail", word: "relay failed" });
    if (tests.mailbox?.word === "failed" || (!tests.mailbox && view.mailbox?.verificationState === "failed")) {
      list.push({ href: "#ad-mail", word: "mailbox failed" });
    }
    return list;
  });

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
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    history.replaceState(history.state, "", `#${id}`);
    target.focus({ preventScroll: true });
  }

  /* ── people ───────────────────────────────────────────────────────────── */
  /** @type {string | null} */
  let peopleProblem = $state(null);
  /** @type {?(Awaited<ReturnType<typeof sendSetupLink>> & { userId?: string })} */
  let delivery = $state(null);

  let inviteOpen = $state(false);
  let inviteArmed = $state(false);
  let invitePassword = $state("");
  let inviteBusy = $state(false);
  /** @type {string | null} */
  let inviteProblem = $state(null);

  function openInvite() {
    inviteProblem = null;
    inviteArmed = false;
    invitePassword = "";
    inviteOpen = true;
  }

  /** @param {number} days @param {-1 | 1} by */
  const stepped = (days, by) => Math.min(SETUP_LINK_DAYS.max, Math.max(SETUP_LINK_DAYS.min, Number(days) + by));

  async function invite() {
    if (inviteBusy) return;
    if (!inviteArmed && provenIntent !== "local_user_create") {
      await challenge("local_user_create", () => (inviteArmed = true), (message) => (inviteProblem = message));
      return;
    }
    inviteBusy = true;
    inviteProblem = null;
    try {
      const answer = await createLocalUser({
        email: draft.email,
        displayName: draft.displayName,
        expiresInDays: Number(draft.expiresInDays),
        ...(actorHasPassword ? { currentPassword: invitePassword } : {}),
      });
      delivery = { ...answer, userId: answer.user?.id };
      inviteArmed = false;
      invitePassword = "";
      spent();
      inviteOpen = false;
      if (answer.sendError) {
        wake(`${answer.sentTo} was created, but ${sendWords(answer.sendError)}`, { failure: true });
      } else {
        wake(`setup link sent to ${answer.sentTo} · valid until ${lapses(answer.expiresAt)}`);
        draft = { email: "", displayName: "", expiresInDays: SETUP_LINK_DAYS.fallback };
      }
      await reread();
    } catch (error) {
      inviteProblem = setupWords(error);
    } finally {
      inviteBusy = false;
    }
  }

  /* A fresh setup link: the person's own act, and the Retry under a failed
     send. Issuing one kills the earlier link (ADR-0023 §3). */
  /** @type {Person | null} */
  let resendFor = $state(null);
  let resendOpen = $state(false);
  let resendDays = $state(SETUP_LINK_DAYS.fallback);
  let resendPassword = $state("");
  let resendBusy = $state(false);
  /** @type {string | null} */
  let resendProblem = $state(null);

  /** @param {Person} person */
  function openResend(person) {
    peopleProblem = null;
    challenge("setup_link_issue", () => {
      resendFor = person;
      resendDays = SETUP_LINK_DAYS.fallback;
      resendPassword = "";
      resendProblem = null;
      resendOpen = true;
    }, (message) => (peopleProblem = message));
  }

  async function resend() {
    const person = resendFor;
    if (!person || resendBusy) return;
    resendBusy = true;
    resendProblem = null;
    try {
      const answer = await sendSetupLink(person.id, {
        expiresInDays: Number(resendDays),
        ...(actorHasPassword ? { currentPassword: resendPassword } : {}),
      });
      resendOpen = false;
      resendPassword = "";
      spent();
      if (delivery?.userId === person.id) delivery = { ...answer, userId: person.id };
      if (answer.sendError) wake(sendWords(answer.sendError), { failure: true });
      else wake(`setup link sent to ${answer.sentTo} · valid until ${lapses(answer.expiresAt)}`);
    } catch (error) {
      resendProblem = setupWords(error);
    } finally {
      resendBusy = false;
    }
  }

  /* Placing a person in a system (§11, #453): the systems are the rows. */
  /** @type {Person | null} */
  let placing = $state(null);
  let placeOpen = $state(false);
  /** @param {System} system */
  async function place(system) {
    const person = placing;
    if (!person) return;
    placeOpen = false;
    peopleProblem = null;
    try {
      await addMember(system.id, person.id);
      wake(`${person.displayName} is in ${system.name}`);
      await reread();
    } catch (error) {
      peopleProblem = said(error);
      wake(peopleProblem, { failure: true });
    }
  }

  /**
   * The acts behind a person's row (§2.12, §25). None on your own row.
   * The words are short on purpose: the kit's tray leaves the name 120px,
   * and §2.12's "place in a system · new setup link · disable" needs 370px
   * where a 360 screen has 186. Each keeps its full accessible name.
   * @param {Person} person
   * @returns {import('$lib/pocket/row.js').RowAct[]}
   */
  const personActs = (person) => person.id === meId ? [] : [
    { label: "place", name: `Place ${person.displayName} in a system`, tone: "accent",
      onact: () => { placing = person; placeOpen = true; } },
    { label: "link", name: `Send ${person.displayName} a new setup link`, tone: "accent",
      onact: () => openResend(person) },
    person.disabledAt
      ? { label: "enable", name: `Enable ${person.displayName}`, tone: "ok", onact: () => disable(person, false) }
      /* Reversible, so it acts at once and the wake offers undo (§1.13),
         rather than arming like an act that cannot be taken back. */
      : { label: "disable", name: `Disable ${person.displayName}`, tone: "warm", onact: () => disable(person, true) },
  ];

  /** @param {Person} person @param {boolean} off */
  async function disable(person, off) {
    peopleProblem = null;
    try {
      await setUserDisabled(person.id, off);
      if (off) wake(`${person.displayName} is disabled · they can’t sign in`, { undo: () => disable(person, false) });
      else wake(`${person.displayName} can sign in again`);
      await reread();
    } catch (error) {
      peopleProblem = said(error);
      wake(peopleProblem, { failure: true });
    }
  }

  /* ── systems ──────────────────────────────────────────────────────────── */
  let systemOpen = $state(false);
  let systemName = $state("");
  let systemPassword = $state("");
  let systemBusy = $state(false);
  /** @type {string | null} */
  let systemProblem = $state(null);
  /** @type {string | null} */
  let systemsProblem = $state(null);

  function openNewSystem() {
    systemsProblem = null;
    challenge("system_create", () => {
      systemName = "";
      systemPassword = "";
      systemProblem = null;
      systemOpen = true;
    }, (message) => (systemsProblem = message));
  }

  /** Choosing the owner is the submit, as on the desk (#1052). @param {Person} owner */
  async function createSystemFor(owner) {
    if (systemBusy) return;
    if (!systemName.trim()) { systemProblem = "name the system first"; return; }
    systemBusy = true;
    systemProblem = null;
    try {
      await createSystem({
        name: systemName.trim(),
        ownerId: owner.id,
        ...(actorHasPassword ? { currentPassword: systemPassword } : {}),
      });
      const named = systemName.trim();
      systemOpen = false;
      systemPassword = "";
      spent();
      wake(`${named} is made · ${owner.displayName} owns it`);
      await reread();
    } catch (error) {
      systemProblem = setupWords(error);
    } finally {
      systemBusy = false;
    }
  }

  /* A system's ring wears its real due-state dots, as on the desk. */
  /** @type {Record<string, string>} */
  const TONE = { "--warm": "--warm", "--ok": "--ok", "--upcoming": "--upcoming", "--overdue": "--overdue" };
  /** @param {System} system */
  const ringDots = (system) => view
    ? constellationPlanetsOf(system.items ?? [], view.today).map(([x, y, r, tone]) => ({
      cx: 17 + x / 6, cy: 17 + y / 6, r: 1 + r / 4, tone: TONE[tone] ?? "--ok",
    }))
    : [];
  /** @param {System} system */
  const systemMeta = (system) => [
    count(system.memberCount ?? 0, "member"),
    view?.owners[system.id] ? `owner ${view.owners[system.id]}` : null,
    count((system.items ?? []).length, "item"),
  ].filter(Boolean).join(" · ");

  /* A system on the clock (§2.11, §19 "56 b the row", "57 admin only"). */
  const recoverable = $derived(view?.recoverable ?? []);
  /** @param {string} iso */
  const daysLeft = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.parse(view?.now ?? new Date().toISOString())) / 86_400_000));
  /** @param {string} iso */
  const goneOn = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  /** @param {{ deleteAfter: string }} row */
  const expired = (row) => Date.parse(row.deleteAfter) <= Date.parse(view?.now ?? new Date().toISOString());
  /** What was said on a row after its act, keyed by the system's id. @type {Record<string, { ok: boolean, text: string }>} */
  let clockSaid = $state({});
  /** @param {{ id: string, name: string }} row */
  async function restore(row) {
    try {
      await restoreHousehold(row.id);
      clockSaid[row.id] = { ok: true, text: `restored · ${row.name} is back exactly as it was` };
      await reread();
    } catch (error) {
      clockSaid[row.id] = { ok: false, text: `not restored — ${said(error)}` };
    }
  }
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
    try {
      await hardDeleteHousehold(row.id, typedName);
      doomOpen = false;
      gone = [...gone, { id: row.id, text: `deleted · ${row.name} is gone for good · its members keep their accounts` }];
      await reread();
    } catch (error) {
      doomProblem = `not deleted — ${said(error)}`;
    }
  }
  /** Rows replaced by their said-line after a hard delete. @type {{ id: string, text: string }[]} */
  let gone = $state([]);
  /** @param {{ id: string, name: string, deleteAfter: string }} row @returns {import('$lib/pocket/row.js').RowAct[]} */
  const clockActs = (row) => [
    { label: "delete now", name: `Delete ${row.name} now, for good`, danger: true,
      onact: () => { doomed = row; typedName = ""; doomProblem = null; doomOpen = true; } },
  ];

  /* ── public contact (#860) ────────────────────────────────────────────── */
  let contactOpen = $state(false);
  let contactDraft = $state("");
  let contactBusy = $state(false);
  /** @type {string | null} */
  let contactProblem = $state(null);
  function openContact() {
    contactDraft = view?.contact?.address ?? "";
    contactProblem = null;
    contactOpen = true;
  }
  /** @param {{ action: "set", address: string } | { action: "clear" }} partial */
  async function contactAction(partial) {
    const current = view?.contact;
    if (!current || contactBusy) return;
    contactBusy = true;
    contactProblem = null;
    try {
      await commandContact({ ...partial, expectedVersion: current.version });
      contactOpen = false;
      wake(partial.action === "clear" ? "the public contact is cleared" : `the public contact is ${partial.address}`);
      await reread();
    } catch (error) {
      contactProblem = said(error);
    } finally {
      contactBusy = false;
    }
  }

  /* ── mail machinery (#743) ────────────────────────────────────────────── */
  /** @type {string | null} */
  let mailBusy = $state(null);
  /** @type {string | null} */
  let mailOutcome = $state(null);
  /** @type {string | null} */
  let mailProblem = $state(null);
  let mailPassword = $state("");
  let rotateOpen = $state(false);
  let editOpen = $state(false);
  const PROVIDER_PROFILES = ["mailcow", "gmail", "outlook", "other"];
  let mailDraft = $state({
    host: "", port: 993, accountUser: "", mailbox: "INBOX", tlsServerName: "",
    providerProfile: "other", trustedRecipientHeader: "X-Original-To", pollSeconds: 300,
  });

  function openMailEditor() {
    const current = view?.mailbox;
    if (current?.configured) {
      mailDraft = {
        host: current.host, port: current.port, accountUser: current.accountUser,
        mailbox: current.mailbox, tlsServerName: current.tlsServerName,
        providerProfile: current.providerProfile,
        trustedRecipientHeader: current.trustedRecipientHeader || "X-Original-To",
        pollSeconds: current.pollSeconds,
      };
    }
    mailPassword = "";
    mailProblem = null;
    editOpen = true;
  }

  /**
   * One mailbox action, folded back into the screen from the server's own
   * account. A refused credential keeps its sheet open, minus the password.
   * @param {string} label @param {object} command
   */
  async function mailAction(label, command) {
    mailBusy = label;
    mailProblem = null;
    mailOutcome = null;
    try {
      const answer = await commandMailbox(command);
      await reread();
      mailOutcome = answer.outcome ?? null;
      if (!answer.outcome || answer.outcome === "verified") { editOpen = false; rotateOpen = false; }
      mailPassword = "";
    } catch (error) {
      mailProblem = said(error);
    } finally {
      mailBusy = null;
    }
  }
  const mailOk = $derived(mailOutcome === "verified" || mailOutcome === "delivered");

  /* The two tests (#1071): a pill on its row that stays until the next
     test. The server does not remember the answer yet, so a reload forgets
     it. */
  /** @type {{ mailbox: (ReturnType<typeof testVerdict> & { at: string }) | null, relay: (ReturnType<typeof testVerdict> & { at: string }) | null }} */
  let tests = $state({ mailbox: null, relay: null });
  /** @type {"mailbox" | "relay" | null} */
  let testing = $state(null);
  const TESTS = /** @type {const} */ (["mailbox", "relay"]);
  /** @param {"mailbox" | "relay"} which */
  async function runTest(which) {
    if (testing) return;
    testing = which;
    try {
      const { result } = await testMail(which);
      tests[which] = { ...testVerdict(result), at: new Date().toISOString() };
    } catch (error) {
      tests[which] = { word: "failed", tone: "over", reason: said(error), at: new Date().toISOString() };
    } finally {
      testing = null;
    }
  }
  /** @param {"mailbox" | "relay"} which */
  const testMeta = (which) => {
    const test = tests[which];
    if (testing === which) return "checking now";
    if (!test) return which === "mailbox" ? "not tested this visit" : "not tested this visit";
    return [test.reason, "just now"].filter(Boolean).join(" · ");
  };

  /* Rotate every address (§2.12 7): the administrator chooses how long the
     old addresses keep working, 0 to 90 days (mailbox-settings.ts). */
  let aliasOpen = $state(false);
  let graceDays = $state(30);
  /** @param {number} by */
  const graceStep = (by) => (graceDays = Math.min(90, Math.max(0, graceDays + by)));

  /* ── document jobs (#1071) ───────────────────────────────────────────── */
  /** @type {Record<string, { status: string, at: string }>} */
  let retried = $state({});
  const jobs = $derived.by(() => {
    const list = (view?.operations?.documentJobs ?? []).map((job) => retried[job.id]
      ? { ...job, status: /** @type {typeof job.status} */ (retried[job.id].status), attempts: 0, updatedAt: retried[job.id].at }
      : job);
    return list.sort((a, b) => (JOB_STATES[a.status]?.rank ?? 9) - (JOB_STATES[b.status]?.rank ?? 9)
      || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  });
  const jobCounts = $derived.by(() => {
    /** @type {Record<string, number>} */
    const by = {};
    for (const job of jobs) by[job.status] = (by[job.status] ?? 0) + 1;
    return ["failed", "retry", "processing", "pending", "completed"].filter((status) => by[status])
      .map((status) => `${by[status]} ${JOB_STATES[status].word}`).join(" · ");
  });
  const clock = $derived(view?.now ?? new Date().toISOString());
  /** @param {(typeof jobs)[number]} job */
  const jobMeta = (job) => {
    const tries = count(job.attempts, "try", "tries");
    if (job.status === "failed") return `${JOB_REASONS[job.lastErrorCode ?? "unknown"] ?? JOB_REASONS.unknown} · ${tries} · last tried ${ago(job.updatedAt, clock)}`;
    if (job.status === "retry") return `${job.lastErrorCode ? `${JOB_REASONS[job.lastErrorCode] ?? JOB_REASONS.unknown} · ` : ""}${tries} · last tried ${ago(job.updatedAt, clock)}`;
    if (job.status === "pending") return retried[job.id] ? "attempt 1 · queued just now" : `queued ${ago(job.createdAt, clock)}`;
    if (job.status === "processing") return `started ${ago(job.updatedAt, clock)}`;
    return `${JOB_STATES[job.status]?.word ?? job.status} ${ago(job.updatedAt, clock)}`;
  };
  /** @type {string | null} */
  let jobsProblem = $state(null);
  /** @param {(typeof jobs)[number]} job */
  async function retry(job) {
    jobsProblem = null;
    try {
      await retryDocumentJob(job.id, job.status);
      retried[job.id] = { status: "pending", at: new Date().toISOString() };
      wake(`${JOB_KINDS[job.kind] ?? job.kind} is queued to try again`);
    } catch (error) {
      jobsProblem = said(error);
    }
  }

  /* ── operations (#1000) ───────────────────────────────────────────────── */
  /** @type {Record<string, string>} */
  const BODY = { ok: "ok", warm: "soon", overdue: "over", "ink-quiet": "ended" };
  /** @type {Record<string, string>} */
  const INK = { ok: "var(--ok-text)", warm: "var(--warm-text)", overdue: "var(--overdue-text)", "ink-quiet": "var(--ink-quiet)" };
  /** "healthy · 40s ago" → the word on the trail, the rest as the meta. @param {string} detail */
  const split = (detail) => {
    const [word, ...rest] = detail.split(" · ");
    return { word, rest: rest.join(" · ") };
  };
  /** @type {number | null} */
  let serviceAt = $state(null);
  let serviceOpen = $state(false);
  const service = $derived(serviceAt === null || !view ? null : view.services[serviceAt] ?? null);
  const serviceRaw = $derived(serviceAt === null ? null : view?.health?.services[serviceAt] ?? null);

  /* Under fixtures `?localuser=` names a delivery, as on the desk, so both
     outcomes of an invitation can be photographed (#915). */
  onMount(() => {
    if (!fixtures) return;
    const wanted = new URLSearchParams(location.search).get("localuser");
    if (wanted) delivery = /** @type {any} */ (SETUP_LINK_FIXTURES)[wanted] ?? SETUP_LINK_FIXTURES.sent;
  });
  /* Back from the identity provider with a proof: pick the invitation up. */
  $effect(() => {
    if (provenIntent === "local_user_create" && view) inviteOpen = true;
  });
</script>

<div class="ad-pocket">
  <main class="ad-column">
    <header class="ad-head ad-rise" style:--i="0">
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
        <p class="ad-sub">the instance from above{view ? ` · ${count(people.length, "person", "people")} · ${count(systems.length, "system")}` : ""}</p>
      </div>
    </header>

    {#if tells.length}
      <nav class="ad-tells ad-rise" style:--i="0" aria-label="Needs you">
        {#each tells as tell (tell.word)}
          <a class="ad-tell" href={tell.href} onclick={(event) => jump(event, tell.href.slice(1))}>{tell.word}</a>
        {/each}
      </nav>
    {/if}

    <!-- THE JUMP STRIP (§2.12): the one page that has one, because it is the
         longest screen. Anchors, not tabs: nothing is selected, and each is a
         plain link that works without script. -->
    <nav class="ad-jump ad-rise" style:--i="1" aria-label="Jump to a card">
      {#each JUMPS as [word, id], i (id)}
        <a class="ad-chip" href="#{id}" style:--j={i} onclick={(event) => jump(event, id)}><span>{word}</span></a>
      {/each}
    </nav>

    {#if !view}
      <section class="p-card ad-card ad-loading" aria-label="Loading administration">
        <div class="p-unlit"></div><div class="p-unlit"></div><div class="p-unlit"></div>
      </section>
    {:else}
      {#if alerts.length}
        <section class="ad-alerts" aria-label="Alerts" data-ad="alerts">
          {#each alerts as alert, i (alert.id)}
            <article class="p-card ad-alert ad-rise" style:--i={2 + i} aria-labelledby="ad-alert-{alert.id}">
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
      <section class="p-card ad-card ad-flush ad-rise" class:proposed={people.length <= 1} style:--i="3"
               id="ad-people" tabindex="-1" aria-labelledby="ad-people-head" data-ad="people">
        <div class="ad-cardhead">
          <h2 class="p-caps" id="ad-people-head">People · {people.length}</h2>
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
          <p class="ad-said ok" role="status">setup link sent to {delivery.sentTo} · valid until {lapses(delivery.expiresAt)}</p>
        {/if}
        {#each people as person (person.id)}
          <Row title="{person.displayName}{person.id === meId ? ' · you' : ''}"
               meta={[person.email, person.disabledAt ? "disabled" : view.peopleMeta[person.id]].filter(Boolean).join(" · ")}
               trail={person.isInstanceAdmin ? "admin" : "user"}
               trailTone={person.isInstanceAdmin ? "var(--accent-text)" : ""} acts={personActs(person)}>
            {#snippet mark()}<span class="p-avatar" class:owner={person.isInstanceAdmin} class:ad-off={person.disabledAt}>{initialsOf(person.displayName)}</span>{/snippet}
          </Row>
        {/each}
        {#if people.length <= 1}<p class="p-empty ad-inset">only you so far</p>{/if}
        {#if peopleProblem}<p class="p-error ad-inset ad-lastline" role="alert">{peopleProblem}</p>{/if}
      </section>

      <!-- SYSTEMS (§2.12 5). -->
      <section class="p-card ad-card ad-flush ad-rise" class:proposed={systems.length === 0} style:--i="4"
               id="ad-systems" tabindex="-1" aria-labelledby="ad-systems-head" data-ad="systems">
        <div class="ad-cardhead">
          <h2 class="p-caps" id="ad-systems-head">Systems · {systems.length}</h2>
          <button class="p-pill act-accent" onclick={openNewSystem}>new system</button>
        </div>
        {#each systems as system (system.id)}
          <Row title={system.name} meta={systemMeta(system)}>
            {#snippet mark()}
              <svg class="ad-ring" width="30" height="30" viewBox="0 0 34 34" aria-hidden="true">
                <circle cx="17" cy="17" r="13" fill="none" style="stroke:var(--chart-line)"/>
                <circle cx="17" cy="17" r="2.6" style="fill:var({system.id === view.primary ? '--sun' : '--ink-mid'})"/>
                {#each ringDots(system) as dot (dot.cx + "-" + dot.cy)}
                  <circle cx={dot.cx} cy={dot.cy} r={dot.r} style="fill:var({dot.tone})" opacity=".85"/>
                {/each}
              </svg>
            {/snippet}
          </Row>
        {:else}
          {#if !recoverable.length}<p class="p-empty ad-inset">no systems yet</p>{/if}
        {/each}
        {#each gone as line (line.id)}
          <p class="ad-said ok" role="status">{line.text}</p>
        {/each}
        <!-- ON THE CLOCK (§2.11, §19): the system's own row carries the state;
             `restore` stays on show because it is the point of the row, and
             `delete now` sits behind the swipe. Never on the household page. -->
        {#each recoverable.filter((row) => !gone.some((line) => line.id === row.id)) as row (row.id)}
          <Row title={row.name} metaFace="ui"
               meta={expired(row) ? "past its window · waiting to be removed for good"
                 : `on the clock · ${count(daysLeft(row.deleteAfter), "day")} left · gone for good ${goneOn(row.deleteAfter)}`}
               acts={expired(row) ? [] : clockActs(row)}>
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
              {#if !expired(row)}
                <ArmButton label="restore" armedLabel="tap again to restore {row.name}" name="Restore {row.name}"
                           danger={false} class="act-accent" onfire={() => restore(row)} />
              {/if}
            {/snippet}
          </Row>
        {/each}
        {#if systemsProblem}<p class="p-error ad-inset ad-lastline" role="alert">{systemsProblem}</p>{/if}
      </section>

      <!-- PUBLIC CONTACT (§2.12 6, #860). -->
      <section class="p-card ad-card ad-flush ad-rise" style:--i="5" id="ad-contact" tabindex="-1"
               aria-labelledby="ad-contact-head" data-ad="contact">
        <div class="ad-cardhead"><h2 class="p-caps" id="ad-contact-head">Public contact</h2></div>
        {#if view.contact}
          <Row title={view.contact.address ?? "not set"} metaFace="ui"
               meta="shown on the sign-in door if it can’t open safely"
               trail={view.contact.address ? "change" : "set"} trailTone="var(--accent-text)"
               trailName={view.contact.address ? "change the public contact" : "set the public contact"}
               onactivate={openContact}>
            {#snippet mark()}<span class="ad-kmark">@</span>{/snippet}
          </Row>
        {:else}
          <p class="p-error ad-inset ad-lastline" role="alert">the public contact couldn’t be read · the rest of the page still works</p>
        {/if}
      </section>

      <!-- MAIL MACHINERY (§2.12 7, §15, #743). -->
      <section class="p-card ad-card ad-flush ad-rise" style:--i="6" id="ad-mail" tabindex="-1"
               aria-labelledby="ad-mail-head" data-ad="mail">
        <div class="ad-cardhead">
          <h2 class="p-caps" id="ad-mail-head">Mail machinery</h2>
          <div class="p-pills ad-headpills">
            <button class="p-pill act-accent" disabled={testing !== null} onclick={() => runTest("mailbox")}>test this mailbox</button>
            <button class="p-pill act-accent" disabled={testing !== null} onclick={() => runTest("relay")}>test the relay</button>
          </div>
        </div>
        {#each TESTS as which (which)}
          {@const test = tests[which]}
          {#if test || testing === which}
            <Row title={which === "mailbox" ? "incoming mailbox" : "outgoing relay"} metaFace="ui" meta={testMeta(which)}>
              {#snippet mark()}<span class="p-body {testing === which ? 'up breathing' : test?.tone ?? 'ended'}"></span>{/snippet}
              {#snippet end()}
                <span class="ad-state {testing === which ? 'up ad-checking' : test?.tone ?? ''}">{testing === which ? "checking…" : test?.word}</span>
              {/snippet}
            </Row>
          {/if}
        {/each}
        {#each view.relay as [label, value, extra] (label)}
          <Row title={label} meta={value} trail={extra === "on" ? "on" : ""} trailTone="var(--ok-text)">
            {#snippet mark()}<span class="p-body {extra === 'on' ? 'ok' : 'ended'}"></span>{/snippet}
          </Row>
        {/each}
        {#if view.mailbox?.configured}
          <Row title="every address" metaFace="ui" meta="issue every member a new relay address; the old ones keep working for a while"
               trail="rotate" trailTone="var(--warm-text)" trailName="rotate every address"
               onactivate={() => { graceDays = 30; mailProblem = null; aliasOpen = true; }}>
            {#snippet mark()}<span class="ad-kmark">↻</span>{/snippet}
          </Row>
        {/if}
        {#if view.mailbox}
          {@const mailbox = view.mailbox}
          <Row title="verification" meta="{plainly(mailbox.verificationState)} · {stamp(mailbox.verifiedAt)}"
               trail={mailbox.verificationState === "verified" ? "passed" : mailbox.verificationState === "failed" ? "failed" : ""}
               trailTone={mailbox.verificationState === "failed" ? "var(--overdue-text)" : "var(--ok-text)"}>
            {#snippet mark()}<span class="p-body {mailbox.verificationState === 'verified' ? 'ok' : mailbox.verificationState === 'failed' ? 'over' : 'ended'}"></span>{/snippet}
          </Row>
          {#if mailbox.configured}
            {#each [
              ["credential set", `${stamp(mailbox.credentialSetAt)}${mailbox.credentialSetBy ? ` · ${mailbox.credentialSetBy}` : ""}`],
              ["address shape", mailbox.aliasPattern ?? "—"],
              ["envelope header", mailbox.trustedRecipientHeader || "not set"],
              ["provider profile", mailbox.providerProfile],
              ["tls name", mailbox.tlsServerName || mailbox.host],
            ] as [label, value] (label)}
              <Row title={label} meta={value}>
                {#snippet mark()}<span class="p-body ended"></span>{/snippet}
              </Row>
            {/each}
            <div class="ad-foot">
              <div class="p-pills">
                <button class="p-pill act-accent" onclick={openMailEditor}>change mailbox</button>
                <button class="p-pill act-accent" disabled={mailBusy !== null}
                        onclick={() => mailAction("probe", { action: "probe" })}>{mailBusy === "probe" ? "probing…" : "run setup probe"}</button>
                <button class="p-pill act-warm" disabled={mailBusy !== null}
                        onclick={() => mailAction("enabled", { action: mailbox.enabled ? "disable" : "enable", expectedVersion: mailbox.version })}>
                  {mailbox.enabled ? "pause ingest" : "resume ingest"}</button>
                <button class="p-pill" disabled={mailBusy !== null}
                        onclick={() => { mailPassword = ""; mailProblem = null; rotateOpen = true; }}>rotate password</button>
              </div>
              <ArmButton label="remove credential" armedLabel="tap again to remove the credential" wide
                         onfire={() => mailAction("remove", { action: "remove", expectedVersion: mailbox.version })} />
            </div>
          {:else}
            <div class="ad-foot"><button class="p-pill act-accent wide" onclick={openMailEditor}>set up mailbox</button></div>
          {/if}
        {/if}
        {#if mailOutcome}<p class="ad-said {mailOk ? 'ok' : 'warn'} ad-lastline" role="status">{plainly(mailOutcome)}</p>{/if}
        {#if mailProblem}<p class="p-error ad-inset ad-lastline" role="alert">{mailProblem}</p>{/if}
      </section>

      <!-- OPERATIONS (§2.12 8, #1000): tap a row for its last check. -->
      <section class="p-card ad-card ad-flush ad-rise" style:--i="7" id="ad-operations" tabindex="-1"
               aria-labelledby="ad-ops-head" data-ad="operations">
        <div class="ad-cardhead"><h2 class="p-caps" id="ad-ops-head">Operations</h2></div>
        {#each view.services as [tone, name, detail], at (name)}
          {@const words = split(detail)}
          <Row title={name} meta={words.rest} trail={words.word} trailTone={INK[tone] ?? ""}
               onactivate={() => { serviceAt = at; serviceOpen = true; }}>
            {#snippet mark()}<span class="p-body {BODY[tone] ?? 'ended'}" class:breathing={tone === "warm"}></span>{/snippet}
          </Row>
        {/each}
      </section>

      <!-- DOCUMENT JOBS (#1071, #1055 round 2): one row per job, kind only,
           the reason on the row for good, `retry` on show on a failed row. -->
      {#if view.operations}
        <section class="p-card ad-card ad-flush ad-rise" class:proposed={jobs.length === 0} style:--i="8"
                 id="ad-documents" tabindex="-1" aria-labelledby="ad-docs-head" data-ad="documents">
          <div class="ad-cardhead">
            <h2 class="p-caps" id="ad-docs-head">Document jobs</h2>
            {#if jobCounts}<p class="ad-count">{jobCounts}</p>{/if}
          </div>
          {#each jobs as job (job.id)}
            {@const state = JOB_STATES[job.status] ?? { word: job.status, tone: "" }}
            <Row title={JOB_KINDS[job.kind] ?? job.kind} metaFace="ui" meta={jobMeta(job)}>
              {#snippet mark()}<span class="p-body {state.tone || 'ended'}" class:failed={job.status === "failed"}></span>{/snippet}
              {#snippet end()}<span class="ad-state {state.tone}">{state.word}</span>{/snippet}
              {#snippet below()}
                {#if job.status === "failed"}
                  <button class="p-pill act-accent" aria-label="Retry the {(JOB_KINDS[job.kind] ?? job.kind).toLowerCase()}"
                          onclick={() => retry(job)}>retry</button>
                {/if}
              {/snippet}
            </Row>
          {:else}
            <p class="p-empty ad-inset">no document jobs yet</p>
          {/each}
          {#if jobsProblem}<p class="p-error ad-inset" role="alert">{jobsProblem}</p>{/if}
          <p class="ad-note ad-jobsfoot">the 25 most recently touched jobs are kept; older ones are not</p>
        </section>
      {/if}

      <p class="ad-strip">{view.instance}</p>
    {/if}
  </main>

  <!-- ── sheets ─────────────────────────────────────────────────────────── -->
  <Sheet bind:open={readingOpen} size="list" title={reading?.title ?? "What to do"}>
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
        good. Run <code>orbit backup</code> then <code>orbit export-recovery-bundle &lt;backup.tar&gt;</code> to make one.</p>
      <p class="p-prose ad-sheet-say">Keep its two parts apart: the bundle file on storage separate from this instance, and
        its passphrase in a password manager or on paper — never both together, because that separation is what keeps
        anyone who gets hold of the file alone from being able to use it. This reappears after every encryption-key
        rotation, because a bundle wrapped under the previous key can no longer recover the current one. “Exporting a
        recovery bundle” in the administrator guide has the steps.</p>
    {/if}
  </Sheet>

  <Sheet bind:open={inviteOpen} size="callout" title="Invite someone">
    <form onsubmit={(event) => { event.preventDefault(); invite(); }}>
      <label class="ad-label" for="ad-inv-email">email</label>
      <input id="ad-inv-email" class="ad-input" type="email" inputmode="email" autocomplete="off" enterkeyhint="next"
             placeholder="newcomer@example.com" bind:value={draft.email} required>
      <label class="ad-label" for="ad-inv-name">display name</label>
      <input id="ad-inv-name" class="ad-input" autocomplete="off" enterkeyhint="done" placeholder="their name"
             bind:value={draft.displayName} required>
      <p class="ad-label" id="ad-inv-days">link valid for</p>
      <div class="ad-stepper" role="group" aria-labelledby="ad-inv-days">
        <button type="button" class="p-pill" aria-label="One day fewer" disabled={Number(draft.expiresInDays) <= SETUP_LINK_DAYS.min}
                onclick={() => (draft.expiresInDays = stepped(draft.expiresInDays, -1))}>−</button>
        <output aria-live="polite">{count(Number(draft.expiresInDays), "day")}</output>
        <button type="button" class="p-pill" aria-label="One day more" disabled={Number(draft.expiresInDays) >= SETUP_LINK_DAYS.max}
                onclick={() => (draft.expiresInDays = stepped(draft.expiresInDays, 1))}>+</button>
      </div>
      {#if inviteArmed && actorHasPassword}
        <label class="ad-label" for="ad-inv-current">your current password</label>
        <input id="ad-inv-current" class="ad-input" type="password" autocomplete="current-password" enterkeyhint="send"
               bind:value={invitePassword} required>
      {/if}
      <p class="ad-note">Orbit mails them a link to choose their own password. The link is never shown here.</p>
      <button class="p-pill filled wide ad-sheet-act" type="submit" disabled={inviteBusy}>
        {inviteBusy ? "creating…" : inviteArmed || provenIntent === "local_user_create" ? "create and send the link" : "create"}</button>
      {#if inviteProblem}<p class="p-error" role="alert">{inviteProblem}</p>{/if}
    </form>
  </Sheet>

  <Sheet bind:open={resendOpen} size="callout" title="New setup link">
    {#if resendFor}
      <form onsubmit={(event) => { event.preventDefault(); resend(); }}>
        <p class="p-prose ad-sheet-say">A fresh link goes to {resendFor.email ?? resendFor.displayName}. The one before it stops working.</p>
        <p class="ad-label" id="ad-re-days">link valid for</p>
        <div class="ad-stepper" role="group" aria-labelledby="ad-re-days">
          <button type="button" class="p-pill" aria-label="One day fewer" disabled={resendDays <= SETUP_LINK_DAYS.min}
                  onclick={() => (resendDays = stepped(resendDays, -1))}>−</button>
          <output aria-live="polite">{count(resendDays, "day")}</output>
          <button type="button" class="p-pill" aria-label="One day more" disabled={resendDays >= SETUP_LINK_DAYS.max}
                  onclick={() => (resendDays = stepped(resendDays, 1))}>+</button>
        </div>
        {#if actorHasPassword}
          <label class="ad-label" for="ad-re-current">your current password</label>
          <input id="ad-re-current" class="ad-input" type="password" autocomplete="current-password" enterkeyhint="send"
                 bind:value={resendPassword} required>
        {/if}
        <button class="p-pill filled wide ad-sheet-act" type="submit" disabled={resendBusy}>{resendBusy ? "sending…" : "send it"}</button>
        {#if resendProblem}<p class="p-error" role="alert">{resendProblem}</p>{/if}
      </form>
    {/if}
  </Sheet>

  <Sheet bind:open={placeOpen} size="list" title="Place {placing?.displayName ?? 'them'} in a system">
    <div class="ad-flushrows">
      {#each systems as system (system.id)}
        <Row title={system.name} meta={systemMeta(system)} trail="place" trailTone="var(--accent-text)"
             trailName="place {placing?.displayName ?? 'them'} in {system.name}" onactivate={() => place(system)}>
          {#snippet mark()}<span class="ad-kmark">◯</span>{/snippet}
        </Row>
      {/each}
    </div>
  </Sheet>

  <Sheet bind:open={systemOpen} size="list" title="New system">
    <label class="ad-label" for="ad-sys-name">name</label>
    <input id="ad-sys-name" class="ad-input" autocomplete="off" enterkeyhint="next" placeholder="Seaside Cottage"
           maxlength={NAME_LIMIT} bind:value={systemName}>
    {#if actorHasPassword}
      <label class="ad-label" for="ad-sys-current">your current password</label>
      <input id="ad-sys-current" class="ad-input" type="password" autocomplete="current-password" enterkeyhint="next"
             bind:value={systemPassword}>
    {/if}
    <p class="ad-label" id="ad-sys-owner">who will own it · tap to make it</p>
    <div class="ad-flushrows" role="group" aria-labelledby="ad-sys-owner">
      {#each people as person (person.id)}
        <Row title="{person.displayName}{person.id === meId ? ' · you' : ''}" meta={person.email ?? ""}
             trail="owner" trailTone="var(--accent-text)" trailName="make it, owned by {person.displayName}"
             onactivate={() => createSystemFor(person)}>
          {#snippet mark()}<span class="p-avatar">{initialsOf(person.displayName)}</span>{/snippet}
        </Row>
      {/each}
    </div>
    {#if systemProblem}<p class="p-error" role="alert">{systemProblem}</p>{/if}
  </Sheet>

  <Sheet bind:open={contactOpen} size="callout" title="Public contact">
    <form onsubmit={(event) => { event.preventDefault(); contactAction({ action: "set", address: contactDraft }); }}>
      <label class="ad-label" for="ad-contact-field">address</label>
      <input id="ad-contact-field" class="ad-input" type="email" inputmode="email" autocomplete="off" enterkeyhint="done"
             placeholder="ops@example.com" bind:value={contactDraft} required>
      <p class="ad-note">Shown on the sign-in door if it ever can’t open safely — never a real administrator’s own mailbox.
        Anyone can read it, signed in or not.</p>
      <div class="ad-sheet-act p-pills">
        {#if view?.contact?.address}
          <button class="p-pill danger" type="button" disabled={contactBusy} onclick={() => contactAction({ action: "clear" })}>clear</button>
        {/if}
        <button class="p-pill filled ad-grow" type="submit" disabled={contactBusy}>{contactBusy ? "saving…" : "save"}</button>
      </div>
      {#if contactProblem}<p class="p-error" role="alert">{contactProblem}</p>{/if}
    </form>
  </Sheet>

  <Sheet bind:open={rotateOpen} size="callout" title="Rotate the mailbox password">
    <form onsubmit={(event) => { event.preventDefault();
      if (view?.mailbox) mailAction("rotate", { action: "rotate", expectedVersion: view.mailbox.version, password: mailPassword }); }}>
      <label class="ad-label" for="ad-rot-pass">new password</label>
      <input id="ad-rot-pass" class="ad-input" type="password" autocomplete="new-password" enterkeyhint="done"
             bind:value={mailPassword} required>
      <p class="ad-note">It is proven against the provider before it’s kept; a refusal leaves the old one working.</p>
      <button class="p-pill filled wide ad-sheet-act" type="submit" disabled={mailBusy !== null}>
        {mailBusy === "rotate" ? "verifying…" : "verify and rotate"}</button>
      {#if mailProblem}<p class="p-error" role="alert">{mailProblem}</p>{/if}
    </form>
  </Sheet>

  <Sheet bind:open={editOpen} size="full" title={view?.mailbox?.configured ? "Change the mailbox" : "Set up the mailbox"}>
    <form class="ad-form" onsubmit={(event) => { event.preventDefault();
      if (view?.mailbox) mailAction("set", { action: "set", expectedVersion: view.mailbox.version, ...mailDraft, password: mailPassword }); }}>
      <label class="ad-label" for="ad-mb-host">host</label>
      <input id="ad-mb-host" class="ad-input" autocomplete="off" autocapitalize="off" bind:value={mailDraft.host} required>
      <label class="ad-label" for="ad-mb-port">port</label>
      <input id="ad-mb-port" class="ad-input" type="number" inputmode="numeric" min="1" max="65535" bind:value={mailDraft.port} required>
      <label class="ad-label" for="ad-mb-user">account</label>
      <input id="ad-mb-user" class="ad-input" autocomplete="off" autocapitalize="off" placeholder="intake@example.com"
             bind:value={mailDraft.accountUser} required>
      <label class="ad-label" for="ad-mb-folder">folder</label>
      <input id="ad-mb-folder" class="ad-input" autocapitalize="off" bind:value={mailDraft.mailbox} required>
      <label class="ad-label" for="ad-mb-tls">tls name</label>
      <input id="ad-mb-tls" class="ad-input" autocapitalize="off" placeholder="same as host" bind:value={mailDraft.tlsServerName}>
      <label class="ad-label" for="ad-mb-provider">provider</label>
      <select id="ad-mb-provider" class="ad-input" bind:value={mailDraft.providerProfile}>
        {#each PROVIDER_PROFILES as profile (profile)}<option value={profile}>{profile}</option>{/each}
      </select>
      <label class="ad-label" for="ad-mb-header">envelope header</label>
      <input id="ad-mb-header" class="ad-input" autocapitalize="off" bind:value={mailDraft.trustedRecipientHeader} required>
      <label class="ad-label" for="ad-mb-poll">poll seconds</label>
      <input id="ad-mb-poll" class="ad-input" type="number" inputmode="numeric" min="30" max="3600" bind:value={mailDraft.pollSeconds} required>
      <label class="ad-label" for="ad-mb-pass">password</label>
      <input id="ad-mb-pass" class="ad-input" type="password" autocomplete="new-password" bind:value={mailPassword} required>
      <p class="ad-note">Relay addresses are plus-addresses of this account, so it has to be one the provider delivers
        sub-addressed mail to. The password is stored encrypted and never shown again.</p>
      <button class="p-pill filled wide ad-sheet-act" type="submit" disabled={mailBusy !== null}>
        {mailBusy === "set" ? "verifying…" : "verify and save"}</button>
      {#if mailProblem}<p class="p-error" role="alert">{mailProblem}</p>{/if}
    </form>
  </Sheet>

  <Sheet bind:open={doomOpen} size="list" title="Delete {doomed?.name ?? 'it'} now?">
    {#if doomed}
      <p class="p-prose ad-sheet-say">Deleting now skips the {count(daysLeft(doomed.deleteAfter), "day")}. Nothing comes back
        after this — not for you, not for anyone.</p>
      <label class="ad-label" for="ad-doom-name">type the system’s name exactly to wake the button</label>
      <input id="ad-doom-name" class="ad-input" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"
             placeholder={doomed.name} bind:value={typedName}>
      <div class="ad-sheet-act">
        {#if nameOk}
          <ArmButton label="delete for good" armedLabel="tap again to delete for good" wide onfire={deleteNow} />
        {:else}
          <button class="p-pill danger wide" disabled>delete for good</button>
        {/if}
      </div>
      {#if doomProblem}<p class="p-error" role="alert">{doomProblem}</p>{/if}
    {/if}
  </Sheet>

  <Sheet bind:open={aliasOpen} size="callout" title="Rotate every address">
    <p class="p-prose ad-sheet-say">Every member gets a new relay address. Mail sent to an old one still arrives until its
      grace runs out.</p>
    <p class="ad-label" id="ad-grace">old addresses keep working for</p>
    <div class="ad-stepper" role="group" aria-labelledby="ad-grace">
      <button type="button" class="p-pill" aria-label="Seven days fewer" disabled={graceDays <= 0} onclick={() => graceStep(-7)}>−</button>
      <output aria-live="polite">{count(graceDays, "day")}</output>
      <button type="button" class="p-pill" aria-label="Seven days more" disabled={graceDays >= 90} onclick={() => graceStep(7)}>+</button>
    </div>
    <div class="ad-sheet-act">
      <ArmButton label="rotate every address" armedLabel="tap again to rotate every address" wide
                 onfire={() => { if (view?.mailbox) mailAction("alias", { action: "rotate_alias_key", expectedVersion: view.mailbox.version, graceDays }).then(() => { if (!mailProblem) { aliasOpen = false; wake("every address is new · the old ones keep working for " + count(graceDays, "day")); } }); }} />
    </div>
    {#if mailProblem}<p class="p-error" role="alert">{mailProblem}</p>{/if}
  </Sheet>

  <Sheet bind:open={serviceOpen} size="callout" title={service ? service[1] : "Service"}>
    {#if service}
      <div class="p-kv"><span>state</span><b class={BODY[service[0]] ?? ""}>{split(service[2]).word}</b></div>
      {#if serviceRaw}
        <div class="p-kv"><span>last checked</span><b>{stamp(serviceRaw.checkedAt)}</b></div>
        {#if serviceRaw.lastSuccessAt}<div class="p-kv"><span>last success</span><b>{stamp(serviceRaw.lastSuccessAt)}</b></div>{/if}
        {#if serviceRaw.lastErrorAt}<div class="p-kv"><span>last error</span><b class="over">{stamp(serviceRaw.lastErrorAt)}</b></div>{/if}
      {:else}
        <div class="p-kv"><span>last check</span><b>{split(service[2]).rest || "as shown"}</b></div>
      {/if}
      <p class="ad-note">Checked by this instance itself; nothing here leaves the machine.</p>
    {/if}
  </Sheet>
</div>

<style>
  /* THE DIALECT SWITCH: the same query as $lib/pocket/media.js. The desk's
     grid goes; its chrome stays (on a phone Chrome.svelte draws the kit's
     top chrome and the hatch), and so does the station, the page's
     observatory personality (CON-9), with every label it draws hidden
     because the screen's edge would cut them (§1.10) and the art dimmed one
     step (§5.2). */
  .ad-pocket{display:none}
  @media (max-width:900px), (max-height:600px){
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
    border:1px solid var(--line);background:var(--panel);color:var(--ink-mid);
    font:var(--p-type-meta)/1 var(--mono);white-space:nowrap}
  .ad-chip:active span{border-color:var(--accent);background:color-mix(in srgb, var(--accent) 14%, transparent);color:var(--accent-text)}
  .ad-chip:focus-visible{outline:none}
  .ad-chip:focus-visible span{outline:2px solid var(--accent);outline-offset:2px}
  @keyframes ad-chip{from{opacity:0;transform:translateX(12px)}}

  /* Cards arrive in turn, never in sync (§1.9). */
  .ad-rise{animation:ad-rise 420ms var(--p-ease) both;animation-delay:calc(var(--i, 0) * 60ms + 80ms)}
  @keyframes ad-rise{from{opacity:0;transform:translateY(10px)}}

  .ad-card{margin-top:var(--p-card-gap);scroll-margin-top:16px}
  .ad-card:focus{outline:none}
  .ad-flush{padding:0 0 4px}
  .ad-cardhead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
    padding:8px var(--p-gutter) 4px}
  .ad-cardhead .p-caps{margin:0}
  .ad-inset{margin-left:var(--p-gutter);margin-right:var(--p-gutter)}
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
  .ad-input{box-sizing:border-box;width:100%;min-height:48px;padding:0 14px;border-radius:12px;
    border:1px solid var(--line);background:color-mix(in srgb, var(--bg) 55%, transparent);color:var(--ink);
    font:var(--p-type-body)/1.2 var(--ui)}
  .ad-input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
  .ad-input::placeholder{color:var(--ink-quiet)}
  .ad-note{margin:12px 0 0;font:var(--p-type-meta)/1.5 var(--ui);color:var(--ink-quiet)}
  .ad-sheet-say{color:var(--ink-mid);margin:4px 0 12px}
  .ad-sheet-say code{font:var(--p-type-meta) var(--mono);color:var(--ink)}
  .ad-sheet-act{margin-top:16px}
  .ad-grow{flex:1}
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
  .ad-jobsfoot{margin:12px var(--p-gutter)}

  /* A disabled person dims; their row still swipes to enable. */
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
    .ad-craft,.ad-rise,.ad-chip,.ad-said,.ad-checking,.ad-clockring circle,.ad-clocksaid{animation:none}
  }
</style>
