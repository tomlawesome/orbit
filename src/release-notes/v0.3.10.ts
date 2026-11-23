import type { ReleaseNotes } from "./index";

// What v0.3.10 tells people (docs/releasing.md); wording approved by the owner, 86a.
export const notes: ReleaseNotes = {
  version: "v0.3.10",
  forEveryone: [
    { lead: "Reminders", text: "The Add form offers the same reminder days on desk and phone, and you can type any number of days from 1 to 365, up to eight reminders." },
    { lead: "Reading pages", text: "A page that fails to load offers Try again, and a busy server retries a page once by itself instead of failing." },
    { lead: "Signing in", text: "After you refuse a sign-in approval, Orbit asks for a new password first, and changing your password cancels sign-in approvals still waiting." },
    { lead: "Keyboard", text: "Text size, importance, the repeat period and section colours move with the arrow keys, Home and End." },
    { lead: "Saving", text: "A colour that fails to save is put back with its error, and Home no longer says done when a document could not be read." },
  ],
  forAdministrators: [
    { lead: "Members' addresses", text: "You can set a member's registered address from the people list when Orbit cannot read it back." },
    { lead: "Update check", text: "Before an update, Orbit checks that the release can update the database, and stops with the reason if it cannot." },
    { lead: "Repair", text: "Repair run as root works as the folder's owner, only one run works on a folder at a time, and a stopped run leaves no lock or recovery copy behind." },
    { lead: "Restore", text: "A failed restore keeps the original, and the messages say where the backups are and to re-enter the mail password afterwards." },
    { lead: "Web push", text: "A push address that leads to a private network is refused." },
    { lead: "Images", text: "ClamAV and Ollama are updated, and GitLab's signature on each image now also covers its parts list (SBOM)." },
  ],
};
