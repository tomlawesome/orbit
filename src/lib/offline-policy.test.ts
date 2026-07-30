import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const serviceWorker = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const workspaceClient = readFileSync(new URL("./preview-workspace.ts", import.meta.url), "utf8");

describe("v1 browser storage policy", () => {
  it("keeps API and authentication responses outside the service-worker cache", () => {
    expect(serviceWorker).toContain('event.request.url.includes("/api/")');
    expect(serviceWorker).toContain('event.request.url.includes("/auth/")');
    expect(serviceWorker).not.toMatch(/SHELL\s*=\s*\[[^\]]*\/api\//s);
    expect(serviceWorker).not.toMatch(/SHELL\s*=\s*\[[^\]]*\/auth\//s);
  });

  it("does not retain or replay authenticated workspace data", () => {
    expect(workspaceClient).toContain("purgeLegacyWorkspaceCache");
    expect(workspaceClient).not.toContain("@/lib/workspace-cache");
    expect(workspaceClient).not.toContain('addEventListener("online"');
    expect(workspaceClient).not.toContain("enqueueWorkspaceCommand");
  });
});
