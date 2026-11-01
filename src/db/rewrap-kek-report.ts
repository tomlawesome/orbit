/**
 * The completion text `pnpm rewrap-kek` prints, kept apart from rewrap-kek.ts
 * so it can be tested: that script runs on import and needs a database.
 * Type-only imports keep this module free of the worker's database code.
 */
import type { SkippedOnOlderKey } from "@/server/documents/rewrap-worker";

/**
 * The lines printed once the rewrap has run to completion, built from the
 * skipped ids alone. They are loaded once, at completion: the rotation's
 * progress carries only counts.
 *
 * When held objects were skipped, every one is named so the operator can find
 * it, and the report says to keep the older key before it says to replace the
 * secret: without that key those objects can never be read or moved again.
 */
export function completionReport(skippedIds: SkippedOnOlderKey): string[] {
  const { heldAttachmentIds, stagingObjectIds } = skippedIds;
  const skipped = heldAttachmentIds.length + stagingObjectIds.length;
  if (skipped === 0) {
    return [
      "Rewrap complete: every row now decrypts only under the next key.",
      "Replace the live document-kek secret with it, remove DOCUMENT_KEK_NEXT, and restart Orbit to finish the rotation.",
    ];
  }
  return [
    `Rewrap complete: every row now decrypts only under the next key, except the ${skipped} skipped held object(s) below.`,
    ...heldAttachmentIds.map((id) => `  held mail attachment: ${id}`),
    ...stagingObjectIds.map((id) => `  scanner-recovery object: ${id}`),
    "Keep the older document key: these objects stay unreadable until a rotation from that key.",
    "Replace the live document-kek secret with the next key, remove DOCUMENT_KEK_NEXT, and restart Orbit to finish the rotation.",
  ];
}
