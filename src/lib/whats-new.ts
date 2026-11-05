/**
 * Which releases a person is shown in the what's-new notice (#1618) and in
 * the About page's release notes (#1713). Pure: the caller reads the stored
 * version and the administrator flag.
 */
import { compareReleaseVersions, parseReleaseVersion } from "@/lib/release-version";
import type { Bullet, ReleaseNotes } from "@/release-notes";

export interface WhatsNewRelease {
  version: string;
  forEveryone: Bullet[];
  forAdministrators?: Bullet[];
}

export interface WhatsNewAnswer {
  version: string | null;
  releases: WhatsNewRelease[];
}

export interface SelectWhatsNewInput {
  seen: string | null;
  running: unknown;
  isAdmin: boolean;
  notes: readonly ReleaseNotes[];
}

/**
 * Releases R with seen < R <= running, newest first. A release with nothing
 * for this person is left out. Empty (and a null version) when the running
 * version does not parse; empty when seen is null, unparsable, or not below
 * running (a downgrade).
 */
export function selectWhatsNew({ seen, running, isAdmin, notes }: SelectWhatsNewInput): WhatsNewAnswer {
  if (parseReleaseVersion(running) === null) return { version: null, releases: [] };
  const version = running as string;
  if (seen === null || parseReleaseVersion(seen) === null) return { version, releases: [] };
  const window = notes.filter((note) => parseReleaseVersion(note.version) !== null
    && compareReleaseVersions(note.version, seen) > 0
    && compareReleaseVersions(note.version, version) <= 0);
  return { version, releases: forPerson(window, isAdmin) };
}

export interface SelectReleaseNotesInput {
  running: unknown;
  isAdmin: boolean;
  notes: readonly ReleaseNotes[];
}

/**
 * The About page's "Release notes" (#1713): every bundled release, newest
 * first, filtered by role exactly as selectWhatsNew is, but with no window --
 * what the person has seen does not matter. `version` is the running version,
 * or null when it does not parse (a dev build), which marks none.
 */
export function selectReleaseNotes({ running, isAdmin, notes }: SelectReleaseNotesInput): WhatsNewAnswer {
  const version = parseReleaseVersion(running) === null ? null : running as string;
  return { version, releases: forPerson(notes, isAdmin) };
}

/**
 * The role filter both selections share: parseable releases, newest first; a
 * member gets the for-everyone part only, an administrator both; a release
 * with nothing for this person is left out. Changes nothing it was given.
 */
function forPerson(notes: readonly ReleaseNotes[], isAdmin: boolean): WhatsNewRelease[] {
  const releases: WhatsNewRelease[] = [];
  const candidates = notes
    .filter((note) => parseReleaseVersion(note.version) !== null)
    .sort((left, right) => compareReleaseVersions(right.version, left.version));
  for (const note of candidates) {
    if (isAdmin) {
      if (note.forEveryone.length || note.forAdministrators.length) {
        releases.push({ version: note.version, forEveryone: note.forEveryone, forAdministrators: note.forAdministrators });
      }
    } else if (note.forEveryone.length) {
      releases.push({ version: note.version, forEveryone: note.forEveryone });
    }
  }
  return releases;
}
