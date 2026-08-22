/**
 * THE ARRIVAL, as logic (#410, §15 — "first-run is a launch, not a form").
 *
 * Everything the arrival decides, decided in one pure file so it can be read
 * and tested without a browser: WHICH surface an authenticated reader lands
 * on, what the create card may ask, what the create command looks like, and
 * how the newcomer's count reads.
 *
 * THE LAW THIS FILE SERVES (owner, 2026-08-16, sealed): "the first-run screen
 * doesn't get its own page — it sits ON TOP of the login screen". So there is
 * no /first-run and no /welcome: the front door is one surface with stages,
 * and this is the switch. See Arrival.svelte for the surfaces themselves.
 */

/** The reader is signed out, or we have not asked yet: the door is the door. */
export const DOOR = "door";
/** Asked, not answered. The dawn is up and the login chrome is held back, so
 *  a reader who is already through the door never sees it flash past. */
export const ASKING = "asking";
/** Zero households, and none out there either: the first admin names the
 *  first system (design/v19/first-run.html's create card). */
export const CREATE = "create";
/** Zero households on an instance that has some: the newcomer's arrival. */
export const NEWCOMER = "newcomer";
/** A member. Home is theirs; the door hands them on to it. */
export const ONWARD = "onward";

/**
 * Which stage a signed-in reader's workspace puts them on.
 *
 * The whole decision is already in `GET /api/workspace`: `households` is what
 * this reader belongs to, and `visibleHouseholds` — populated by the server
 * only on the choose branch (§11, #453) — is every live system on the
 * instance. An instance administrator is never a newcomer, because the server
 * hands them every household as a member would see it, so they leave here
 * through ONWARD as soon as one system exists.
 */
export function arrivalStageOf(workspace) {
  if (!workspace) return ASKING;
  if ((workspace.households ?? []).length > 0) return ONWARD;
  return (workspace.visibleHouseholds ?? []).length > 0 ? NEWCOMER : CREATE;
}

/**
 * "N SYSTEMS DISCOVERED IN THIS UNIVERSE" — the newcomer's boxless beat.
 *
 * The count is READ off the households and never written (owner: "the number
 * real"), and it is the newcomer's, not the first admin's: "a first admin
 * always signs in to zero households, so counting them here was counting
 * nothing."
 */
export function discoveredCountOf(visibleHouseholds) {
  const count = (visibleHouseholds ?? []).length;
  return { count, word: count === 1 ? "system" : "systems" };
}

/**
 * THE SEALED REJECTION, and where its truth comes from.
 *
 * The sheet's error is one warm line — «"Lawson Home" already exists here —
 * ask to join it →» — and it calls that line the server's refusal. The server
 * has no instance-wide unique name to refuse on (no owner ruling asks for
 * one, and imposing one would change every existing caller of
 * `household.create`), but it does hand this exact reader the whole list of
 * systems they could ask to join instead: `visibleHouseholds`, straight out
 * of `GET /api/workspace`. So the name is checked against server-supplied
 * truth rather than against a guess, and the line can offer the road it
 * promises — the ask-to-join it names is a household this reader can really
 * ask to join.
 *
 * Case- and space-insensitive, because "lawson home" and "Lawson  Home" are
 * the same answer to the reader and the refusal has to read as one.
 */
export function collidingHouseholdOf(name, visibleHouseholds) {
  const wanted = normaliseName(name);
  if (!wanted) return null;
  return (visibleHouseholds ?? []).find((household) => normaliseName(household.name) === wanted) ?? null;
}

function normaliseName(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The three questions, and only the three (§15, "first-run asks three things
 * only"). The lists are design/v19/first-run.html's own, in its own order,
 * because the card is ported pixel for pixel and a select's first option is
 * what the frame shows.
 *
 * `label` is what the sheet prints; `value` is what a server can act on. They
 * differ in exactly one place — the sheet writes "America/New York" where the
 * zone database writes "America/New_York" — and the reader is shown the
 * sheet's word.
 */
export const TIME_ZONES = [
  { value: "Europe/London", label: "Europe/London" },
  { value: "Europe/Dublin", label: "Europe/Dublin" },
  { value: "Europe/Paris", label: "Europe/Paris" },
  { value: "America/New_York", label: "America/New York" },
  { value: "Australia/Sydney", label: "Australia/Sydney" },
  { value: "UTC", label: "UTC" },
];

export const CURRENCIES = ["GBP", "EUR", "USD", "CAD", "AUD", "NZD"];

/** The name the field will take, bounded the way the server bounds it. */
export const NAME_LIMIT = 60;

/**
 * "Read off your browser" (the sheet's own title attribute), and only when the
 * browser's answer is one of the six the card offers — otherwise the card's
 * first option stands. A reader whose zone is not on this short list changes
 * it on the household screen afterwards, which is where the sheet says every
 * one of these answers moves to.
 */
export function preferredTimeZone(detected) {
  return TIME_ZONES.some((zone) => zone.value === detected) ? detected : TIME_ZONES[0].value;
}

export function preferredCurrency(detected) {
  return CURRENCIES.includes(detected) ? detected : CURRENCIES[0];
}

/**
 * THE COMMAND (§11: any user may create a household and becomes its owner).
 *
 * `household.create` on `POST /api/workspace/commands`, which is the road the
 * sheet gives this exact case: "a second system from an empty sky uses
 * household.create down the same road". The first admin travels it too,
 * because this engine leaves no household shell behind to complete — see the
 * note on `householdCreateSchema` in src/lib/workspace.ts.
 *
 * THREE FIELDS AND NOTHING ELSE: no sections. The server applies the default
 * set (`cloneSections()`), so there is one place that decides what a new
 * system starts with, exactly as the sealed sheet requires.
 */
export function createSystemCommand({ name, timezone, currency }, ids = { uuid: () => crypto.randomUUID() }) {
  return {
    type: "household.create",
    household: {
      id: ids.uuid(),
      name: String(name ?? "").trim().slice(0, NAME_LIMIT),
      timezone,
      currency,
      onboardingComplete: true,
    },
  };
}

/**
 * What the button says. The sheet writes the system's name into it as it is
 * typed — "create Lawson Home →" — and falls back to the unnamed word.
 */
export function createButtonLabel(name) {
  const trimmed = String(name ?? "").trim();
  return trimmed ? `create ${trimmed} →` : "create this system →";
}

/**
 * The one line that survives the strip, read off the real default set rather
 * than a typed number: "4 sections to start · change them later".
 *
 * The names live on the server (src/lib/domain.ts's `defaultSections`) because
 * the server is what applies them; this is the count the card admits to, and
 * it is stated here so the sentence cannot drift from the list without
 * somebody having to edit both.
 */
export const DEFAULT_SECTIONS = ["Home", "Vehicles", "Devices", "Services"];

export function sectionNote(sections = DEFAULT_SECTIONS) {
  return `${sections.length} sections to start · change them later`;
}

export function sectionNoteTitle(sections = DEFAULT_SECTIONS) {
  return `${sections.join(", ")} are set up for you — rename, add or remove them on the household screen.`;
}

/**
 * The card's list of systems to ask to join, and the sky behind it, in ONE
 * order (the sheet: "the card's list is the same households, in the same
 * order, as words"). The sky is placed by id — `placeGalaxy` sorts them — so
 * the card sorts by id too and the two agree row for constellation.
 */
export function belongRowsOf(galaxy) {
  return Object.keys(galaxy ?? {})
    .sort()
    .map((id) => ({ id, name: galaxy[id].name, requested: Boolean(galaxy[id].requested) }));
}
