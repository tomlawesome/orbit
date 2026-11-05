/**
 * Which releases a person is shown in the what's-new notice (#1618). Pure:
 * the caller reads the stored version and the administrator flag.
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
  const releases: WhatsNewRelease[] = [];
  const candidates = notes
    .filter((note) => parseReleaseVersion(note.version) !== null
      && compareReleaseVersions(note.version, seen) > 0
      && compareReleaseVersions(note.version, version) <= 0)
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
  return { version, releases };
}
