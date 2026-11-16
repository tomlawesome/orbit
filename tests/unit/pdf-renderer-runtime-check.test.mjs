import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NEEDS_POPPLER, popplerIt } from "../support/poppler-sandbox";

/*
 * #1436, design note D10 and §1.5 line 21: scripts/pdf-renderer-runtime-check.mjs
 * (replacing web-pdfjs-runtime-check.mjs) proves in the runner stage that
 * pdfinfo and pdftoppm run through the server's wrapper. It must fail where
 * pdftoppm is missing; it passes where poppler is installed (and in the built
 * image, through CI's existing image gate).
 */

const root = path.resolve(import.meta.dirname, "../..");
const script = path.join(root, "scripts/pdf-renderer-runtime-check.mjs");

const run = (env) => spawnSync(process.execPath, [script], { cwd: root, env, encoding: "utf8", timeout: 60_000 });

describe("the PDF renderer runtime check (§1.5 line 21)", () => {
  it("exists at scripts/pdf-renderer-runtime-check.mjs", () => {
    expect(existsSync(script)).toBe(true);
  });

  it("line 21: fails on an image without pdftoppm (PATH emptied)", () => {
    // Without the script, node's own missing-file exit would pass this; the existence check pairs it.
    expect(existsSync(script)).toBe(true);
    const result = run({ PATH: "" });
    expect(result.status).not.toBe(0);
  }, 60_000);

  popplerIt(`line 21: passes where poppler is installed ${NEEDS_POPPLER}`, () => {
    const result = run({ PATH: process.env.PATH ?? "" });
    expect(result.status, result.stderr).toBe(0);
  }, 60_000);
});
