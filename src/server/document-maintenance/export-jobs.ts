/**
 * The household export's worker seam (#1774, ADR-0047): the job table
 * `portable_archive_exports`, in `document_jobs`' shape (ADR-0010), claimed
 * here one export at a time.
 *
 * Standard pattern: a durable job row with a lease, claimed by the existing
 * worker -- the preview seam's claim, on its own table, with a ten-minute
 * lease every progress write renews. The job takes the process-wide archive
 * slot (src/server/archive-slot.ts) the way a spooled upload does: it waits,
 * longest first, up to ORBIT_ARCHIVE_SLOT_WAIT_MS, and a wait that runs out
 * puts the job back a minute without counting an attempt. The job waits for
 * the slot before it is claimed, so the card says "queued" for the whole
 * wait. Its own loop is started beside the preview loop, and the route's
 * `notifyExportWorker()` cuts its idle sleep short.
 *
 * Orbit is one process, so a `processing` row this process is not writing
 * when it starts is dead: `requeueInterruptedExports()` puts it back (or, the
 * third time running, ends it as failed), once per process, finished before
 * the export loop's first claim. The cycle also nulls a failed job's key after an
 * hour and deletes finished jobs after a day.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { log, operationalDetail } from "@/lib/logger";
import { awaitArchiveSlot } from "@/server/archive-slot";
import { absoluteAppLink, sendBoundedMail } from "@/server/invitations/send";
import { openInstanceMetadataReader } from "@/server/metadata/fields";
import {
  EXPORT_KEY_RETENTION,
  EXPORT_MAX_ATTEMPTS,
  runPortableArchiveExportJob,
  type ClaimedPortableArchiveExport,
} from "@/server/portable-archive-repository";

/** A slot wait that ran out puts the job back this long, with no attempt counted. */
const EXPORT_SLOT_RETRY_SECONDS = 60;
/** Sleep when nothing was due; `notifyExportWorker()` cuts it short. */
const EXPORT_IDLE_MS = 30_000;
/** The words a third interruption in a row ends the job with. */
const INTERRUPTED_MESSAGE = "Orbit restarted while writing this archive; try again";

const exportWorkerState = globalThis as typeof globalThis & {
  __orbitExportWorkerStarted?: boolean;
  __orbitExportWorkerWake?: () => void;
  /** Jobs this process is writing right now: never "interrupted". */
  __orbitExportsInFlight?: Set<string>;
  /** The boot requeue, once per process; the loop waits for it before its first claim. */
  __orbitExportsBootRequeue?: Promise<void>;
};

function inFlight(): Set<string> {
  exportWorkerState.__orbitExportsInFlight ??= new Set();
  return exportWorkerState.__orbitExportsInFlight;
}

const DUE = sql`(
  (job.status in ('pending', 'retry') and job.next_attempt_at <= now())
  or (job.status = 'processing' and job.lease_expires_at < now())
)`;

async function dueExport(): Promise<string | undefined> {
  const rows = await getDb().execute(sql`
    select job.id from portable_archive_exports job
    where ${DUE}
    order by job.next_attempt_at, job.created_at
    limit 1
  `) as unknown as Array<{ id: string }>;
  return rows[0]?.id;
}

/** The oldest due export, claimed: `processing`, one more attempt, a fresh lease token. */
async function claimExport(): Promise<ClaimedPortableArchiveExport | undefined> {
  const rows = await getDb().execute(sql`
    with claimable as materialized (
      select job.id
      from portable_archive_exports job
      where ${DUE}
      order by job.next_attempt_at, job.created_at
      for update of job skip locked
      limit 1
    )
    update portable_archive_exports as job
    set status = 'processing',
        attempts = job.attempts + 1,
        locked_at = now(),
        lease_expires_at = now() + interval '10 minutes',
        lease_token = gen_random_uuid(),
        updated_at = now()
    from claimable
    where job.id = claimable.id
    returning job.id, job.household_id as "householdId", job.requested_by_user_id as "requestedByUserId",
      job.include_documents as "includeDocuments", job.attempts, job.lease_token as "leaseToken",
      job.salt, job.key_wrapped as "keyWrapped", job.key_id as "keyId"
  `) as unknown as ClaimedPortableArchiveExport[];
  return rows[0];
}

/** The slot did not come: back to `retry` a minute from now, attempts as they were. */
async function deferExport(id: string): Promise<void> {
  await getDb().execute(sql`
    update portable_archive_exports job
    set status = 'retry',
        next_attempt_at = now() + ${`${EXPORT_SLOT_RETRY_SECONDS} seconds`}::interval,
        locked_at = null, lease_expires_at = null, lease_token = null,
        updated_at = now()
    where job.id = ${id} and ${DUE}
  `);
}

/**
 * One pass: the oldest due export, if any, waits for the archive slot, is
 * claimed and run to its end. Resolves to the number of exports it took (0
 * when none was due or the slot did not come in time). A test hook's
 * PortableArchiveExportCrash is rethrown, as a dying process would leave it.
 */
export async function runExportWorkerOnce(): Promise<number> {
  const due = await dueExport();
  if (due === undefined) return 0;
  const slot = await awaitArchiveSlot();
  if (slot === null) {
    await deferExport(due);
    return 0;
  }
  let job: ClaimedPortableArchiveExport | undefined;
  let completed = false;
  try {
    job = await claimExport();
    if (!job) return 0;
    inFlight().add(job.id);
    try {
      completed = (await runPortableArchiveExportJob(job)).status === "completed";
    } finally {
      inFlight().delete(job.id);
    }
  } finally {
    slot.release();
  }
  // After the completing transaction has committed: a send can never undo or fail the job.
  if (completed && job) await sendExportReadyMail(job);
  return 1;
}

