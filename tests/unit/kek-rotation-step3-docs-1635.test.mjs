import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1635: step 3 of "Rotating the document key-encryption key" runs the
 * rewrap worker as a cli/orbit.js subcommand inside the app container, and
 * the guide no longer says an installed Orbit cannot do it.
 */

const read = (rel) => readFileSync(resolve(__dirname, "../../", rel), "utf8");
const flat = (text) => text.replace(/\\\n/g, " ").replace(/\s+/g, " ");

const guide = read("docs/administrator-operations.md");
const start = guide.indexOf("## Rotating the document key-encryption key");
const section = guide.slice(start, guide.indexOf("\n## ", start + 10));
const overlay = read("docker-compose.kek-rotation.yml");

const NEXT_KEY_PATH = "/run/orbit-secrets/orbit-document-kek-next";

describe("rotation guide, step 3 (#1635)", () => {
  it("finds the section", () => {
    expect(start).toBeGreaterThan(0);
    expect(section.length).toBeGreaterThan(500);
  });

  it("gives the docker compose exec command, with both compose files, the CLI path, rewrap-kek and the next key path", () => {
    const commands = [...section.matchAll(/```(?:sh|bash)?\n([\s\S]*?)```/g)].map((match) => flat(match[1]));
    const step3 = commands.find((command) => command.includes("rewrap-kek"));
    expect(step3, "a code block running rewrap-kek").toBeDefined();
    expect(step3).toContain("docker compose");
    expect(step3).toContain("-f docker-compose.yml");
    expect(step3).toContain("-f docker-compose.kek-rotation.yml");
    expect(step3).toContain("exec orbit-app node /opt/orbit/cli/orbit.js rewrap-kek");
    expect(step3).toContain(`--next-key-file ${NEXT_KEY_PATH}`);
    expect(step3).not.toMatch(/\bpnpm\b/);
    expect(step3).not.toMatch(/exec -T|exec .*-T /);
  });

  it("the overlay mounts the next key at the path the command names", () => {
    expect(overlay).toContain(`DOCUMENT_KEK_NEXT_FILE: ${NEXT_KEY_PATH}`);
    expect(overlay).toMatch(/secrets:\s*\n\s*- orbit-document-kek-next/);
    expect(overlay).toMatch(/orbit-document-kek-next:\s*\n\s*file: \.\/\.orbit-secrets\/document-kek-next/);
    expect(NEXT_KEY_PATH.endsWith("/orbit-document-kek-next")).toBe(true);
  });

  it("no longer says an installed Orbit has no command or cannot reach step 4", () => {
    const text = flat(section);
    expect(text).not.toContain("Do not start a rotation on an installed Orbit yet");
    expect(text).not.toMatch(/installed Orbit has no command/i);
    expect(text).not.toMatch(/installed Orbit cannot (reach|run)/i);
    expect(text).not.toContain("issue #1635");
    expect(text).not.toMatch(/do not carry on to step 4/i);
  });

  it("the overlay comment names the new command, not pnpm rewrap-kek", () => {
    expect(overlay).not.toContain("pnpm rewrap-kek");
    expect(flat(overlay)).toContain("rewrap-kek");
  });
});
