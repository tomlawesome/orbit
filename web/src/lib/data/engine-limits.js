/**
 * The engine's own numbers, as the browser holds them (#1336, ADR-0034).
 *
 * `GET /api/auth/session` carries `limits` (the archive file ceiling and the
 * passphrase bounds) and `retention` (how many days Orbit keeps a removed
 * document, a household whose deletion was asked for, and an unreviewed
 * arrival), read from the engine's own constants and configuration. Nothing in
 * the browser spells any of them: a screen takes them from its view and
 * prints or checks against them.
 */

/**
 * @typedef {object} EngineLimits
 * @property {number} archiveFileBytes  the most an archive file can weigh
 * @property {number} passphraseMin
 * @property {number} passphraseMax
 */

/**
 * @typedef {object} EngineRetention
 * @property {number} documentDays   a removed document, before it is gone for good
 * @property {number} recoveryDays   a household asked to be deleted, until it is gone for good
 * @property {number} receiptDays    an unreviewed mail-in arrival, before it burns up
 */

/**
 * What a view carries from the session: both blocks, or null for each when
 * the session could not be read (the screen then says nothing it cannot back).
 *
 * @param {{ limits?: EngineLimits, retention?: EngineRetention } | null | undefined} session
 * @returns {{ limits: EngineLimits | null, retention: EngineRetention | null }}
 */
export function engineNumbersOf(session) {
  return { limits: session?.limits ?? null, retention: session?.retention ?? null };
}

/**
 * A count of days in words: "1 day", "30 days". When the number is unknown
 * (the session could not be read) the caller's own words stand in, never a
 * guessed number.
 *
 * This is the retention words helper; it folds into format.js's plural()
 * once that lands.
 *
 * @param {number | null | undefined} days
 * @param {string} [unknown]
 */
export function daysWords(days, unknown = "a limited time") {
  if (typeof days !== "number") return unknown;
  return `${days} ${days === 1 ? "day" : "days"}`;
}
