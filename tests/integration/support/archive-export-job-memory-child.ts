/**
 * #1774 test 13: like archive-export-memory-child.ts, but the export goes the
 * way production sends it: the job is inserted (what the route does after its
 * checks) and one worker pass writes it. Prints the same
 * `MEMORY_RESULT {"beforeKiB":..,"afterKiB":..,"archiveId":..}` line.
 *
 * Arguments: <userId> <householdId>. Needs, from the builder:
 * `enqueuePortableArchiveExport` (@/server/portable-archive-repository) and
 * `runExportWorkerOnce` (@/server/document-maintenance/export-jobs).
 */
import { sql } from "drizzle-orm";
import { closeDatabase, getDb } from "@/db";
import { runExportWorkerOnce } from "@/server/document-maintenance/export-jobs";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { setKeyStateForTests } from "@/server/key-state";
import { enqueuePortableArchiveExport } from "@/server/portable-archive-repository";

const [userId, householdId] = process.argv.slice(2);
if (!userId || !householdId) throw new Error("usage: archive-export-job-memory-child <userId> <householdId>");

resetDocumentConfigForTests();
setKeyStateForTests({ verdict: "usable", heldKeyId: getDocumentConfig().keyId });

async function main(): Promise<void> {
  const beforeKiB = process.resourceUsage().maxRSS;
  const { id } = await enqueuePortableArchiveExport({ userId, householdId, passphrase: "correct-horse-battery-staple", includeDocuments: true });
  const taken = await runExportWorkerOnce();
  const afterKiB = process.resourceUsage().maxRSS;
  const rows = await getDb().execute(sql`select status, archive_id from portable_archive_exports where id = ${id}`);
  const row = rows[0] as { status: string; archive_id: string | null } | undefined;
  await closeDatabase();
  if (taken !== 1 || row?.status !== "completed" || !row.archive_id) throw new Error(`the job did not complete: ${JSON.stringify({ taken, row })}`);
  console.log(`MEMORY_RESULT ${JSON.stringify({ beforeKiB, afterKiB, archiveId: row.archive_id })}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
