/*
 * What administration does, held once for the desk's cards and the phone's
 * rows (#1353, web-8). The layouts differ in how they speak, not in what an
 * act sends or how it fails, so each act takes:
 *   card     the card it reports on, `{ busy, problem }` (`card()` below),
 *            held as `$state` by the screen;
 *   reread   the whole screen is re-read after an act rather than patched:
 *            its counts, rows and sky are all derived from it;
 *   wake     the phone's line at the foot of the screen (the desk passes
 *            none, and says it on the card instead);
 *   landed   what the layout closes or clears once the server has taken the
 *            act, and, where they differ, `settled` once the re-read is back.
 * Nothing here holds state of its own.
 */

import {
  addMember, commandContact, commandMailLimit, commandMailbox, commandSending, commandUploadLimit, createLocalUser, createSystem,
  hardDeleteHousehold, postAdminJson, readAdminJson, restoreHousehold, retryDocumentJob, sendSetupLink, setUserDisabled,
  testMail, wordsOf,
} from "$lib/data/workspace.js";
import { DONE_UNREAD, rereadAfterLanded } from "$lib/data/landed.js";
import { JOB_KINDS, lapsesShort, megabytes, removalWords, sendWords, setupWords } from "./words.js";

/** @typedef {{ busy: boolean, problem: string | null }} Card */
/** @typedef {(message: string, options?: { failure?: boolean, undo?: () => void }) => unknown} Wake */
/** @typedef {() => Promise<void>} Reread */
/** @typedef {Awaited<ReturnType<typeof sendSetupLink>>} Delivery */

const quiet = () => {};

/** A card's own state, for the screen to hold as `$state`. */
export const card = () => ({ busy: false, problem: /** @type {string | null} */ (null) });

/* Each act sends its command in one try and reads again in another
   ($lib/data/landed.js): a re-read that fails after the command landed is
   said as done-but-unread, never as the command refused, so nobody sends a
   landed command twice. */
/** Where an act says a re-read failed: its card's line, and the phone's wake. @param {{ problem: string | null }} card @param {Wake} [wake] */
const unreadOn = (card, wake = quiet) => (/** @type {string} */ words) => { card.problem = words; wake(words); };

/**
 * Places a person in a system (§11, #453). `busy` holds the person's id
 * while it is out.
 * @param {{ id: string, displayName: string }} person @param {{ id: string, name: string }} system
 * @param {{ card: { busy: string | null, problem: string | null }, reread: Reread, landed?: () => void, wake?: Wake }} on
 */
export async function placePerson(person, system, { card, reread, landed = quiet, wake = quiet }) {
  card.busy = person.id;
  card.problem = null;
  try {
    await addMember(system.id, person.id);
  } catch (error) {
    card.problem = wordsOf(error);
    wake(card.problem, { failure: true });
    card.busy = null;
    return;
  }
  try {
    landed();
    wake(`${person.displayName} is in ${system.name}`);
    await rereadAfterLanded(reread, unreadOn(card, wake));
  } finally {
    card.busy = null;
  }
}

/**
 * Creates the account and mails its link (ADR-0023 §3). A failed send is not
 * a lost person: the account exists, and the answer says why nothing went.
 * @param {{ email: string, displayName: string, expiresInDays: number }} draft
 * @param {string} password the administrator's own, where they have one
 * @param {{ card: Card, actorHasPassword: boolean, reread: Reread, landed: (delivery: Delivery & { userId?: string }) => void, begun?: () => void, wake?: Wake }} on
 */
export async function inviteLocalUser(draft, password, { card, actorHasPassword, reread, landed, begun = quiet, wake = quiet }) {
  if (card.busy) return;
  card.busy = true;
  card.problem = null;
  begun();
  /** @type {Awaited<ReturnType<typeof createLocalUser>>} */
  let answer;
  try {
    answer = await createLocalUser({
      email: draft.email,
      displayName: draft.displayName,
      expiresInDays: Number(draft.expiresInDays),
      ...(actorHasPassword ? { currentPassword: password } : {}),
    });
  } catch (error) {
    card.problem = setupWords(error);
    card.busy = false;
    return;
  }
  try {
    landed({ ...answer, userId: answer.user?.id });
    if (answer.sendError) wake(`${answer.sentTo} was created, but ${sendWords(answer.sendError)}`, { failure: true });
    else wake(`setup link sent · lapses ${lapsesShort(answer.expiresAt)}`);
    await rereadAfterLanded(reread, unreadOn(card, wake));
  } finally {
    card.busy = false;
  }
}

