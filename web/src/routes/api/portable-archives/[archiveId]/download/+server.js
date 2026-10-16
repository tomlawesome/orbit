import { openPortableArchiveDownload } from "orbit/server/portable-archive-repository";

import { read } from "$lib/server/api.js";

/**
 * Streams a portable archive's encrypted bytes to the caller who created it
 * (#735 port).
 *
 * Returns a bare `Response`, not `json()` — the body is the archive file.
 * Nothing is buffered (#1428): the repository has already checked the file's
 * hash in one streaming pass, and the body streams it from disk in small
 * chunks; cancelling the download closes the file.
 */
export const GET = read(async (event, session) => {
  const archiveId = /** @type {string} */ (event.params.archiveId);
  const { stream, sizeBytes } = await openPortableArchiveDownload(session.user.id, archiveId);
  return new Response(stream, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="orbit-export-${archiveId}.json"`,
      "Content-Length": String(sizeBytes),
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
