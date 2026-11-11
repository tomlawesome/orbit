import type { ReleaseNotes } from "./index";

// What v0.3.8 tells people (docs/releasing.md); wording awaits the owner's approval.
export const notes: ReleaseNotes = {
  version: "v0.3.8",
  forEveryone: [
    { lead: "Duplicate documents", text: "Orbit now tells you when you upload a document your household already holds." },
    { lead: "Faster pages", text: "Each page of a document is drawn once and kept, encrypted, so turning pages is quick." },
    { lead: "Orbit's mail", text: "Every email Orbit sends now uses Orbit's own mail design." },
    { lead: "Household export", text: "Large household exports now work, because an export no longer has to fit in memory." },
    { lead: "Sky key", text: "The sky's key names every section that wears a colour." },
  ],
  forAdministrators: [
    { lead: "Mail setup", text: "Sending and receiving mail are set on one Mail card in Administration, stored encrypted, with nothing to edit in .env-orbit." },
    { lead: "Mail checks and size", text: "A Fetch now button checks the mailbox at once, and the largest mail message is set apart from the upload limit." },
    { lead: "Exports kept", text: "You set how long exports are kept, how many per household and how much space they may use, under Exports kept." },
    { lead: "ClamAV", text: "ClamAV is now optional: still on by default, with a recommendation if you turn it off." },
    { lead: "Updating", text: "An update.sh in the Orbit folder runs the latest updater, and repair can start services that are not running or recreate containers after a folder move." },
    { lead: "PDF limits", text: "Checking a PDF needs far less memory; new uploads are limited to 100 pages, and stored documents keep the limit they were accepted under." },
  ],
};