/**
 * Sends a fresh setup link: a person's own act, and the Retry under a failed
 * send. Issuing one kills the earlier link (ADR-0023 §3). `lock` is another
 * card held busy alongside, as the desk holds its add-a-user form.
 * @param {string} userId @param {number} days @param {string} password
 * @param {{ card: Card, lock?: Card, actorHasPassword: boolean, landed: (delivery: Delivery) => void, wake?: Wake }} on
 */
export async function issueSetupLink(userId, days, password, { card, lock, actorHasPassword, landed, wake = quiet }) {
  if (card.busy || lock?.busy) return;
  card.busy = true;
  if (lock) lock.busy = true;
  card.problem = null;
  try {
    const answer = await sendSetupLink(userId, {
      expiresInDays: Number(days),
      ...(actorHasPassword ? { currentPassword: password } : {}),
    });
    landed(answer);
    if (answer.sendError) wake(sendWords(answer.sendError), { failure: true });
    else wake(`setup link sent · lapses ${lapsesShort(answer.expiresAt)}`);
  } catch (error) {
    card.problem = setupWords(error);
  } finally {
    card.busy = false;
    if (lock) lock.busy = false;
  }
}

/**
 * A new system, made for somebody else (#1052): pressing the owner is the
 * submit, so `owner` is who it belongs to and `name` is what was typed.
 * @param {string} name @param {{ id: string }} owner @param {string} password
 * @param {{ card: Card, actorHasPassword: boolean, reread: Reread, landed: () => void, wake?: Wake }} on
 */
export async function makeSystem(name, owner, password, { card, actorHasPassword, reread, landed, wake = quiet }) {
  if (card.busy) return;
  card.busy = true;
  card.problem = null;
  try {
    await createSystem({
      name,
      ownerId: owner.id,
      ...(actorHasPassword ? { currentPassword: password } : {}),
    });
  } catch (error) {
    card.problem = setupWords(error);
    card.busy = false;
    return;
  }
  try {
    landed();
    await rereadAfterLanded(reread, unreadOn(card, wake));
  } finally {
    card.busy = false;
  }
}

/**
 * The Sign-in providers card's preview (#1676, ADR-0041): each linked issuer
 * with its members and who removal would leave with no other way in, who the
 * primary administrator is, and whether the viewer is them and has a password.
 * @typedef {{ userId: string, displayName: string }} ProviderPerson
 * @typedef {{ issuer: string, configured: boolean, members: ProviderPerson[], stranded: ProviderPerson[] }} Provider
 * @typedef {{ providers: Provider[], primary: ProviderPerson | null, viewerIsPrimary: boolean, viewerHasPassword: boolean }} ProviderLinks
 * @typedef {{ userId: string, mailed: boolean, reason: string | null }} ProviderRecipient
 * @typedef {{ removed: number, members: number, mailed: number, mailFailed: number, sessionsEnded: number, recipients: ProviderRecipient[] }} ProviderRemoval
 */

/** @returns {Promise<ProviderLinks>} */
export const readProviderLinks = () => readAdminJson("/api/admin/provider-links");

/**
 * Removes every member's link to one retired provider and mails the existing
 * setup link to those left with no other way in (ADR-0041). The primary
 * administrator answers with their password (ADR-0023 §5, intent
 * `provider_links_remove`). Outgoing mail not being ready is the card's own
 * line rather than a sentence; it changes nothing, so `refused` says so.
 * The setup link keeps the server's default life (7 days).
 * @param {Provider} provider @param {string} password
 * @param {{ card: Card, landed: (answer: ProviderRemoval) => void, refused: () => void, cleared: () => void }} on
 */
export async function removeProviderLinks(provider, password, { card, landed, refused, cleared }) {
  if (card.busy) return;
  card.busy = true;
  card.problem = null;
  try {
    /** @type {ProviderRemoval} */
    const answer = await postAdminJson("/api/admin/provider-links/remove", {
      issuer: provider.issuer,
      mailStranded: true,
      currentPassword: password,
    });
    landed(answer);
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code;
    if (code === "mail_not_ready") refused();
    else {
      card.problem = removalWords(error);
      cleared();
    }
  } finally {
    card.busy = false;
  }
}

/**
 * Restores a system on the clock (#1001, §19); `said` is the line each row
 * shows afterwards, keyed by the system's id.
 * @param {{ id: string, name: string }} row
 * @param {Record<string, { ok: boolean, text: string }>} said @param {Reread} reread
 */
export async function restoreSystem(row, said, reread) {
  try {
    await restoreHousehold(row.id);
  } catch (error) {
    said[row.id] = { ok: false, text: `not restored — ${wordsOf(error)}` };
    return;
  }
  said[row.id] = { ok: true, text: `restored · ${row.name} is back exactly as it was` };
  await rereadAfterLanded(reread, (words) => { said[row.id] = { ok: true, text: `restored · ${row.name} is back · ${words}` }; });
}