/**
 * Owner answer 102: one email to the member who started the export, saying
 * it is ready, linking only to the household's page (where the archive card
 * is). No address, no download link, nothing about the contents. No address
 * on file, no email; a failed send is logged and forgotten.
 */
async function sendExportReadyMail(job: ClaimedPortableArchiveExport): Promise<void> {
  try {
    const [user] = await getDb().select({ emailEnc: users.emailEnc }).from(users).where(eq(users.id, job.requestedByUserId)).limit(1);
    if (!user?.emailEnc) return;
    const cipher = await openInstanceMetadataReader();
    if (cipher.locked) return;
    const address = cipher.text("users.email", job.requestedByUserId, { encrypted: user.emailEnc }).value;
    if (!address) return;
    const link = absoluteAppLink("household", job.householdId, "Orbit's address is not set");
    const outcome = await sendBoundedMail(address, {
      subject: "Your Orbit export is ready",
      text: [
        "The household export you started is written and ready to download.",
        "",
        `Open the household in Orbit to download it from the archive card: ${link}`,
        "",
        "It is kept for a limited time, so download it soon.",
      ].join("\n"),
      what: "an export-ready notice",
    });
    if (outcome.sendError) {
      log.warn({ event: "document.job", state: "degraded", reason: outcome.sendError === "unknown" ? "unexpected_failure" : outcome.sendError, action: "check_provider", impact: "mail_delivery_delayed" });
    }
  } catch (error) {
    log.warn({ event: "document.job", state: "degraded", reason: "unexpected_failure", action: "none", impact: "mail_delivery_delayed", detail: operationalDetail`export-ready mail not sent (${error instanceof Error ? error.name : "unknown"})` });
  }
}

/**
 * Every `processing` row this process is not writing is dead (Orbit is one
 * process): back to `retry`, due now, from nothing; the third interruption
 * running ends it as failed, its key kept for a retry.
 */
export async function requeueInterruptedExports(): Promise<void> {
  const writing = [...inFlight()];
  await getDb().execute(sql`
    update portable_archive_exports
    set status = case when attempts >= ${EXPORT_MAX_ATTEMPTS} then 'failed'::document_job_status else 'retry'::document_job_status end,
        next_attempt_at = case when attempts >= ${EXPORT_MAX_ATTEMPTS} then next_attempt_at else now() end,
        failure_code = case when attempts >= ${EXPORT_MAX_ATTEMPTS} then 'archive_export_interrupted' end,
        failure_message = case when attempts >= ${EXPORT_MAX_ATTEMPTS} then ${INTERRUPTED_MESSAGE} end,
        last_error = 'archive_export_interrupted',
        bytes_done = 0, locked_at = null, lease_expires_at = null, lease_token = null,
        updated_at = now()
    where status = 'processing'
      ${writing.length > 0 ? sql`and id not in (${sql.join(writing.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
  `);
}

/**
 * The boot requeue, once per process: one shared promise, which the export
 * loop awaits before its first claim and the document cycle awaits first. So
 * the requeue has finished before any claim of this process commits, and can
 * never flip a fresh claim back to `retry`. A requeue that failed is tried
 * again by the next caller.
 */
export function requeueInterruptedExportsAtBoot(): Promise<void> {
  exportWorkerState.__orbitExportsBootRequeue ??= requeueInterruptedExports().catch((error: unknown) => {
    exportWorkerState.__orbitExportsBootRequeue = undefined;
    throw error;
  });
  return exportWorkerState.__orbitExportsBootRequeue;
}

/**
 * A failed job's key goes an hour after the failure (its last write); after
 * that the card offers "write it again". A finished job's row goes after a
 * day; the archive itself has its own retention. Neither touches a live job.
 */
export async function sweepPortableArchiveExports(): Promise<void> {
  await getDb().execute(sql`
    update portable_archive_exports
    set salt = null, key_wrapped = null, key_id = null
    where status = 'failed' and key_wrapped is not null and updated_at <= now() - ${EXPORT_KEY_RETENTION}
  `);
  await getDb().execute(sql`
    delete from portable_archive_exports
    where status in ('completed', 'failed', 'cancelled') and updated_at <= now() - interval '24 hours'
  `);
}

/** Wakes the export loop in this process, if it is sleeping; a no-op where none was started. */
export function notifyExportWorker(): void {
  exportWorkerState.__orbitExportWorkerWake?.();
}

/** Starts one export loop per process, beside the preview loop. */
export function startExportWorker(idleMilliseconds = EXPORT_IDLE_MS): void {
  if (exportWorkerState.__orbitExportWorkerStarted) return;
  exportWorkerState.__orbitExportWorkerStarted = true;
  const loop = async () => {
    for (;;) {
      let taken = 0;
      try {
        await requeueInterruptedExportsAtBoot();
        taken = await runExportWorkerOnce();
      } catch {
        // The cause may carry paths or provider text; the bounded record is enough.
        log.error({ event: "document.worker", state: "retrying", reason: "worker_cycle_failed", action: "inspect_admin_diagnostics", impact: "worker_degraded" });
      }
      if (taken > 0) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, idleMilliseconds);
        timer.unref();
        function done() {
          clearTimeout(timer);
          exportWorkerState.__orbitExportWorkerWake = undefined;
          resolve();
        }
        exportWorkerState.__orbitExportWorkerWake = done;
      });
    }
  };
  void loop();
}
