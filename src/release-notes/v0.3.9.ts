import type { ReleaseNotes } from "./index";

// What v0.3.9 tells people (docs/releasing.md); wording approved by the owner, 49a.
export const notes: ReleaseNotes = {
  version: "v0.3.9",
  forEveryone: [
    { lead: "Flagged attachments", text: "When the virus scanner flags an attachment on held mail, the inbox card names it and lets you add the email without it, or discard it all." },
    { lead: "Sending addresses", text: "You can list up to five addresses you send from and check each one; mail from an address you haven't checked waits until you do." },
    { lead: "Scanner down", text: "If the virus scanner can't be reached, a new document waits to be scanned instead of being refused." },
    { lead: "Mail relay", text: "Your mail relay is now a tab on the Mail card in Settings." },
    { lead: "Outlook", text: "Outlook and Hotmail are no longer offered as a mail provider; a saved Outlook setting keeps working as Other." },
    { lead: "Page previews", text: "A page preview that is missing or damaged is drawn again instead of showing an error." },
  ],
  forAdministrators: [
    { lead: "Backups", text: "Backing up or restoring an Orbit that has page previews is no longer refused, and the previews are included." },
    { lead: "Mail settings", text: "Updating moves any SMTP lines in .env-orbit into Orbit's Mail settings, then removes them from the file." },
    { lead: "Repair", text: "Repair won't start Orbit while a restore is unfinished, a database volume is missing, or it can't tell the containers belong to this folder; it says what to do instead." },
    { lead: "Alerts", text: "You're emailed, at most once a day, when the virus scanner can't be reached or when undoing a failed archive import fails." },
    { lead: "Uploads", text: "A stalled archive upload no longer holds disk space it hasn't used, and an archive too big for the household is refused as soon as Orbit can tell." },
    { lead: "Key rotation", text: "Key rotation's re-encryption step now runs on an installed Orbit, using the command in the rotation guide." },
    { lead: "Signed images", text: "Each image on ghcr.io now carries GitLab's signature over the image and its parts list (SBOM, the software bill of materials), which cosign verify-attestation can check." },
  ],
};
