/**
 * The manifest's vocabulary, shared (#445): a date, its distance in days, a
 * cost in minor units. One place, so T−161d means the same thing on every
 * screen. Pinned to the design's own today until real data arrives, so the
 * screens agree with the chart that sent you to them.
 */
export const DESIGN_TODAY = "2026-08-13";

/**
 * @param {string} iso
 * @returns {number}
 */
export const day = (iso) => Math.round(Date.parse(iso + "T00:00:00Z") / 86400000);

/**
 * Whole calendar days from one bare date to another: positive when `to` is
 * later, negative when earlier, zero for the same day (#1337). The one count
 * of days between two dates in the browser: bare dates are read as UTC
 * midnights, so a clock change never makes a 23-hour day.
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
export const daysBetween = (from, to) => day(to) - day(from);

/**
 * The urgency band a count of days away falls in: overdue, due soon (30
 * days), upcoming (90), later; `unscheduled` for no count (#1337: the one
 * `bandOf`, chart.js's vocabulary, which the corridor, the dial and the
 * calendar's foot line all use).
 * @param {?number} [days]
 * @returns {"unscheduled" | "overdue" | "due-soon" | "upcoming" | "ok"}
 */
export function bandOf(days) {
  if (days === null || days === undefined) return "unscheduled";
  if (days < 0) return "overdue";
  if (days <= 30) return "due-soon";
  if (days <= 90) return "upcoming";
  return "ok";
}

/**
 * The same label from a count of days already worked out. Null-safe: an
 * unscheduled row's `days` is null, which would otherwise print "T−nulld".
 * @param {number | null | undefined} days
 * @returns {string}
 */
export const tminusOf = (days) =>
  days === null || days === undefined ? "" : days < 0 ? `T+${-days}d` : `T−${days}d`;

/**
 * @param {string} due
 * @param {string} [today]
 * @returns {string}
 */
export const tminus = (due, today = DESIGN_TODAY) => tminusOf(daysBetween(today, due));

/**
 * The twelve months, short, in order: one table for every screen that names a
 * month (#1340). Hand-built rather than read from `Intl`, whose short September
 * is "Sept" in some builds and "Sep" in others.
 */
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* Dates (#1339). One vocabulary, a two-digit day everywhere ("05 Oct",
   "05 Oct 2026"). Each variant takes a bare date ("2026-10-05"), which names
   a calendar day and is never moved by any zone, or an instant plus the
   household zone (an IANA name; UTC when left out). */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/**
 * @param {string} key
 * @param {Intl.DateTimeFormatOptions} options
 */
const formatter = (key, options) => {
  let one = formatters.get(key);
  if (!one) formatters.set(key, (one = new Intl.DateTimeFormat("en-GB", options)));
  return one;
};

/**
 * @param {string} value  a bare date or an instant
 * @param {string} [zone]
 * @returns {{ at: Date, zone: string }}
 */
const momentOf = (value, zone = "UTC") =>
  BARE_DATE.test(value)
    ? { at: new Date(value + "T00:00:00Z"), zone: "UTC" }
    : { at: new Date(value), zone };

/**
 * @param {string} value
 * @param {string | undefined} zone
 * @param {Intl.DateTimeFormatOptions} options
 * @returns {string}
 */
const render = (value, zone, options) => {
  const moment = momentOf(value, zone);
  if (Number.isNaN(moment.at.getTime())) return "";
  const settings = { ...options, timeZone: moment.zone };
  return formatter(JSON.stringify(settings), settings).format(moment.at);
};

/**
 * The browser's own zone, for a screen that reads an instant in the viewer's
 * clock rather than the household's.
 * @returns {string}
 */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * "05 Oct": day and short month.
 * @param {string} value  a bare date or an instant
 * @param {string} [zone]  an IANA zone, for an instant
 * @returns {string}
 */
export const dayMonth = (value, zone) => {
  const parts = render(value, zone, { day: "2-digit", month: "2-digit" }).split("/");
  return parts.length === 2 ? `${parts[0]} ${MONTHS[Number(parts[1]) - 1]}` : "";
};

