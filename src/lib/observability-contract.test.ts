import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const boundedRuntimeSources = [
  "../app/api/auth/callback/route.ts",
  "../db/index.ts",
  "../db/migrate.ts",
  "../lib/app-error.ts",
  "../server/notification-worker.ts",
  "../server/document-worker.ts",
  "../server/mail-in/imap-ingestion.ts",
  "../server/mail-in/imap-receipt-worker.ts",
];

describe("bounded runtime observability contract", () => {
  it("does not reintroduce raw console exception paths", () => {
    for (const relativePath of boundedRuntimeSources) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source, relativePath).not.toMatch(/console\.(error|warn|log)\s*\(/u);
    }
  });
});