/**
 * Disables a person, or lets them sign in again (§2.6). The phone's act
 * alone (the desk has none); the row's own arm is its guard, so no `busy`.
 * @param {{ id: string, displayName: string }} person @param {boolean} off
 * @param {{ card: { problem: string | null }, reread: Reread, wake?: Wake }} on
 * @returns {Promise<void>}
 */
export async function setDisabled(person, off, on) {
  const { card, reread, wake = quiet } = on;
  card.problem = null;
  try {
    await setUserDisabled(person.id, off);
  } catch (error) {
    card.problem = wordsOf(error);
    wake(card.problem, { failure: true });
    return;
  }
  if (off) wake(`${person.displayName} is disabled · they can’t sign in`, { undo: () => setDisabled(person, false, on) });
  else wake(`${person.displayName} can sign in again`);
  /* On the card alone, whose line is on show: a second wake would take the
     undo away. */
  await rereadAfterLanded(reread, unreadOn(card));
}

/**
 * Deletes a system on the clock now, for good (§19 "57 admin only"), the
 * name typed as its confirmation. `gone[row.id]` is the line that replaces
 * its row, as restoreSystem's `said`; `landed` closes the confirm; a refusal
 * goes to `refused` in the server's words, for each layout's confirm to say.
 * @param {{ id: string, name: string }} row @param {string} typedName
 * @param {{ gone: Record<string, string>, reread: Reread, landed: () => void, refused: (words: string) => void, wake?: Wake }} on
 */
export async function deleteSystemNow(row, typedName, { gone, reread, landed, refused, wake = quiet }) {
  try {
    await hardDeleteHousehold(row.id, typedName);
  } catch (error) {
    refused(wordsOf(error));
    return;
  }
  landed();
  gone[row.id] = `deleted · ${row.name} is gone for good · its members keep their accounts`;
  /* The row is gone whatever the read did: its line keeps saying so, and
     only its tail says the screen was not refreshed. */
  await rereadAfterLanded(reread, (words) => { gone[row.id] = `deleted · ${row.name} is gone for good · ${words}`; wake(words); });
}

/**
 * Sets or clears the public contact address (#860).
 * @param {{ version: number } | null | undefined} current
 * @param {{ action: "set", address: string } | { action: "clear" }} partial
 * @param {{ card: Card, reread: Reread, landed?: () => void, settled?: () => void, wake?: Wake }} on
 */
export async function setContact(current, partial, { card, reread, landed = quiet, settled = quiet, wake = quiet }) {
  if (!current || card.busy) return;
  card.busy = true;
  card.problem = null;
  try {
    await commandContact({ ...partial, expectedVersion: current.version });
  } catch (error) {
    card.problem = wordsOf(error);
    card.busy = false;
    return;
  }
  try {
    landed();
    wake(partial.action === "clear" ? "the public contact is cleared" : `the public contact is ${partial.address}`);
    await rereadAfterLanded(reread, unreadOn(card, wake));
    /* Settled whether or not the read landed: the contact is saved, and an
       open editor would invite a re-save its stale version refuses. */
    settled();
  } finally {
    card.busy = false;
  }
}

/**
 * Sets the upload size limit, or goes back to the configured default
 * (#1285). `unread` words a failure after the command landed; it says so
 * unless the layout passes its own.
 * @param {{ version: number } | null | undefined} current
 * @param {{ action: "set", megabytes: number } | { action: "default" }} partial
 * @param {{ card: Card, reread: Reread, landed: () => void, wake?: Wake, unread?: (error: unknown) => string }} on
 */
export async function setUploadLimit(current, partial, on) {
  return setSizeLimit(current, partial, on, async (command) => (await commandUploadLimit(command)).uploadLimit, "the upload size limit");
}

/**
 * Sets the mail size limit, or goes back to its 25 MB default (#1388); the
 * same steps as the upload limit's.
 * @param {{ version: number } | null | undefined} current
 * @param {{ action: "set", megabytes: number } | { action: "default" }} partial
 * @param {{ card: Card, reread: Reread, landed: () => void, wake?: Wake, unread?: (error: unknown) => string }} on
 */
export async function setMailLimit(current, partial, on) {
  return setSizeLimit(current, partial, on, async (command) => (await commandMailLimit(command)).mailLimit, "the largest mail message");
}

/**
 * @param {{ version: number } | null | undefined} current
 * @param {{ action: "set", megabytes: number } | { action: "default" }} partial
 * @param {{ card: Card, reread: Reread, landed: () => void, wake?: Wake, unread?: (error: unknown) => string }} on
 * @param {(command: any) => Promise<{ maxBytes: number }>} send
 * @param {string} noun
 */