/**
 * "05 Oct 2026": for a line that sits under something else and is read after
 * it, where the month spelled out would be the longest word on the row (#481's
 * held seat).
 * @param {string} value
 * @param {string} [zone]
 * @returns {string}
 */
export const dayMonthYear = (value, zone) => {
  const parts = render(value, zone, { day: "2-digit", month: "2-digit", year: "numeric" }).split("/");
  return parts.length === 3 ? `${parts[0]} ${MONTHS[Number(parts[1]) - 1]} ${parts[2]}` : "";
};

/**
 * "05 October 2026": the month spelled out.
 * @param {string} value
 * @param {string} [zone]
 * @returns {string}
 */
export const longDate = (value, zone) =>
  render(value, zone, { day: "2-digit", month: "long", year: "numeric" });

/**
 * "October": the month's long name alone.
 * @param {string} value
 * @param {string} [zone]
 * @returns {string}
 */
export const monthOnly = (value, zone) => render(value, zone, { month: "long" });

/**
 * "Thu": the weekday, short.
 * @param {string} value
 * @param {string} [zone]
 * @returns {string}
 */
export const weekdayOf = (value, zone) => render(value, zone, { weekday: "short" });

/**
 * "15:30": the time of day, twenty-four hour, in the zone given.
 * @param {string} value  an instant
 * @param {string} [zone]
 * @returns {string}
 */
export const clockOf = (value, zone) =>
  render(value, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * @param {number | null | undefined} minor
 * @param {string} currency
 * @param {boolean} [estimate]
 * @returns {string}
 */
export const money = (minor, currency, estimate = false) => {
  if (minor === null || minor === undefined) return "—";
  const amount = new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
  return estimate ? `~${amount}` : amount;
};

/**
 * A recurrence in words: "every month", "every 3 months", "every year",
 * "every 2 years" (owner, 2026-10-09: a 12-month repeat reads "every year").
 * @param {number} months
 * @returns {string}
 */
export const every = (months) => {
  if (months === 12) return "every year";
  if (months === 24) return "every 2 years";
  return months === 1 ? "every month" : `every ${months} months`;
};

/**
 * A count with its noun: "1 task", "2 tasks". A noun that does not just add
 * an "s" gives its plural: plural(2, "try", "tries").
 * @param {number} n
 * @param {string} word
 * @param {string} [many]
 * @returns {string}
 */
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * A file's size: under 1 KB "N B", under 1 MB a whole number of KB, from 1 MB
 * up MB with one decimal.
 * @param {number} bytes
 * @returns {string}
 */
export const sizeLabel = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * The letters in a person's avatar: the first letter of the first two words,
 * upper case, or "·" when there is no name to read.
 * @param {string | null | undefined} name
 * @returns {string}
 */
export const initials = (name) => {
  const letters = (name ?? "").trim().split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase();
  return letters || "·";
};

/**
 * A currency's sign as the browser writes it: "£", "€", "$".
 * @param {string} currency  an ISO 4217 code
 * @returns {string}
 */
export const symbolOf = (currency) => {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, currencyDisplay: "narrowSymbol" })
      .formatToParts(0).find((part) => part.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
};

/* Elapsed time in the relay's two registers: "4m ago" for chrome lines,
   "4 minutes ago" for sentences. `now` is passed in, never read from the
   clock, so fixtures pin it and the gate holds still. */
/**
 * @param {string} iso
 * @param {string} now
 * @returns {string}
 */
export const ago = (iso, now) => {
  const minutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

/**
 * How long, in the sentence register: "4 minutes", "3 days". `now` is passed
 * in, like `ago`'s.
 * @param {string} iso
 * @param {string} now
 * @returns {string}
 */
export const elapsed = (iso, now) => {
  const minutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60000));
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  return plural(Math.round(hours / 24), "day");
};

/**
 * @param {string} iso
 * @param {string} now
 * @returns {string}
 */
export const agoLong = (iso, now) => `${elapsed(iso, now)} ago`;
