/**
 * Runs ONE portable-archive export in a process of its own and prints how far
 * that export raised the process's peak resident memory (#1506). Spawned by
 * tests/integration/portable-archive-stream.test.ts through tsx, so the test
 * runner's own memory (and the seeding of the documents) never counts.
 *
 * Arguments: <userId> <householdId>. Everything else (database, document
 * roots, document key) comes from the environment the parent passes on.
 * Prints one line: `MEMORY_RESULT {"beforeKiB":..,"afterKiB":..,"archiveId":..}`.
 */
import { closeDatabase } from "@/db";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { setKeyStateForTests } from "@/server/key-state";
import { createPortableArchive } from "@/server/portable-archive-repository";

const [userId, householdId] = process.argv.slice(2);
if (!userId || !householdId) throw new Error("usage: archive-export-memory-child <userId> <householdId>");

resetDocumentConfigForTests();
// The integration suite never boots the server, so the startup key check has
// not run; same baseline the fixtures set.
setKeyStateForTests({ verdict: "usable", heldKeyId: getDocumentConfig().keyId });

async function main(): Promise<void> {
  // Peak RSS so far (KiB): modules loaded, nothing exported yet.
  const beforeKiB = process.resourceUsage().maxRSS;
  const archive = await createPortableArchive({
    userId,
    householdId,
    passphrase: "correct-horse-battery-staple",
    includeDocuments: true,
  });
  const afterKiB = process.resourceUsage().maxRSS;
  await closeDatabase();
  console.log(`MEMORY_RESULT ${JSON.stringify({ beforeKiB, afterKiB, archiveId: archive.id })}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
