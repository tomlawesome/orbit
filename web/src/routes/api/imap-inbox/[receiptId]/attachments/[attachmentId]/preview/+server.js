import { readHeldImapAttachmentPreview } from "orbit/server/mail-in/imap-attachment-preview";
import { parseDocumentPreviewPage } from "orbit/server/documents/preview-page";

import { INBOX_FIXTURE } from "$lib/data/fixtures/inbox.js";
import { placeholderPageSvg } from "$lib/server/document-content-fixture.js";
import { placeholderResponse, previewResponse } from "$lib/server/preview-response.js";
import { read } from "$lib/server/api.js";

/**
 * A picture of one page of an attachment still staged inside a waiting mail
 * receipt (#1155); `?page=N` and `X-Orbit-Page-Count` as the accepted
 * document's preview route has them (#1300) — the same reading card and reader an accepted document's
 * preview draws into, before the member has decided whether to accept it.
 *
 * Answered only to the mail's own recipient, and only while the message is
 * still `pending_review` and the attachment still `stored`; every other case
 * answers the same 404 an unknown or already-decided receipt does (never a
 * 403 — see `readHeldImapAttachmentPreview`). No `documents` row is read or
 * created; acceptance is unchanged.
 */
export const GET = read(
  async (event, session) => {
    const receiptId = /** @type {string} */ (event.params.receiptId);
    const attachmentId = /** @type {string} */ (event.params.attachmentId);
    const page = parseDocumentPreviewPage(event.url.searchParams);
    const preview = await readHeldImapAttachmentPreview(session.user.id, receiptId, attachmentId, page);
    return previewResponse(preview);
  },
  {
    fixture: (event) => {
      const page = parseDocumentPreviewPage(event.url.searchParams);
      const receiptId = /** @type {string} */ (event.params.receiptId);
      const attachmentId = /** @type {string} */ (event.params.attachmentId);
      const receipt = INBOX_FIXTURE.receipts.find((one) => one.id === receiptId);
      const attachment = receipt?.attachments?.find((one) => one.id === attachmentId);
      if (!attachment) return new Response(null, { status: 404 });
      return placeholderResponse(placeholderPageSvg(attachment.displayName), page);
    },
  },
);
