/**
 * #1774 test 13: the export's memory bound holds on the JOB path (the
 * archive-export-job-memory-child: insert the job, one worker pass), not the
 * inline path: 12 x 10 MiB and 24 x 10 MiB grow the process by under 64 MiB
 * each and the two growths differ by under 16 MiB, as portable-archive-v2-memory
 * pins for the inline export. Written before the job path exists: fails today.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { portableArchives } from "@/db/schema";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";


const MIB = 1_048_576;
const DOCUMENT_BYTES = 10 * MIB;
type Measured = { beforeKiB: number; afterKiB: number; archiveId?: string };

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

function pdfOfSize(size: number, label: string): Buffer {
  let padding = Math.max(0, size - 800);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pdf = syntheticPdf(`${label} ${"x".repeat(padding)}`);
    if (pdf.length === size) return pdf;
    padding += size - pdf.length;
  }
  throw new Error(`no PDF of ${size} bytes`);
}

async function runChild(args: string[]): Promise<Measured> {
  const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const child = fileURLToPath(new URL("./support/archive-export-job-memory-child.ts", import.meta.url));
  const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(process.execPath, [tsx, child, ...args], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  expect(run.code, run.stderr).toBe(0);
  const line = run.stdout.split("\n").find((candidate) => candidate.startsWith("MEMORY_RESULT "));
  expect(line, `child output: ${run.stdout}\n${run.stderr}`).toBeDefined();
  return JSON.parse(line!.slice("MEMORY_RESULT ".length)) as Measured;
}

describe("#1774 test 13: the job's memory does not grow with the document count", () => {
  it("grows by under 64 MiB at 12 x 10 MiB and at 24 x 10 MiB, and the two growths differ by under 16 MiB", async () => {
    const growths: number[] = [];
    for (const count of [12, 24]) {
      const fixture = await createIntegrationFixture(`export-job-memory-${count}`);
      for (let index = 0; index < count; index += 1) await seedStoredDocuments(fixture, [pdfOfSize(DOCUMENT_BYTES, `job memory ${count} ${index}`)]);
      const measured = await runChild([fixture.users.owner.id, fixture.household.id]);
      const [row] = await getDb().select({ sizeBytes: portableArchives.sizeBytes }).from(portableArchives).where(eq(portableArchives.id, measured.archiveId!));
      expect(row.sizeBytes, "the archive holds every document").toBeGreaterThan(count * DOCUMENT_BYTES);
      const growth = (measured.afterKiB - measured.beforeKiB) / 1024;
      growths.push(growth);
      expect(growth, `job of ${count} documents grew ${growth.toFixed(1)} MiB`).toBeLessThan(64);
    }
    expect(Math.abs(growths[1] - growths[0]), `growths ${growths.map((g) => g.toFixed(1)).join(" and ")} MiB`).toBeLessThan(16);
  }, 1_200_000);
});
