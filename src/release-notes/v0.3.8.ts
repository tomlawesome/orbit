import type { ReleaseNotes } from "./index";

// What v0.3.8 tells people (docs/releasing.md); wording approved by the owner, 52c and 53a.
export const notes: ReleaseNotes = {
  version: "v0.3.8",
  forEveryone: [
    { lead: "Duplicate documents", text: "Orbit now tells you when you upload a document your household already holds." },
    { lead: "Faster pages", text: "Each page of a document is drawn once and kept, encrypted, so turning pages is quick." },
    { lead: "Orbit's mail", text: "Every email Orbit sends now uses Orbit's own mail design." },
    { lead: "Household export", text: "Large household exports now work, because an export no longer has to fit in memory." },
  ],
  forAdministrators: [
    { lead: "Mail setup", text: "Sending and receiving mail are set on one Mail card in Administration, stored encrypted." },
    { lead: "No mail settings in .env-orbit", text: "Orbit now keeps its mail settings itself, so you no longer edit .env-orbit to set up or change mail." },
    { lead: "Fetch now", text: "A Fetch now button checks the mailbox on demand." },
    { lead: "Email size limit", text: "Email coming into Orbit was capped at 25 MB, or less if the upload limit was lower. It now has its own size limit in Administration, up to 50 MB, so you can let in larger emails without also allowing larger uploads, or the other way round." },
    { lead: "Exports kept", text: "You set how long exports are kept, how many per household and how much space they may use, under Exports kept." },
    { lead: "ClamAV", text: "ClamAV is now optional: still on by default, with a recommendation if you turn it off." },
    { lead: "Updating", text: "An update.sh in the Orbit folder runs the latest updater, and repair can start services that are not running or recreate containers after a folder move." },
    { lead: "PDF limits", text: "Checking a PDF needs far less memory; new uploads are limited to 100 pages, and stored documents keep the limit they were accepted under." },
  ],
};
