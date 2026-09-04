import { readPortableArchive } from "orbit/server/portable-archive-repository";

import { read } from "$lib/server/api.js";

/**
 * Streams a portable archive's encrypted bytes to the caller who created it
 * (#735 port).
 *
 * Returns a bare `Response`, not `json()` — the body is the archive file —
 * and the buffer is zeroed after copying, same as the document download,
 * since these bytes are decrypted archive contents.
 */
export const GET = read(async (event, session) => {
  const archiveId = /** @type {string} */ (event.params.archiveId);
  const archive = await readPortableArchive(session.user.id, archiveId);
  const body = Uint8Array.from(archive.bytes);
  archive.bytes.fill(0);
  return new Response(body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="orbit-export-${archiveId}.json"`,
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
