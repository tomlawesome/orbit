/**
 * The administrator-facing view of a document-KEK rotation (#956): whether
 * one is open, since when, and whether this process is holding the second
 * key. Deliberately a separate module from the rewrap worker, which takes
 * keys as explicit arguments and never reads configuration — this side reads
 * the running configuration precisely because "is a second key loaded HERE"
 * is the question.
 *
 * The answer is bounded for the admin HTTP surface: no key ids. The
 * document-health route already withholds them from administrators
 * (`toPublicDocumentHealth`, and the evidence test greps the payload for
 * "keyId"), and this surface keeps the same line. The key ids live in the
 * audit rows and the startup log, which is where an operator doing the
 * rotation actually needs them.
 */
import { getDocumentConfig } from "@/server/documents/config";
import { findOpenRotationStart } from "@/server/documents/rewrap-worker";

export interface KekRotationStatus {
  /** True when a started audit row is open or this process holds a second key. */
  inProgress: boolean;
  /** ISO start of the open rotation, from the started audit row; null when unrecorded. */
  startedAt: string | null;
  /** Whether this process currently holds `DOCUMENT_KEK_NEXT`. */
  secondKeyLoaded: boolean;
}

/**
 * Never throws: a rotation status that cannot be fully answered reports the
 * half it can, because the administration screen must not sink over it and
 * broken document configuration already has its own reporting path.
 */
export async function getKekRotationStatus(): Promise<KekRotationStatus> {
  let secondKeyLoaded = false;
  try {
    secondKeyLoaded = getDocumentConfig().nextKeyId !== null;
  } catch {
    // Invalid document configuration is validateStartupConfiguration's story.
  }
  let startedAt: string | null = null;
  let open = false;
  try {
    const started = await findOpenRotationStart();
    open = started !== null;
    startedAt = started ? started.startedAt.toISOString() : null;
  } catch {
    // Audit log unreadable: report what the process itself knows.
  }
  return { inProgress: open || secondKeyLoaded, startedAt, secondKeyLoaded };
}
