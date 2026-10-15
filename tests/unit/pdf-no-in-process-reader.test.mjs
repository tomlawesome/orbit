import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1427, #1316: the PDF reader (pdfjs-dist) runs only inside the sandbox worker
 * (src/server/documents/pdf-structure-sandbox.ts). Nothing else under
 * src/server may load it in the server process, for the structure check or for
 * drawing a page. Type-only imports are fine: they vanish at build time.
 * Source tripwire; failures list file:line.
 */

const root = path.resolve(import.meta.dirname, "../..");
const serverDir = path.join(root, "src/server");
const sandboxFile = path.join(serverDir, "documents/pdf-structure-sandbox.ts");

const isTest = (file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes(`${path.sep}__tests__${path.sep}`);

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.[cm]?[jt]s$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

/** Comments blanked out (newlines kept, so line numbers survive). */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

const scanned = sourceFiles(serverDir).filter((file) => file !== sandboxFile && !isTest(file));

describe("no in-process PDF reader", () => {
  it("scans the document preview code (so the check below is not vacuous)", () => {
    const relative = scanned.map((file) => path.relative(root, file));
    expect(relative).toContain("src/server/documents/preview.ts");
    expect(relative).toContain("src/server/documents/validation.ts");
  });

  it("nothing under src/server but the sandbox worker file names pdfjs-dist, except in a type-only import", () => {
    const violations = [];
    for (const file of scanned) {
      const text = withoutComments(readFileSync(file, "utf8"));
      for (const match of text.matchAll(/pdfjs-dist/g)) {
        const statementStart = Math.max(text.lastIndexOf(";", match.index), text.lastIndexOf("}\n", match.index)) + 1;
        const statement = text.slice(statementStart, match.index);
        if (/^\s*(import|export)\s+type\b/.test(statement)) continue;
        const line = text.slice(0, match.index).split("\n").length;
        violations.push(`${path.relative(root, file)}:${line}`);
      }
    }
    expect(violations, `loads or names the PDF reader outside the sandbox:\n${violations.join("\n")}`).toEqual([]);
  });
});
