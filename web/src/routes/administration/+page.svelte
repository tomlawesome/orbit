<script>
  import { onMount } from "svelte";
  import { addMember, commandContact, commandMailbox, commandUploadLimit, createLocalUser, createSystem, hardDeleteHousehold, readAdminScreen, readSignInMethods, restoreHousehold, retryDocumentJob, sendSetupLink, startStepUp, testMail, wordsOf } from "$lib/data/workspace.js";
  import { createArm } from "$lib/arm.js";
  import { deletionNameMatches } from "$lib/data/household.js";
  import { SETUP_LINK_FIXTURES } from "$lib/data/fixtures/admin.js";
  import { constellationPlanetsOf, galaxyOf } from "$lib/data/chart.js";
  import { NAME_LIMIT } from "$lib/arrival/stage.js";
  import { rollSeed, seedFromWorkspace } from "$lib/sky.js";
  import { mountStation } from "$lib/backdrops/station.js";
  import { ago, dayMonth, initials, plural } from "$lib/format.js";
  import Chrome from "$lib/Chrome.svelte";
  import { isPocket } from "$lib/pocket/media.js";
  import Pocket from "./pocket.svelte";
  import {
    JOB_KINDS, JOB_REASONS, JOB_STATES, SETUP_LINK_DAYS, lapses, megabytes,
    openFor, plainly, sendWords, setupWords, stamp, testVerdict,
  } from "./words.js";
  import "./administration.css";

  /**
   * Administration — mission control (#465). Built from
   * design/v19/administration.html (ratified §13): the instance from above.
   * Admins see everything by design (§11); admins can place anyone anywhere.
   * People come from the real /api/admin/users route; ownership and
   * membership counts are the #453 epic's admin surface and render from the
   * fixture until it lands. Each system's ring wears its REAL due-state dots
   * — the same truths its constellation shows on home (§12). §15: the relay
   * lives in one place — the helm's card; what stands here is MAIL
   * MACHINERY, joined to operations in a single panel.
   *
   * §15-2g: JOIN REQUESTS DO NOT APPEAR HERE. They live in household
   * management only — admin surfaces are for admin-only functions, and an
   * instance admin who needs owner powers simply sees the owner's household
   * screen for the system chosen on the dial. The /api/join-requests routes
   * and their server code stay put; household-manage will consume them when
   * it is built.
   *
   * The living station backdrop (#472/#475, §14) is $lib/backdrops/station.js,
   * ported from design/v19/administration-iss.html — this file only mounts
   * it and tears it down, the same shape as create/+page.svelte and
   * settings/mail/+page.svelte. Its households come through the same seam
   * home and create draw their own skies from (galaxyOf), and its caption's
   * real facts (collection domain, systems aboard, crew) come off this
   * screen's own data rather than the sheet's hard-coded literals.
   */
  /** @type {{ data: { fixtures: boolean } }} */
  let { data } = $props();
  /** @type {Awaited<ReturnType<typeof readAdminScreen>> | null} */
  let view = $state(null);
  /* The template only calls into `view` from inside `{#if view}`, but that
     guard doesn't reach into these standalone functions' closures, so this
     asserts what the call sites already guarantee rather than duplicating
     the check. */
  const need = () => /** @type {NonNullable<typeof view>} */ (view);
  /** @type {?HTMLDivElement} */
  let backdropRoot = null;
  /* #1123: on a phone the pocket's column holds the page's one main landmark. */
  const pocket = isPocket();
  /* §11 (#453): direct placement — it lands on the real route and refreshes
     the screen with the server's answer. Deciding join requests is NOT an
     admin-screen function (§15-2g). */
  /** @type {string | null} */
  let busy = $state(null);
  /** @type {string | null} */
  let problem = $state(null);
  /** @type {string | null} */
  let placing = $state(null); // user id whose system picker is open
  /**
   * @param {string} userId
   * @param {string} householdId
   */
  async function place(userId, householdId) {
    busy = userId;
    problem = null;
    try {
      await addMember(householdId, userId);
      placing = null;
      view = await readAdminScreen();
    } catch (error) {
      problem = wordsOf(error);
    } finally {
      busy = null;
    }
  }

  /* A NEW SYSTEM, MADE FOR SOMEBODY ELSE (#1052, Fable's decision of
     2026-09-19). The Systems card's head button was drawn from the mockup and
     never wired; this is the flow behind it, and it is deliberately the
     People card's own picker turned around. There, a person is chosen and the
     systems are the buttons; here a name is typed and the PEOPLE are the
     buttons, because what is being chosen is the owner.

     What an administrator-made system is: a household with a named owner,
     starting empty. Never owned by the administrator by default — they may
     not be a member of it at all — and never ownerless, because every
     household has exactly one owner. The owner invites the rest from their
     own household screen, as anyone would.

     The whole screen is re-read afterwards rather than patched, for the same
     reason placing a person re-reads it: the Systems list, the sky behind it
     and the header's counts are all derived from the households, so a patch
     would leave half of them describing the instance as it was. */
  let creatingSystem = $state(false);
  let systemName = $state("");
  let systemPassword = $state("");
  let systemBusy = $state(false);
  /** @type {string | null} */
  let systemProblem = $state(null);

  /** Opens or closes the form, challenging first where a challenge is owed. */
  function toggleNewSystem() {
    if (creatingSystem) { creatingSystem = false; systemPassword = ""; return; }
    systemProblem = null;
    challengeThen("system_create", () => {
      creatingSystem = true;
      systemName = "";
      systemPassword = "";
    }, (message) => (systemProblem = message));
  }

  /**
   * Pressing an owner button is the submit: the name is already typed, and the
   * person pressed is who the system belongs to.
   *
   * @param {string} ownerId
   */
  async function createSystemNow(ownerId) {
    if (systemBusy) return;
    systemBusy = true;
    systemProblem = null;
    try {
      await createSystem({
        name: systemName,
        ownerId,
        ...(actorHasPassword ? { currentPassword: systemPassword } : {}),
      });
      creatingSystem = false;
      systemName = "";
      systemPassword = "";
      provenIntent = "";
      view = await readAdminScreen();
    } catch (error) {
      systemProblem = setupWords(error);
    } finally {
      systemBusy = false;
    }
  }

  /* HOUSEHOLD RECOVERY ON THE CLOCK (#1001, design/v19/household-recovery/
     round-1/b-the-row-on-the-clock.html, owner-decisions §19). A household
     whose deletion is requested and still inside its 30-day window carries
     its own state and both acts on its Systems row; nothing is drawn once
     nothing is scheduled. Restore is the safe act, one tap. Delete now
     follows the household page's own danger protocol exactly (§15, "57 admin
     only": restore is drawn on administration only, never on the household
     page, whatever the server allows). */
  const recoverable = $derived.by(() => view?.recoverable ?? []);
  /** @param {string} iso */
  const daysLeft = (iso) => Math.max(0, Math.ceil(
    (Date.parse(iso) - Date.parse(view?.now ?? new Date().toISOString())) / 86_400_000,
  ));
  /** @param {{ deleteAfter: string }} row */
  const expired = (row) => Date.parse(row.deleteAfter) <= Date.parse(view?.now ?? new Date().toISOString());

  /** What was said on a row after restoring it, keyed by household id. @type {Record<string, { ok: boolean, text: string }>} */
  let clockSaid = $state({});
  /** @param {{ id: string, name: string }} row */
  async function restoreRow(row) {
    try {
      await restoreHousehold(row.id);
      clockSaid[row.id] = { ok: true, text: `restored · ${row.name} is back exactly as it was` };
      view = await readAdminScreen();
    } catch (error) {
      clockSaid[row.id] = { ok: false, text: `not restored — ${wordsOf(error)}` };
    }
  }

  /** Which row's "delete now" confirm is open, and what has been typed into each. @type {Record<string, boolean>} */
  let doomConfirming = $state({});
  /** @type {Record<string, string>} */
  let doomTypedName = $state({});
  /** @type {Record<string, string | null>} */
  let doomProblem = $state({});
  /** Rows replaced by their said-line after a hard delete. @type {{ id: string, text: string }[]} */
  let doomGone = $state([]);
  /** @param {{ id: string, name: string }} row */
  const openDoomConfirm = (row) => {
    doomConfirming[row.id] = true;
    doomTypedName[row.id] = "";
    doomProblem[row.id] = null;
  };
  /** @param {{ id: string, name: string }} row */
  const doomNameOk = (row) => deletionNameMatches(doomTypedName[row.id] ?? "", row.name);

  /* The two-tap protocol (lib/arm.js): the first tap arms the button and does
     nothing else; the second fires. An unfired arm relaxes after 4 seconds,
     on scroll, on Escape and on a tap elsewhere. */
  /** @type {string | boolean} */
  let doomArmed = $state(false);
  const doomArm = createArm({ onchange: (next) => (doomArmed = next) });
  /** @param {{ id: string, name: string }} row @param {HTMLElement | null} button */
  function twoTapDoom(row, button) {
    if (doomArm.tap(row.id, button)) fireDoom(row);
  }
  /** @param {{ id: string, name: string }} row */
  async function fireDoom(row) {
    try {
      await hardDeleteHousehold(row.id, doomTypedName[row.id] ?? "");
      doomConfirming[row.id] = false;
      doomGone = [...doomGone, { id: row.id, text: `deleted · ${row.name} is gone for good · its members keep their accounts` }];
      view = await readAdminScreen();
    } catch (error) {
      doomProblem[row.id] = wordsOf(error);
    }
  }

  /* ADD A LOCAL USER, AND SEND A NEW SETUP LINK (#915, ADR-0023 §3, §5;
     composition ruled in docs/plans/m7-local-accounts.md §2.7).

     There is no self-registration in Orbit: an administrator names the person,
     and Orbit MAILS them a link to choose their own password. Three things
     follow from the owner's 2026-09-09 ruling, and the markup below keeps all
     three.

       · THE LINK IS NEVER SHOWN. Not to the administrator, not to this list,
         not in a copy control — it goes to the address the account is
         registered with and nowhere else. What this screen reports is where it
         went and when it lapses.
       · A FAILED SEND IS NOT A LOST PERSON. The account is created first, so a
         mailer that refused leaves an account and a Retry rather than an error
         that threw the typing away. The reason is one bounded word.
       · THE ADMINISTRATOR IS RE-CHALLENGED EVERY TIME (ADR-0023 §5), inline,
         exactly as the helm's sign-in-methods block challenges a reader:
         somebody with a password answers with it here; somebody with only a
         provider identity is sent back to that provider first and returns with
         the proof in a cookie. `?stepup=` names what they left to do. */
  let localDraft = $state({ email: "", displayName: "", expiresInDays: SETUP_LINK_DAYS.fallback });
  /** True once Create has been tapped and the challenge under it is open. */
  let localArmed = $state(false);
  let localPassword = $state("");
  let localBusy = $state(false);
  /** @type {?(Awaited<ReturnType<typeof sendSetupLink>> & { userId?: string })} */
  let localDelivery = $state(null);
  /** @type {string | null} */
  let localProblem = $state(null);
  /**
   * Whether the acting administrator has a password of their own. It decides
   * which challenge every action on this screen asks for, so it is read once
   * with the screen rather than guessed per button. It starts true because
   * that is the answer for almost every administrator and the one the server
   * re-checks anyway — a wrong guess costs a refused request, never a change
   * that should not have happened.
   */
  let actorHasPassword = $state(true);
  /**
   * Which action this page load already carries a step-up proof for, if any.
   * The intent and not a boolean, because a proof is bound to ONE action
   * (ADR-0023 §5): one earned for creating a user cannot be spent issuing
   * somebody a link, and the server would refuse it if this screen tried.
   * Without it an OIDC-only administrator would be sent back to the provider
   * by the very tap that was supposed to spend the proof they just earned.
   * @type {string}
   */
  let provenIntent = $state("");
  /** Which person's "setup_link_issue" step-up this is resuming, for the
      phone layout's own sheet — it keeps a whole Person, not just an id,
      so it looks this up once `view` loads (#1151 A1-F2). */
  let resumedResendPersonId = $state(/** @type {string | null} */ (null));

  /**
   * The typed draft, carried across a step-up (#915). Leaving for the provider
   * is a full navigation, so without this an OIDC-only administrator would
   * come back to an empty form and have to type the person in again. Session
   * storage, not local: it belongs to this tab and this errand, and it holds
   * only what the administrator typed — never a password, never a link.
   *
   * Covers all three challenged intents this screen has (#1151 A1-F2): the
   * local-user form's own fields always ride along, and `intent` says which
   * OTHER form — new system, or a resend row — to reopen and refill, since
   * only one of those can be in flight for a given step-up. A fourth
   * intent arriving later just adds a branch here, not a new mechanism.
   */
  const DRAFT_KEY = "orbit-local-user-draft";

  /** @param {string} intent */
  /**
   * @param {string} intent
   * @param {{ resend?: { personId: string, days: number } | null }} [about]
   */
  function stashDraft(intent, about = {}) {
    // `about` names what the challenged tap was opening: it is stashed
    // before the tap's own state is set, so reading that state here would
    // capture the form before it opened.
    const payload = {
      intent,
      local: localDraft,
      systemName,
      resend: about.resend ?? (resendFor ? { personId: resendFor, days: resendDays } : null),
    };
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(payload)); } catch { /* storage refused: the form simply starts empty */ }
  }

  function restoreDraft() {
    try {
      const held = sessionStorage.getItem(DRAFT_KEY);
      sessionStorage.removeItem(DRAFT_KEY);
      if (!held) return;
      const draft = JSON.parse(held);
      if (draft.local) localDraft = { ...localDraft, ...draft.local };
      if (draft.intent === "system_create") {
        systemName = draft.systemName ?? "";
        creatingSystem = true;
      }
      if (draft.intent === "setup_link_issue" && draft.resend?.personId) {
        resendFor = draft.resend.personId;
        resendDays = draft.resend.days ?? SETUP_LINK_DAYS.fallback;
        resumedResendPersonId = draft.resend.personId;
      }
    } catch { /* nothing held, or unreadable: the form starts empty */ }
  }

  /** Which person's "send a new setup link" is open, by user id. @type {string | null} */
  let resendFor = $state(null);
  let resendDays = $state(SETUP_LINK_DAYS.fallback);
  let resendPassword = $state("");
  let resendBusy = $state(false);
  /** @type {Awaited<ReturnType<typeof sendSetupLink>> | null} */
  let resendDelivery = $state(null);
  /** @type {string | null} */
  let resendProblem = $state(null);

  /**
   * The first tap on a challenged action. An administrator with a password
   * gets the field under it; one without is handed to the provider and comes
   * back here with the proof.
   *
   * A handover that never left says so on the card the action belongs to, not
   * on whichever card happens to own `localProblem` — #1052 added a third
   * caller on a second card, so `report` names the line rather than assuming.
   *
   * @param {string} intent
   * @param {() => void} openField
   * @param {(message: string) => void} [report]
   * @param {{ resend?: { personId: string, days: number } | null }} [about] what the tap is opening, for stashDraft
   */
  async function challengeThen(intent, openField, report = (message) => (localProblem = message), about = {}) {
    localProblem = null;
    resendProblem = null;
    if (actorHasPassword || provenIntent === intent) { openField(); return; }
    try {
      stashDraft(intent, about);
      await startStepUp({ intent, returnTo: `/administration?stepup=${encodeURIComponent(intent)}` });
    } catch (error) {
      report(setupWords(error));
    }
  }

  /** Creates the account and mails its link (ADR-0023 §3). */
  async function createLocalUserNow() {
    if (localBusy) return;
    localBusy = true;
    localProblem = null;
    localDelivery = null;
    try {
      const answer = await createLocalUser({
        email: localDraft.email,
        displayName: localDraft.displayName,
        expiresInDays: Number(localDraft.expiresInDays),
        ...(actorHasPassword ? { currentPassword: localPassword } : {}),
      });
      localDelivery = { ...answer, userId: answer.user?.id };
      localArmed = false;
      localPassword = "";
      provenIntent = "";
      /* Only a send that got out clears the form: a failure keeps what was
         typed so the administrator can read it back against the Retry. */
      if (!answer.sendError) {
        localDraft = { email: "", displayName: "", expiresInDays: SETUP_LINK_DAYS.fallback };
      }
      view = await readAdminScreen();
    } catch (error) {
      localProblem = setupWords(error);
    } finally {
      localBusy = false;
    }
  }

  /**
   * Sends a fresh link — the Retry under a failed send, and the per-row
   * control. Issuing one kills the earlier link, so this is the same act
   * either way.
   *
   * @param {string} userId
   * @param {number} days
   * @param {string} password
   */
  async function sendSetupLinkNow(userId, days, password) {
    if (resendBusy || localBusy) return;
    resendBusy = true;
    localBusy = true;
    resendProblem = null;
    try {
      const answer = await sendSetupLink(userId, {
        expiresInDays: Number(days),
        ...(actorHasPassword ? { currentPassword: password } : {}),
      });
      resendDelivery = answer;
      if (localDelivery?.userId === userId) localDelivery = { ...answer, userId };
      resendFor = null;
      resendPassword = "";
      provenIntent = "";
    } catch (error) {
      resendProblem = setupWords(error);
    } finally {
      resendBusy = false;
      localBusy = false;
    }
  }

  /* §15 mail machinery, made real (#743, ADR-0017 slice 2). The instance has
     ONE admin-owned mailbox; this is where it is set, checked, rotated,
     removed and switched on or off.

     Two rules the markup below has to keep. The password is WRITE-ONLY: it is
     typed into a field that is never populated from the server, sent once,
     and cleared — nothing that comes back carries it, so "is a credential
     stored?" is answered by `hasPassword`, never by a value. And an
     administrator never sees a member's relay address: `aliasPattern` is the
     SHAPE addresses take, with a placeholder where the member's own code
     goes.

     Where the route cannot answer — under fixtures, or for a non-admin — the
     screen keeps the mockup's relay rows, so the ratified §13 sheet is what
     the fidelity gate still photographs. */
  /** @type {string | null} */
  let mailboxOutcome = $state(null);
  /** @type {string | null} */
  let mailboxProblem = $state(null);
  /** @type {string | null} */
  let mailboxBusy = $state(null);
  let editing = $state(false);
  let rotating = $state(false);
  let password = $state("");
  /* ROTATE EVERY ADDRESS (#1151 A1-F3): the phone layout's own `aliasOpen`
     sheet, built here for the desk — the only mailbox act the desk card was
     missing. Same default grace period as the phone's STANDARD_GRACE_DAYS. */
  const ALIAS_STANDARD_GRACE_DAYS = 14;
  let aliasRotating = $state(false);
  let aliasGraceDays = $state(ALIAS_STANDARD_GRACE_DAYS);
  /* Two-tap for this card's destructive single-click acts (#1151 A1-S2):
     "remove credential" fired on one click here while the phone already
     armed it first; "rotate every address" gets the same protocol from the
     start rather than shipping unarmed and needing its own fix later.
     One arm for the card's acts, keyed by act (lib/arm.js). */
  /** @type {string | boolean} */
  let mailboxArmed = $state(false);
  const mailboxArm = createArm({ onchange: (next) => (mailboxArmed = next) });
  /** @param {string} key @param {() => void} fire @param {HTMLElement | null} button */
  function twoTapMailbox(key, fire, button) {
    if (mailboxArm.tap(key, button)) fire();
  }
  /** @type {{ host: string, port: number, accountUser: string, mailbox: string, tlsServerName: string, providerProfile: string, trustedRecipientHeader: string, pollSeconds: number }} */
  let draft = $state({
    host: "", port: 993, accountUser: "", mailbox: "INBOX", tlsServerName: "",
    providerProfile: "other", trustedRecipientHeader: "X-Original-To", pollSeconds: 300,
  });

  const PROVIDER_PROFILES = ["mailcow", "gmail", "outlook", "other"];
  function openMailboxEditor() {
    const current = need().mailbox;
    if (current) {
      draft = {
        host: current.host, port: current.port, accountUser: current.accountUser,
        mailbox: current.mailbox, tlsServerName: current.tlsServerName,
        providerProfile: current.providerProfile,
        trustedRecipientHeader: current.trustedRecipientHeader || "X-Original-To",
        pollSeconds: current.pollSeconds,
      };
    }
    password = "";
    mailboxOutcome = null;
    mailboxProblem = null;
    editing = true;
  }

  /**
   * Runs one mailbox action and folds the answer straight back into the
   * screen, so what is shown is always the server's own account of the state
   * rather than an optimistic guess.
   *
   * @param {string} label  which button is busy
   * @param {object} command
   */
  async function mailboxAction(label, command) {
    mailboxBusy = label;
    mailboxProblem = null;
    mailboxOutcome = null;
    /** @type {Awaited<ReturnType<typeof commandMailbox>> | undefined} */
    let answer;
    try {
      answer = await commandMailbox(command);
    } catch (error) {
      /* The command itself refused — nothing changed server-side, so this
         really is "not done". */
      mailboxProblem = wordsOf(error);
      mailboxBusy = null;
      return;
    }
    mailboxOutcome = answer.outcome ?? null;
    /* Only a verified credential closes the form; a refused one leaves it
       open with what was typed, minus the password, so the administrator
       can correct a host or a port without retyping everything. */
    if (!answer.outcome || answer.outcome === "verified") {
      editing = false;
      rotating = false;
      aliasRotating = false;
    }
    password = "";
    try {
      /* The whole screen is re-read rather than patched, the same way placing
         a person does: the machinery rows are derived from the mailbox, so a
         patch would leave them describing the previous state. A failure HERE
         is a second, separate thing from the command above: that one already
         landed, so this is never read back as "not done" with the version
         left stale until a reload (#1151 A1-R5). */
      view = await readAdminScreen();
    } catch {
      mailboxProblem = "done — Orbit could not refresh this screen, so reload to see the new version";
    }
    mailboxBusy = null;
  }

  /* DOCUMENT JOBS AND THE TWO MAIL TESTS (#1071, design/v19/administration-ops/
     round-2/f-the-screens-grammar.html, owner 2026-09-19 "much better, good
     job. approved"). One family of state pills, coloured like the ADMIN
     pill: bad (failed), warm (retrying), run (running), ok (passed),
     quiet-and-breathing (checking). */
  /** @type {Record<string, string>} */
  const ROLE_TONE = { over: "bad", soon: "warn", up: "run", ok: "ok", "": "" };

  /* Document jobs: a People row without an avatar, ordered by what needs the
     reader, `retry` on FAILED rows only. Retrying flips the row to QUEUED at
     once, the same optimistic update the phone's own retry makes — the next
     screen re-read (any other admin act) settles it against the server. */
  /** @type {Record<string, { status: string, at: string }>} */
  let retriedJobs = $state({});
  const jobs = $derived.by(() => {
    const list = (view?.operations?.documentJobs ?? []).map((job) => retriedJobs[job.id]
      ? { ...job, status: /** @type {typeof job.status} */ (retriedJobs[job.id].status), attempts: 0, updatedAt: retriedJobs[job.id].at }
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
  const jobsClock = $derived.by(() => view?.now ?? new Date().toISOString());
  /** @param {(typeof jobs)[number]} job */
  const jobMeta = (job) => {
    /* The failed row's reason lives in its subtext permanently, with the
       tries and when it was last tried alongside it (the issue's own
       example: "couldn't reach the virus scanner · 5 of 5 tries · last
       tried 6m ago"). The client has no per-kind maximum to print "of N"
       against, so only the count travels, as the phone's own detail panel
       already shows it. */
    if (job.status === "failed") {
      return `${JOB_REASONS[job.lastErrorCode ?? "unknown"] ?? JOB_REASONS.unknown} · ${plural(job.attempts, "try", "tries")} · last tried ${ago(job.updatedAt, jobsClock)}`;
    }
    if (job.status === "retry") return job.lastErrorCode ? JOB_REASONS[job.lastErrorCode] ?? JOB_REASONS.unknown : `last tried ${ago(job.updatedAt, jobsClock)}`;
    if (job.status === "pending") return retriedJobs[job.id] ? "attempt 1 · queued just now" : `queued ${ago(job.createdAt, jobsClock)}`;
    if (job.status === "processing") return `started ${ago(job.updatedAt, jobsClock)}`;
    return `${JOB_STATES[job.status]?.word ?? job.status} ${ago(job.updatedAt, jobsClock)}`;
  };
  /** @type {string | null} */
  let jobsProblem = $state(null);
  /** @param {(typeof jobs)[number]} job */
  async function retryJob(job) {
    jobsProblem = null;
    try {
      await retryDocumentJob(job.id, job.status);
      retriedJobs[job.id] = { status: "pending", at: new Date().toISOString() };
    } catch (error) {
      jobsProblem = wordsOf(error);
    }
  }

  /* The two live mail tests: "test this mailbox" (the IMAP verify and the
     relay half together — it replaces "check connection") and "test the
     relay". The server now keeps each one's last answer (owner, 2026-09-19:
     "the server remembers the last mail-test result so the pill survives a
     reload — Yes"), so the pill is read straight off the screen's own
     re-read rather than kept in local state. */
  const mailProbes = $derived.by(() => view?.operations?.mailProbes ?? { mailbox: null, relay: null });
  const TEST_KINDS = /** @type {const} */ (["mailbox", "relay"]);
  /** @type {"mailbox" | "relay" | null} */
  let testingWhich = $state(null);
  /** @type {string | null} */
  let testProblem = $state(null);
  /** @param {"mailbox" | "relay"} which */
  async function runMailTest(which) {
    if (testingWhich) return;
    testingWhich = which;
    testProblem = null;
    try {
      await testMail(which);
      view = await readAdminScreen();
    } catch (error) {
      testProblem = wordsOf(error);
    } finally {
      testingWhich = null;
    }
  }
  /** @param {"mailbox" | "relay"} which */
  const testPill = (which) => {
    if (testingWhich === which) return { word: "checking…", tone: "quiet" };
    const probe = mailProbes[which];
    if (!probe) return null;
    const verdict = testVerdict(probe.result);
    return { word: `${verdict.word} · ${ago(probe.at, jobsClock)}`, tone: ROLE_TONE[verdict.tone] ?? "" };
  };
  /** @param {"mailbox" | "relay"} which */
  const testSubtext = (which) => {
    if (testingWhich === which) return "checking now";
    const probe = mailProbes[which];
    if (!probe) return "not tested yet";
    const verdict = testVerdict(probe.result);
    return verdict.reason || plainly(probe.result);
  };

  /* The tell (page-head pills, under the subline): one per thing that needs
     the reader, each a link down to its card — so a failure is visible from
     the top of the page without scrolling. */
  const tells = $derived.by(() => {
    /** @type {{ href: string, text: string }[]} */
    const items = [];
    const failedJobs = jobs.filter((job) => job.status === "failed").length;
    if (failedJobs) items.push({ href: "#jobs-card", text: `${plural(failedJobs, "job")} failed` });
    if (mailProbes.relay && testVerdict(mailProbes.relay.result).tone === "over") items.push({ href: "#mail-card", text: "relay failed" });
    /* no probe yet: the mailbox's own last verdict, as the phone says it */
    const mailboxFailed = mailProbes.mailbox
      ? testVerdict(mailProbes.mailbox.result).tone === "over"
      : view?.mailbox?.verificationState === "failed";
    if (mailboxFailed) items.push({ href: "#mail-card", text: "mailbox failed" });
    return items;
  });

  /* The public contact address (#860): one field an administrator sets,
     changes or clears, never defaulted from any account's own email. Named
     plainly on the door's third state (#788) when it cannot open safely — so
     unlike the mailbox above, there is no "verify" step: it is a published
     string, not a credential, and Orbit never talks to it. */
  let editingContact = $state(false);
  let contactDraft = $state("");
  /** @type {string | null} */
  let contactProblem = $state(null);
  let contactBusy = $state(false);

  function openContactEditor() {
    contactDraft = need().contact?.address ?? "";
    contactProblem = null;
    editingContact = true;
  }

  /** @param {{ action: "set", address: string } | { action: "clear" }} partial */
  async function contactAction(partial) {
    const current = need().contact;
    if (!current || contactBusy) return;
    contactBusy = true;
    contactProblem = null;
    try {
      await commandContact({ ...partial, expectedVersion: current.version });
      view = await readAdminScreen();
      editingContact = false;
    } catch (error) {
      contactProblem = wordsOf(error);
    } finally {
      contactBusy = false;
    }
  }

  /* The upload size limit (#1285): the configured default until an
     administrator sets their own, in whole MB inside the hard bounds. The
     server refuses anyone else and anything out of range; the field's own
     min and max only save a round trip. */
  let editingUploadLimit = $state(false);
  /** @type {number | null} */
  let uploadLimitDraft = $state(null);
  /** @type {string | null} */
  let uploadLimitProblem = $state(null);
  let uploadLimitBusy = $state(false);

  function openUploadLimitEditor() {
    const current = need().uploadLimit;
    uploadLimitDraft = current ? Math.round(current.maxBytes / 1048576) : null;
    uploadLimitProblem = null;
    editingUploadLimit = true;
  }

  /** @param {{ action: "set", megabytes: number } | { action: "default" }} partial */
  async function uploadLimitAction(partial) {
    const current = need().uploadLimit;
    if (!current) return;
    uploadLimitBusy = true;
    uploadLimitProblem = null;
    try {
      await commandUploadLimit({ ...partial, expectedVersion: current.version });
      view = await readAdminScreen();
      editingUploadLimit = false;
    } catch (error) {
      uploadLimitProblem = wordsOf(error);
    } finally {
      uploadLimitBusy = false;
    }
  }

  /** @type {Record<string, string>} */
  const TONE = { "--warm": "--warm", "--ok": "--ok", "--upcoming": "--upcoming", "--overdue": "--overdue" };
  /* The sheet's five hand-placed rings (design/v19/administration-iss.html,
     §Systems) turn out to be constellationPlanetsOf's own far-sky placement
     (CON-13), just re-centred on the roster's small r13 ring instead of the
     backdrop's distant one: the same orbit distance (18..30) and body size
     (2.0..2.8) divided by 6 and 4 respectively lands exactly on the sheet's
     hand-measured coordinates for all five fixture households (#775). */
  /** @param {[number, number, number, string]} planet */
  const ringDot = ([x, y, r, tone]) => ({
    cx: 17 + x / 6,
    cy: 17 + y / 6,
    r: 1 + r / 4,
    tone: TONE[tone] ?? "--ok",
  });
  /** @param {import('$lib/data/workspace.js').Household} household */
  const ringDots = (household) =>
    constellationPlanetsOf(household.items ?? [], need().today).map(ringDot);

  onMount(() => {
    let disposed = false;
    let backdropTeardown = () => {};
    /* The backdrop mounts once the screen's own data has loaded — its
       households (galaxyOf) and its caption's real facts both come from the
       same readAdminScreen() answer this screen renders from, so there is no
       second fetch. The one seed follows home's own pattern: pinned to the
       workspace under fixtures, so the fidelity gate can compare one
       deterministic sky against the mockup's; rolled fresh otherwise. */
    /* #915: which challenge this administrator answers with, and — under
       fixtures, where no challenged route can be reached at all — the delivery
       answer the "add a local user" row is drawn from. `?localuser=` names
       which of the two outcomes, so both can be photographed and walked. */
    const parameters = new URLSearchParams(window.location.search);
    if (data?.fixtures) {
      const wanted = parameters.get("localuser");
      if (wanted) {
        localDelivery = /** @type {any} */ (SETUP_LINK_FIXTURES)[wanted] ?? SETUP_LINK_FIXTURES.sent;
      }
    } else {
      readSignInMethods()
        .then((own) => { if (!disposed) actorHasPassword = own.local.set; })
        .catch(() => { /* additive: the password field stays the assumption */ });
      /* Back from the provider carrying a proof: pick the errand up where it
         was left rather than making them type the person in again. */
      const resumed = parameters.get("stepup");
      if (resumed) {
        restoreDraft();
        actorHasPassword = false;
        provenIntent = resumed;
      }
    }

    readAdminScreen().then((screen) => {
      if (disposed) return;
      view = screen;
      const seed = data?.fixtures ? seedFromWorkspace(screen.primary ?? "") : rollSeed();
      const galaxy = galaxyOf({ households: screen.households, activeHouseholdId: screen.primary }, screen.today);
      const domain = screen.relay.find(([label]) => label === "collection domain")?.[1] ?? "";
      backdropTeardown = mountStation(/** @type {HTMLDivElement} */ (backdropRoot), {
        seed, galaxy, primary: screen.primary,
        facts: { domain, systems: screen.households.length, crew: screen.users.length },
      });
    });
    return () => {
      disposed = true;
      backdropTeardown();
    };
  });
</script>

<svelte:head><title>Orbit — administration</title></svelte:head>

<div class="mission-page">
<div class="station-backdrop" bind:this={backdropRoot} aria-hidden="true"></div>
<div class="vignette" aria-hidden="true"></div>

<Chrome user={view?.user} current="administration" household={view?.household} />

<!-- #1123, proposal §2.12: administration on a phone, chosen by CSS. It
     shares this page's state and acts (the step-up challenge, the re-read),
     so both dialects answer the server the same way. -->
<Pocket {view} fixtures={Boolean(data?.fixtures)} {actorHasPassword} {provenIntent} {resumedResendPersonId} bind:draft={localDraft}
        challenge={challengeThen} reread={async () => { view = await readAdminScreen(); }}
        spent={() => (provenIntent = "")} />

<div class="page" role={pocket ? undefined : "main"}>
  <header class="screen">
    <h1>Administration</h1>
    <div class="sub">{view
      ? `the instance from above · admins see everything by design · ${view.users.length} people · ${view.households.length} systems`
      : "the instance from above · admins see everything by design"}</div>
    {#if tells.length}
      <div class="tells" aria-label="needs attention">
        {#each tells as tell (tell.text)}
          <!-- A same-page anchor to the card below, not a route. -->
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
          <a class="role bad" href={tell.href}>{tell.text}</a>
        {/each}
      </div>
    {/if}
  </header>

  {#if view}
    <div class="grid">

      <!-- AN OPEN DOCUMENT-KEY ROTATION (#956). The composition call, made
           deliberately: this renders NOTHING when no rotation is open — the
           common case earns zero pixels (and the fixture-mode screen the
           fidelity gate photographs is unchanged) — and when one IS open it
           stands first in the grid, full width, because the state's whole
           failure mode is being forgotten. It is a notice, not an alarm: a
           rotation is a deliberate operator procedure mid-flight, so it
           speaks in the card's ordinary voice with an accent edge, states
           the fact, how long, and the next step, and offers no buttons —
           finishing a rotation is a shell procedure, not a click. It is
           self-contained by design so #941's damaged/locked counts can stand
           beside it later without either being rewritten. -->
      {#if view.rotation?.inProgress}
        <div class="card wide rotation">
          <div class="cardhead"><h2>Document key rotation in progress</h2>
            <span class="since">{view.rotation.startedAt
              ? `open ${openFor(view.rotation.startedAt)} · since ${stamp(view.rotation.startedAt)}`
              : "start time not recorded"}</span></div>
          <p class="rotationwords">
            {#if view.rotation.secondKeyLoaded}
              Orbit is holding two encryption keys while the rotation runs. Every document stays readable —
              this is safe, but it is meant to be brief. Finish the procedure: run the rewrap, promote the
              new key, remove the old one — “Rotating the document key-encryption key” in the administrator
              guide has the steps.
            {:else}
              A rotation was started and never recorded as finished, and this instance is no longer holding
              the second key. Check where the rotation got to before changing anything — see “Rotating the
              document key-encryption key” in the administrator guide.
            {/if}
          </p>
        </div>
      {/if}

      <!-- LOCKED AND DAMAGED TIER 1 METADATA (#941), in the slot the rotation
           card above reserves for exactly this. Same composition, deliberately:
           nothing when nothing is wrong, full width when something is, the
           card's ordinary voice with an accent edge, and no buttons — restoring
           a key is a shell procedure, not a click. Two cards rather than one
           because the two states have nothing in common but the column they
           sit in: one is intact data waiting for a key, the other is data that
           is gone. The member sees neither number: a member gets the field in
           front of them and what they can do about it, and this screen gets the
           aggregate, so a missing key reads as one condition with one remedy. -->
      {#if view.metadata}
      {#if view.metadata.locked}
        <div class="card wide rotation">
          <div class="cardhead"><h2>Encrypted details are locked</h2></div>
          <p class="rotationwords">
            Orbit's encryption key is not available, so encrypted notes, references and mail-in
            extracts can't be read or written — notes or references on {view.metadata.lockedItems}
            items and {view.metadata.lockedReceipts} mail-in messages are affected, and item editing
            is paused. The data is intact and unlocks the moment the key is restored. “Restoring the
            document key-encryption key” in the administrator guide has the steps.
          </p>
        </div>
      {/if}

      {#if view.metadata.damagedValues > 0}
        <div class="card wide rotation">
          <div class="cardhead"><h2>Damaged encrypted details</h2></div>
          <p class="rotationwords">
            {view.metadata.damagedValues} values have failed their integrity check and can't be
            recovered — notes or references on {view.metadata.damagedItems} items, and
            {view.metadata.damagedReceipts} mail-in messages. Each occurrence is in the logs with its
            row and column. Overwriting a damaged value repairs the record; a damaged mail-in message
            can be re-forwarded. Counted as they're encountered, so the number can grow as items are
            opened.
          </p>
        </div>
      {/if}
      {/if}

      <!-- NO RECOVERY BUNDLE EXPORTED (#968, slice 1 of #966): the third card
           in this family, same composition again — zero pixels once a bundle
           is recorded, full width and no buttons while it isn't. Persistent
           rather than a one-time nag (owner ruling, 2026-09-10): "enforced
           means it persists, not that it blocks" — not dismissible while the
           condition holds, never a modal, never blocks use of the instance.
           Re-arms after a document-KEK rotation because a bundle wrapped
           under the old key can no longer recover the new one
           (server/recovery-bundle-status.ts's own rule). Wording matches
           "Exporting a recovery bundle" in the administrator guide word for
           word, per the issue's own done-when criterion. -->
      {#if view.recoveryBundle && !view.recoveryBundle.exported}
        <div class="card wide rotation">
          <div class="cardhead"><h2>No recovery bundle exported</h2></div>
          <p class="rotationwords">
            If the encryption key is ever lost with no recovery bundle to recover it, every
            document, all encrypted metadata, and — once account addresses are encrypted —
            every stored address are gone for good. Run <code>bash scripts/backup.sh</code> then
            <code>bash scripts/export-recovery-bundle.sh &lt;backup.tar&gt;</code> to make one. Keep its
            two parts apart: the bundle file on storage separate from this instance, and its
            passphrase in a password manager or on paper — never both together, because that
            separation is what keeps anyone who gets hold of the file alone from being able to
            use it. This reappears after every encryption-key rotation, because a bundle wrapped
            under the previous key can no longer recover the current one. "Exporting a recovery
            bundle" in the administrator guide has the steps.
          </p>
        </div>
      {/if}

      <div class="card">
        <!-- "invite someone" is the head of the row below it, not a second
             flow: inviting somebody in Orbit IS creating their account and
             mailing them a setup link (#481, ADR-0023 §3), and that form is
             always open under this head. So the button takes the reader to
             it rather than opening anything — the one thing left to do is
             type the address. -->
        <div class="cardhead"><h2>People</h2>
          <button onclick={() => document.getElementById("localuser-email")?.focus()}>invite someone</button></div>

        <!-- ADD A LOCAL USER (#915, ADR-0023 §3; composition §2.7): the row
             above the roster. Three things and a button — who they are, and
             how long their setup link should live. Orbit mails the link to
             the address typed here; it is never shown on this screen, so
             there is deliberately nothing to copy. -->
        <form class="localuser" onsubmit={(event) => { event.preventDefault();
                                                       if (localArmed || provenIntent === "local_user_create") createLocalUserNow();
                                                       else challengeThen("local_user_create", () => (localArmed = true)); }}>
          <label for="localuser-email">email</label>
          <input id="localuser-email" type="email" autocomplete="off" placeholder="newcomer@example.com"
                 bind:value={localDraft.email} required />
          <label for="localuser-name">display name</label>
          <input id="localuser-name" autocomplete="off" placeholder="Their name"
                 bind:value={localDraft.displayName} required />
          <label for="localuser-days">link valid for</label>
          <span class="days">
            <input id="localuser-days" type="number" min={SETUP_LINK_DAYS.min} max={SETUP_LINK_DAYS.max}
                   bind:value={localDraft.expiresInDays} required /> days
          </span>
          {#if localArmed}
            <!-- The inline challenge, the same two-tap shape the helm's
                 sign-in-methods block uses: Create arms it, this confirms it. -->
            <label for="localuser-current">your current password</label>
            <input id="localuser-current" type="password" autocomplete="current-password"
                   bind:value={localPassword} required />
          {/if}
          <div class="placerow localuserrow">
            <button type="submit" disabled={localBusy}>{localArmed ? "create and send the link" : "create"}</button>
            {#if localArmed}
              <button type="button" onclick={() => { localArmed = false; localPassword = ""; }}>cancel</button>
            {/if}
          </div>
        </form>
        {#if localDelivery}
          {#if localDelivery.sendError}
            <div class="adminproblem">
              {localDelivery.sentTo} was created, but {sendWords(localDelivery.sendError)}
              <button class="retry" disabled={localBusy}
                      onclick={() => sendSetupLinkNow(
                        /** @type {string} */ (localDelivery?.userId),
                        localDraft.expiresInDays,
                        localPassword,
                      )}>retry</button>
            </div>
          {:else}
            <div class="adminproblem ok">Setup link sent to {localDelivery.sentTo}, valid until {lapses(localDelivery.expiresAt)}</div>
          {/if}
        {/if}
        {#if localProblem}<div class="adminproblem">{localProblem}</div>{/if}

        {#each view.users as person (person.id)}
          <div class="person">
            <span class="avatar">{initials(person.displayName)}</span>
            <div class="who">
              <b>{person.displayName}{person.id === view.user?.id ? " · you" : ""}</b>
              <span>{[person.email, view.peopleMeta[person.id]].filter(Boolean).join(" · ")}</span>
            </div>
            <span class="role" class:admin={person.isInstanceAdmin}>{person.isInstanceAdmin ? "admin" : "user"}</span>
            {#if person.id !== view.user?.id}
              <button class="place" title="Admins can add any user to any system"
                      onclick={() => (placing = placing === person.id ? null : person.id)}>place in a system…</button>
              <!-- A fresh link for somebody who never used theirs, or who has
                   forgotten their password (ADR-0023 §3). Issuing it kills the
                   earlier one, and it goes to their registered address — this
                   screen never sees it.

                   IT IS ALSO THE WAY PAST A BROKEN MAILBOX (#1033, ADR-0027
                   §7). Every password sign-in here waits on an emailed
                   approval, so somebody whose mail is not arriving cannot get
                   in at all — and this link is the answer, because a setup or
                   recovery link IS the second factor (owner ruling,
                   2026-09-18): opening one signs them in with no approval
                   asked for. It is the same button, the same step-up and the
                   same `setup_link_issue` intent; nothing new was built for
                   it, which is the point. -->
              <button class="place" onclick={() => challengeThen("setup_link_issue", () => {
                        resendFor = resendFor === person.id ? null : person.id;
                        resendDays = SETUP_LINK_DAYS.fallback;
                        resendPassword = "";
                        resendDelivery = null;
                      }, undefined, { resend: { personId: person.id, days: SETUP_LINK_DAYS.fallback } })}
                      aria-expanded={resendFor === person.id}
                      aria-label={`send a new setup link to ${person.displayName}`}>send a new setup link…</button>
            {/if}
          </div>
          {#if placing === person.id}
            <div class="placerow">
              {#each view.households as household (household.id)}
                <button disabled={busy === person.id} onclick={() => place(person.id, household.id)}>{household.name}</button>
              {/each}
            </div>
          {/if}
          {#if resendFor === person.id}
            <form class="localuser resend" onsubmit={(event) => { event.preventDefault();
                                                                 sendSetupLinkNow(person.id, resendDays, resendPassword); }}>
              <label for="resend-days">link valid for</label>
              <span class="days">
                <input id="resend-days" type="number" min={SETUP_LINK_DAYS.min} max={SETUP_LINK_DAYS.max}
                       bind:value={resendDays} required /> days
              </span>
              {#if actorHasPassword}
                <label for="resend-current">your current password</label>
                <input id="resend-current" type="password" autocomplete="current-password"
                       bind:value={resendPassword} required />
              {/if}
              <div class="placerow localuserrow">
                <button type="submit" disabled={resendBusy}>send it</button>
                <button type="button" onclick={() => (resendFor = null)}>cancel</button>
              </div>
            </form>
          {/if}
        {/each}
        {#if resendDelivery}
          {#if resendDelivery.sendError}
            <div class="adminproblem">{sendWords(resendDelivery.sendError)}</div>
          {:else}
            <div class="adminproblem ok">Setup link sent to {resendDelivery.sentTo}, valid until {lapses(resendDelivery.expiresAt)}</div>
          {/if}
        {/if}
        {#if resendProblem}<div class="adminproblem">{resendProblem}</div>{/if}
        {#if problem}<div class="adminproblem">{problem}</div>{/if}
      </div>

      <div class="card">
        <div class="cardhead"><h2>Systems</h2>
          <button onclick={toggleNewSystem} aria-expanded={creatingSystem}
                  aria-controls="newsystem">new system</button></div>

        <!-- A NEW SYSTEM (#1052). The People card's picker, turned around: the
             name is typed, and the PEOPLE are the buttons, because what is
             being chosen is the owner. Pressing one is the submit — there is
             no separate confirm, exactly as pressing a system places a person
             over in the People card. Not a <form>: with the owner buttons as
             the submit there is no single default action for Enter to take,
             and a form whose Enter key does nothing is a dead end. -->
        {#if creatingSystem}
          <div class="localuser newsystem" id="newsystem">
            <label for="newsystem-name">name</label>
            <input id="newsystem-name" autocomplete="off" placeholder="Seaside Cottage"
                   maxlength={NAME_LIMIT} bind:value={systemName} required />
            {#if actorHasPassword}
              <!-- The same inline challenge the sibling admin actions ask for
                   (ADR-0023 §5); an OIDC-only administrator was handed to
                   their provider by the head button instead. -->
              <label for="newsystem-current">your current password</label>
              <input id="newsystem-current" type="password" autocomplete="current-password"
                     bind:value={systemPassword} required />
            {/if}
            <div class="placerow localuserrow" role="group"
                 aria-label="choose who will own the new system">
              {#each view.users as person (person.id)}
                <button disabled={systemBusy || systemName.trim().length === 0}
                        onclick={() => createSystemNow(person.id)}>{person.displayName}</button>
              {/each}
            </div>
          </div>
        {/if}
        {#if systemProblem}<div class="adminproblem">{systemProblem}</div>{/if}

        {#each view.households as household (household.id)}
          <div class="system">
            <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
              <circle cx="17" cy="17" r="13" fill="none" style="stroke:var(--chart-line)"/>
              <circle cx="17" cy="17" r="2.6" style="fill:var({household.id === view.primary ? "--sun" : "--ink-mid"})"/>
              {#each ringDots(household) as dot (dot.cx + "-" + dot.cy)}
                <circle cx={dot.cx} cy={dot.cy} r={dot.r} style="fill:var({dot.tone})" opacity=".8"/>
              {/each}
            </svg>
            <div class="who">
              <b>{household.name}</b>
              <span>{[
                plural(household.memberCount ?? 0, "member"),
                view.owners[household.id] ? `owner ${view.owners[household.id]}` : null,
                plural((household.items ?? []).length, "item"),
              ].filter(Boolean).join(" · ")}</span>
            </div>
          </div>
        {/each}

        <!-- ON THE CLOCK (#1001): readWorkspace excludes a household with a
             deletion requested from `households` outright
             (isNull(deletionRequestedAt), src/server/workspace-repository.ts)
             -- it never appears in view.households, doomed or not -- so this
             reads `recoverable` on its own rather than matching it against
             the households list above. Same shape pocket.svelte's own clock
             row already uses. It carries no items (id, name, deleteAfter
             only), so its ring is plain -- no ringDots here either, exactly
             as pocket.svelte draws it. -->
        {#each recoverable.filter((doom) => !doomGone.some((line) => line.id === doom.id)) as doom (doom.id)}
          {@const rowExpired = expired(doom)}
          <div class="system" class:doomed={!rowExpired}>
            <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
              {#if rowExpired}
                <circle cx="17" cy="17" r="13" fill="none" style="stroke:var(--chart-line)"/>
                <circle cx="17" cy="17" r="2.6" style="fill:var(--ink-mid)"/>
              {:else}
                <circle cx="17" cy="17" r="13" class="ring" fill="none"/>
                <circle cx="17" cy="17" r="2.6" class="sun"/>
              {/if}
            </svg>
            <div class="who">
              <b>{doom.name}</b>
              <span>{rowExpired ? "past its window · removing"
                : `on the clock · ${plural(daysLeft(doom.deleteAfter), "day")} left · gone for good ${dayMonth(doom.deleteAfter)}`}</span>
            </div>
            {#if !rowExpired}
              <div class="acts">
                <button class="rebtn" onclick={() => restoreRow(doom)}>restore</button>
                {#if !doomConfirming[doom.id]}
                  <button class="dangerbtn" onclick={() => openDoomConfirm(doom)}>delete now →</button>
                {:else}
                  <button class="dangerbtn" class:armed={doomArmed === doom.id} disabled={!doomNameOk(doom)}
                          onclick={(event) => twoTapDoom(doom, event.currentTarget)}>
                    {doomArmed === doom.id ? "tap again to delete for good" : "delete now"}</button>
                {/if}
              </div>
              {#if doomConfirming[doom.id]}
                <div class="confirm">
                  <p class="stake">Deleting now skips the {plural(daysLeft(doom.deleteAfter), "day")}. Nothing comes
                    back after this — not for you, not for anyone.</p>
                  <div class="field">
                    <label for="doomname-{doom.id}">type the system’s name exactly to wake the button</label>
                    <input id="doomname-{doom.id}" placeholder={doom.name} autocomplete="off"
                           bind:value={doomTypedName[doom.id]} />
                  </div>
                  {#if doomProblem[doom.id]}<div class="adminproblem">{doomProblem[doom.id]}</div>{/if}
                </div>
              {/if}
            {/if}
            {#if clockSaid[doom.id]}
              <div class="adminproblem said" class:ok={clockSaid[doom.id].ok}>{clockSaid[doom.id].text}</div>
            {/if}
          </div>
        {/each}
        {#each doomGone as line (line.id)}
          <div class="system settled"><div class="adminproblem gone">{line.text}</div></div>
        {/each}
      </div>

      <!-- #860: one published address, never a real administrator's own
           mailbox. Read by the sign-in door's third state (#788) with no
           session at all, so this card is the only place it is ever set. -->
      <div class="card">
        <div class="cardhead"><h2>Public contact</h2>
          {#if view.contact && !editingContact}
            <button onclick={openContactEditor}>{view.contact.address ? "change…" : "set…"}</button>
          {/if}
        </div>
        <div class="kv"><span>address</span><b>{view.contact?.address ?? "not set"}</b></div>
        {#if view.contact}
          {#if editingContact}
            <form class="mailboxform" onsubmit={(event) => {
              event.preventDefault();
              contactAction({ action: "set", address: contactDraft });
            }}>
              <label>address <input type="email" bind:value={contactDraft} placeholder="ops@example.com" required /></label>
              <p class="mailboxnote">Shown on the sign-in door if it ever cannot open safely — never
                a real administrator's own mailbox. Anyone can read it, signed in or not.</p>
              <div class="placerow mailboxrow">
                <button type="submit" disabled={contactBusy}>save</button>
                {#if view.contact.address}
                  <button type="button" disabled={contactBusy} onclick={() => contactAction({ action: "clear" })}>clear</button>
                {/if}
                <button type="button" onclick={() => (editingContact = false)}>cancel</button>
              </div>
            </form>
          {/if}
          {#if contactProblem}<div class="adminproblem">{contactProblem}</div>{/if}
        {/if}
      </div>

      <!-- DOCUMENT JOBS (#1071, #1055 round 2): a People row without an
           avatar, sibling to People and Systems, in the grid cell that was
           empty beside Public contact. Kind only — never the document's name
           (owner, 2026-09-19). -->
      <div class="card" id="jobs-card">
        <div class="cardhead"><h2>Document jobs</h2>
          {#if jobCounts}<span class="count">{jobCounts}</span>{/if}</div>
        {#each jobs as job (job.id)}
          <div class="person">
            <div class="who"><b>{JOB_KINDS[job.kind] ?? job.kind}</b><span>{jobMeta(job)}</span></div>
            <span class="role {ROLE_TONE[JOB_STATES[job.status]?.tone ?? ''] ?? ''}">{JOB_STATES[job.status]?.word ?? job.status}</span>
            {#if job.status === "failed"}
              <button class="place" onclick={() => retryJob(job)}>retry</button>
            {/if}
          </div>
        {:else}
          <p class="jobfoot">no document jobs yet</p>
        {/each}
        <div class="jobfoot">the 25 most recently touched jobs are kept; older ones are not</div>
        {#if jobsProblem}<div class="adminproblem">{jobsProblem}</div>{/if}
      </div>

      <!-- #1285: the document upload size limit — the configured default
           until an administrator sets their own. -->
      {#if view.uploadLimit}
        {@const limit = view.uploadLimit}
        <div class="card" id="upload-limit-card">
          <div class="cardhead"><h2>Upload size limit</h2>
            {#if !editingUploadLimit}
              <button onclick={openUploadLimitEditor}>change…</button>
            {/if}
          </div>
          <div class="kv"><span>largest document</span><b>{megabytes(limit.maxBytes)}</b></div>
          <div class="kv"><span>set by</span>
            <b>{limit.overrideBytes === null ? "the configured default" : `an administrator · default ${megabytes(limit.defaultBytes)}`}</b></div>
          {#if editingUploadLimit}
            <form class="mailboxform" onsubmit={(event) => {
              event.preventDefault();
              if (uploadLimitDraft !== null) uploadLimitAction({ action: "set", megabytes: uploadLimitDraft });
            }}>
              <label>limit in MB <input type="number" inputmode="numeric" step="1"
                min={Math.round(limit.minBytes / 1048576)} max={Math.round(limit.ceilingBytes / 1048576)}
                bind:value={uploadLimitDraft} required /></label>
              <p class="mailboxnote">From {megabytes(limit.minBytes)} to {megabytes(limit.ceilingBytes)}. It applies to the
                next upload, from the create form, an item, or mail; documents already kept are unaffected.</p>
              <div class="placerow mailboxrow">
                <button type="submit" disabled={uploadLimitBusy}>save</button>
                {#if limit.overrideBytes !== null}
                  <button type="button" disabled={uploadLimitBusy}
                          onclick={() => uploadLimitAction({ action: "default" })}>use the default ({megabytes(limit.defaultBytes)})</button>
                {/if}
                <button type="button" onclick={() => (editingUploadLimit = false)}>cancel</button>
              </div>
            </form>
          {/if}
          <p class="jobfoot">A reverse proxy in front of Orbit must allow uploads at least this large —
            <a href="https://github.com/tomlawesome/orbit/blob/main/docs/installing.md#what-you-need" target="_blank" rel="noopener noreferrer">see the install guide</a>.</p>
          {#if uploadLimitProblem}<div class="adminproblem">{uploadLimitProblem}</div>{/if}
        </div>
      {/if}

      <!-- §15: mail machinery sits WITH operations — one panel, two halves. -->
      <div class="card wide machinery" id="mail-card">
        <div class="half">
          <div class="cardhead">
            <h2>Mail machinery</h2>
            <button disabled={testingWhich !== null} class:busy={testingWhich === "mailbox"}
                    onclick={() => runMailTest("mailbox")}>test this mailbox</button>
            <button disabled={testingWhich !== null} class:busy={testingWhich === "relay"}
                    onclick={() => runMailTest("relay")}>test the relay</button>
            {#if view.mailbox && !editing}
              <button onclick={openMailboxEditor}>{view.mailbox.configured ? "change mailbox…" : "set up mailbox…"}</button>
            {/if}
          </div>
          {#each view.relay as [label, value, extra] (label)}
            <div class="kv"><span>{label}</span>
              {#if extra === "on"}<b class="on">{value}</b>
              {:else if extra}<span><b>{value.split(" · ")[0]}</b> · {value.split(" · ")[1]}</span><button>{extra}</button>
              {:else}<b>{value}</b>{/if}
            </div>
          {/each}

          <!-- The two live tests' last answer (#1071): a pill on its own row
               that stays until the next test, the server's own memory of it
               rather than this screen's — no row among those above already
               stands for "the outbound relay", so each test gets its own row
               rather than a guessed-at home on an unrelated one. -->
          {#each TEST_KINDS as which (which)}
            {@const pill = testPill(which)}
            <div class="person">
              <div class="who">
                <b>{which === "mailbox" ? "mailbox test" : "relay test"}</b>
                <span>{testSubtext(which)}</span>
              </div>
              {#if pill}<span class="role {pill.tone}">{pill.word}</span>{/if}
            </div>
          {/each}
          {#if testProblem}<div class="adminproblem">{testProblem}</div>{/if}

          {#if view.mailbox}
            {@const mailbox = view.mailbox}
            <div class="kv"><span>verification</span><b>{plainly(mailbox.verificationState)} · {stamp(mailbox.verifiedAt)}</b></div>
            {#if mailbox.configured}
              <div class="kv"><span>credential set</span>
                <b>{stamp(mailbox.credentialSetAt)}{mailbox.credentialSetBy ? ` · ${mailbox.credentialSetBy}` : ""}</b></div>
              <!-- The pattern, never a member's address: the database holds
                   alias digests only, and an administrator is not a reader of
                   anyone's relay (ADR-0017 decision 5). -->
              <div class="kv"><span>address shape</span><b>{mailbox.aliasPattern ?? "—"}</b></div>
              <div class="kv"><span>envelope header</span><b>{mailbox.trustedRecipientHeader || "not set"}</b></div>
              <div class="kv"><span>provider profile</span><b>{mailbox.providerProfile}</b></div>
              <div class="kv"><span>tls name</span><b>{mailbox.tlsServerName || mailbox.host}</b></div>
            {/if}

            {#if mailbox.configured && !editing && !rotating && !aliasRotating}
              <!-- "check connection" is gone (#1071): "test this mailbox"
                   above runs the same IMAP verify, plus the relay half. -->
              <div class="placerow mailboxrow">
                <button disabled={mailboxBusy !== null}
                        onclick={() => mailboxAction("probe", { action: "probe" })}>run setup probe</button>
                <button disabled={mailboxBusy !== null}
                        onclick={() => mailboxAction("enabled", {
                          action: mailbox.enabled ? "disable" : "enable",
                          expectedVersion: mailbox.version,
                        })}>{mailbox.enabled ? "pause ingest" : "resume ingest"}</button>
                <button disabled={mailboxBusy !== null} onclick={() => { rotating = true; password = ""; }}>
                  rotate password…</button>
                <!-- #1151 A1-F3: the phone layout's own "rotate every address",
                     missing here until now. -->
                <button disabled={mailboxBusy !== null}
                        onclick={() => { aliasRotating = true; aliasGraceDays = ALIAS_STANDARD_GRACE_DAYS; }}>
                  rotate every address…</button>
                <!-- #1151 A1-S2: armed first, same two-tap as the phone's own
                     remove-credential ArmButton — this used to fire on one
                     unconfirmed click. -->
                <button class="dangerbtn" class:armed={mailboxArmed === "remove"} disabled={mailboxBusy !== null}
                        onclick={(event) => twoTapMailbox("remove",
                          () => mailboxAction("remove", { action: "remove", expectedVersion: mailbox.version }),
                          event.currentTarget)}>
                  {mailboxArmed === "remove" ? "tap again to remove the credential" : "remove credential"}</button>
              </div>
            {/if}

            {#if aliasRotating}
              <!-- #1151 A1-F3: every member's relay address gets a fresh one;
                   old addresses keep collecting for the grace period below.
                   Same act, same default grace, same two-tap as the phone's
                   own "rotate every address" sheet. -->
              <form class="mailboxform" onsubmit={(event) => {
                event.preventDefault();
                twoTapMailbox("alias", () => mailboxAction("alias", {
                  action: "rotate_alias_key", expectedVersion: mailbox.version, graceDays: aliasGraceDays,
                }), event.submitter);
              }}>
                <p class="mailboxnote">Every member gets a new relay address. Mail sent to an old one still arrives until its
                  grace period runs out.</p>
                <label>old addresses keep working for (days)
                  <input type="number" min="0" max="90" bind:value={aliasGraceDays} required /></label>
                <div class="placerow mailboxrow">
                  <button type="submit" class="dangerbtn" class:armed={mailboxArmed === "alias"} disabled={mailboxBusy !== null}>
                    {mailboxArmed === "alias" ? "tap again to rotate every address" : "rotate every address"}</button>
                  <button type="button" onclick={() => { aliasRotating = false; mailboxArm.disarm(); }}>cancel</button>
                </div>
              </form>
            {/if}

            {#if rotating}
              <!-- The new password is proven against the provider before it
                   is committed; a refusal leaves the old one active. -->
              <form class="mailboxform" onsubmit={(event) => {
                event.preventDefault();
                mailboxAction("rotate", { action: "rotate", expectedVersion: mailbox.version, password });
              }}>
                <label>new password
                  <input type="password" autocomplete="new-password" bind:value={password} required /></label>
                <div class="placerow mailboxrow">
                  <button type="submit" disabled={mailboxBusy !== null}>verify and rotate</button>
                  <button type="button" onclick={() => { rotating = false; password = ""; }}>cancel</button>
                </div>
              </form>
            {/if}

            {#if editing}
              <form class="mailboxform" onsubmit={(event) => {
                event.preventDefault();
                mailboxAction("set", { action: "set", expectedVersion: mailbox.version, ...draft, password });
              }}>
                <label>host <input bind:value={draft.host} required /></label>
                <label>port <input type="number" min="1" max="65535" bind:value={draft.port} required /></label>
                <label>account <input bind:value={draft.accountUser} placeholder="intake@example.com" required /></label>
                <label>folder <input bind:value={draft.mailbox} required /></label>
                <label>tls name <input bind:value={draft.tlsServerName} placeholder="same as host" /></label>
                <label>provider
                  <select bind:value={draft.providerProfile}>
                    {#each PROVIDER_PROFILES as profile (profile)}<option value={profile}>{profile}</option>{/each}
                  </select></label>
                <label>envelope header <input bind:value={draft.trustedRecipientHeader} required /></label>
                <label>poll seconds
                  <input type="number" min="30" max="3600" bind:value={draft.pollSeconds} required /></label>
                <label>password
                  <input type="password" autocomplete="new-password" bind:value={password} required /></label>
                <p class="mailboxnote">Relay addresses are plus-addresses of this account, so it has to be one the
                  provider delivers sub-addressed mail to. The password is stored encrypted and never shown again.</p>
                <div class="placerow mailboxrow">
                  <button type="submit" disabled={mailboxBusy !== null}>verify and save</button>
                  <button type="button" onclick={() => { editing = false; password = ""; }}>cancel</button>
                </div>
              </form>
            {/if}

            {#if mailboxOutcome}<div class="adminproblem" class:ok={mailboxOutcome === "verified" || mailboxOutcome === "delivered"}>{plainly(mailboxOutcome)}</div>{/if}
            {#if mailboxProblem}<div class="adminproblem">{mailboxProblem}</div>{/if}
          {/if}
        </div>

        <div class="half">
          <div class="cardhead"><h2>Operations</h2></div>
          {#each view.services as [tone, name, detail] (name)}
            <div class="svc"><i style="background:var(--{tone})"></i><b>{name}</b><small>{detail}</small></div>
          {/each}
        </div>
      </div>

    </div>

    <div class="strip">{view.instance}</div>
  {/if}
</div>
</div>