async function setSizeLimit(current, partial, { card, reread, landed, wake, unread = () => DONE_UNREAD }, send, noun) {
  if (!current || card.busy) return;
  card.busy = true;
  card.problem = null;
  /** @type {{ maxBytes: number } | undefined} */
  let limit;
  try {
    limit = await send({ ...partial, expectedVersion: current.version });
  } catch (error) {
    card.problem = wordsOf(error);
    card.busy = false;
    return;
  }
  try {
    landed();
    if (wake) wake(`${noun} is ${megabytes(/** @type {{ maxBytes: number }} */ (limit).maxBytes)}`);
    await rereadAfterLanded(reread, (words) => { card.problem = unread(words); wake?.(card.problem); });
  } finally {
    card.busy = false;
  }
}

/**
 * One mailbox action (#743), folded back into the screen from the server's
 * own account of it rather than an optimistic guess. `busy` names the button
 * that is out; `landed` is told whether the form closes, which it does
 * unless a credential was refused (that keeps what was typed, minus the
 * password, so a host or port can be corrected).
 * @param {string} label @param {object} command
 * @param {{ card: { busy: string | null, problem: string | null, outcome: string | null, fetched?: object | null }, reread: Reread, landed: (closes: boolean) => void }} on
 */
export async function commandMail(label, command, { card, reread, landed }) {
  card.busy = label;
  card.problem = null;
  card.outcome = null;
  card.fetched = null;
  /** @type {Awaited<ReturnType<typeof commandMailbox>>} */
  let answer;
  try {
    answer = await commandMailbox(command);
  } catch (error) {
    /* The command itself refused: nothing changed server-side. */
    card.problem = wordsOf(error);
    card.busy = null;
    return;
  }
  card.outcome = answer.outcome ?? null;
  /* A fetch now (#1651) also says what the check read. */
  if (/** @type {{ action?: string }} */ (command).action === "fetch_now") card.fetched = { messagesRead: answer.messagesRead, receiptsRecorded: answer.receiptsRecorded, reasons: answer.reasons, reason: answer.reason ?? null };
  landed(!answer.outcome || answer.outcome === "verified");
  try {
    await rereadAfterLanded(reread, unreadOn(card));
  } finally {
    card.busy = null;
  }
}

/**
 * Sets how Orbit sends (#1629). The server signs in to the mail server before
 * it stores anything, so only `verified` closes the editor; a refusal keeps
 * what was typed, minus the password, so a host or a user can be corrected.
 * @param {Parameters<typeof commandSending>[0]} command
 * @param {{ card: { busy: boolean, problem: string | null, outcome: string | null }, reread: Reread, landed: (closes: boolean) => void, wake?: Wake }} on
 */
export async function saveSending(command, { card, reread, landed, wake = quiet }) {
  if (card.busy) return;
  card.busy = true;
  card.problem = null;
  card.outcome = null;
  /** @type {Awaited<ReturnType<typeof commandSending>>} */
  let answer;
  try {
    answer = await commandSending(command);
  } catch (error) {
    /* The command itself refused: nothing changed server-side. */
    card.problem = wordsOf(error);
    card.busy = false;
    return;
  }
  card.outcome = answer.outcome ?? null;
  const closes = answer.outcome === "verified";
  landed(closes);
  if (closes) wake("sending is set");
  try {
    await rereadAfterLanded(reread, unreadOn(card, wake));
  } finally {
    card.busy = false;
  }
}

/**
 * One of the two live mail tests (#1071). The server keeps each one's last
 * answer, so the result is read off the re-read, not kept here. `busy` names
 * the test that is out.
 * @param {"mailbox" | "relay"} which
 * @param {{ card: { busy: "mailbox" | "relay" | null, problem: string | null }, reread: Reread }} on
 */
export async function runMailTest(which, { card, reread }) {
  if (card.busy) return;
  card.busy = which;
  card.problem = null;
  try {
    await testMail(which);
  } catch (error) {
    card.problem = wordsOf(error);
    card.busy = null;
    return;
  }
  try {
    await rereadAfterLanded(reread, unreadOn(card));
  } finally {
    card.busy = null;
  }
}

/**
 * Retries a failed document job. The row shows queued at once (`retried`,
 * read by words.js's jobsOf); the next re-read settles it against the server.
 * @param {import("./words.js").DocumentJob} job
 * @param {{ card: Card, retried: Record<string, { status: string, at: string, was: string }>, wake?: Wake }} on
 */
export async function retryJob(job, { card, retried, wake = quiet }) {
  card.problem = null;
  try {
    await retryDocumentJob(job.id, job.status);
    retried[job.id] = { status: "pending", at: new Date().toISOString(), was: job.updatedAt };
    wake(`${JOB_KINDS[job.kind] ?? job.kind} is queued to try again`);
  } catch (error) {
    card.problem = wordsOf(error);
  }
}
