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
  addMember, commandContact, commandMailbox, commandUploadLimit, createLocalUser, createSystem,
  restoreHousehold, retryDocumentJob, sendSetupLink, testMail, wordsOf,
} from "$lib/data/workspace.js";
import { JOB_KINDS, lapsesShort, megabytes, sendWords, setupWords } from "./words.js";

/** @typedef {{ busy: boolean, problem: string | null }} Card */
/** @typedef {(message: string, options?: { failure?: boolean }) => unknown} Wake */
/** @typedef {() => Promise<void>} Reread */
/** @typedef {Awaited<ReturnType<typeof sendSetupLink>>} Delivery */

const quiet = () => {};

/** A card's own state, for the screen to hold as `$state`. */
export const card = () => ({ busy: false, problem: /** @type {string | null} */ (null) });

/**
 * A command that landed is never read back as not done when only the re-read
 * after it failed (#1316 A1-R1).
 */
export const DONE_UNREAD = "done — Orbit could not refresh this screen, so reload to see the new version";

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
    landed();
    wake(`${person.displayName} is in ${system.name}`);
    await reread();
  } catch (error) {
    card.problem = wordsOf(error);
    wake(card.problem, { failure: true });
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
  try {
    const answer = await createLocalUser({
      email: draft.email,
      displayName: draft.displayName,
      expiresInDays: Number(draft.expiresInDays),
      ...(actorHasPassword ? { currentPassword: password } : {}),
    });
    landed({ ...answer, userId: answer.user?.id });
    if (answer.sendError) wake(`${answer.sentTo} was created, but ${sendWords(answer.sendError)}`, { failure: true });
    else wake(`setup link sent · lapses ${lapsesShort(answer.expiresAt)}`);
    await reread();
  } catch (error) {
    card.problem = setupWords(error);
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
 * @param {{ card: Card, actorHasPassword: boolean, reread: Reread, landed: () => void }} on
 */
export async function makeSystem(name, owner, password, { card, actorHasPassword, reread, landed }) {
  if (card.busy) return;
  card.busy = true;
  card.problem = null;
  try {
    await createSystem({
      name,
      ownerId: owner.id,
      ...(actorHasPassword ? { currentPassword: password } : {}),
    });
    landed();
    await reread();
  } catch (error) {
    card.problem = setupWords(error);
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
    said[row.id] = { ok: true, text: `restored · ${row.name} is back exactly as it was` };
    await reread();
  } catch (error) {
    said[row.id] = { ok: false, text: `not restored — ${wordsOf(error)}` };
  }
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
    landed();
    wake(partial.action === "clear" ? "the public contact is cleared" : `the public contact is ${partial.address}`);
    await reread();
    settled();
  } catch (error) {
    card.problem = wordsOf(error);
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
export async function setUploadLimit(current, partial, { card, reread, landed, wake, unread = () => DONE_UNREAD }) {
  if (!current || card.busy) return;
  card.busy = true;
  card.problem = null;
  /** @type {{ maxBytes: number } | undefined} */
  let uploadLimit;
  try {
    const answer = await commandUploadLimit({ ...partial, expectedVersion: current.version });
    if (wake) ({ uploadLimit } = answer);
  } catch (error) {
    card.problem = wordsOf(error);
    card.busy = false;
    return;
  }
  try {
    landed();
    if (wake) wake(`the upload size limit is ${megabytes(/** @type {{ maxBytes: number }} */ (uploadLimit).maxBytes)}`);
    await reread();
  } catch (error) {
    card.problem = unread(error);
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
 * @param {{ card: { busy: string | null, problem: string | null, outcome: string | null }, reread: Reread, landed: (closes: boolean) => void }} on
 */
export async function commandMail(label, command, { card, reread, landed }) {
  card.busy = label;
  card.problem = null;
  card.outcome = null;
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
  landed(!answer.outcome || answer.outcome === "verified");
  try {
    await reread();
  } catch {
    card.problem = DONE_UNREAD;
  } finally {
    card.busy = null;
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
    await reread();
  } catch (error) {
    card.problem = wordsOf(error);
  } finally {
    card.busy = null;
  }
}

/**
 * Retries a failed document job. The row shows queued at once (`retried`,
 * read by words.js's jobsOf); the next re-read settles it against the server.
 * @param {import("./words.js").DocumentJob} job
 * @param {{ card: Card, retried: Record<string, { status: string, at: string }>, wake?: Wake }} on
 */
export async function retryJob(job, { card, retried, wake = quiet }) {
  card.problem = null;
  try {
    await retryDocumentJob(job.id, job.status);
    retried[job.id] = { status: "pending", at: new Date().toISOString() };
    wake(`${JOB_KINDS[job.kind] ?? job.kind} is queued to try again`);
  } catch (error) {
    card.problem = wordsOf(error);
  }
}
