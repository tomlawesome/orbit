import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1436, design note §1.5 line 18 and D4: no PDF parser runs in the server
 * process at all. pdf.js is gone: nothing under src/server names pdfjs-dist,
 * not even in a type-only import, and neither package.json lists it. Only the
 * sandbox file (src/server/documents/pdf-structure-sandbox.ts) names the
 * poppler tools it spawns, pdftoppm and pdfinfo. The @napi-rs/canvas rule
 * stays in pdf-no-in-process-reader.test.mjs. Source tripwire; failures list
 * file:line.
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

const allServerSources = sourceFiles(serverDir).filter((file) => !isTest(file));

/** Every place `pattern` matches outside comments in `files`, as file:line. */
function namingsOf(pattern, files) {
  const violations = [];
  for (const file of files) {
    const text = withoutComments(readFileSync(file, "utf8"));
    for (const match of text.matchAll(new RegExp(pattern, "g"))) {
      violations.push(`${path.relative(root, file)}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
  return violations;
}

describe("no PDF parser in the server process (#1436)", () => {
  it("scans the sandbox and the preview code (so the checks below are not vacuous)", () => {
    const relative = allServerSources.map((file) => path.relative(root, file));
    expect(relative).toContain("src/server/documents/pdf-structure-sandbox.ts");
    expect(relative).toContain("src/server/documents/preview.ts");
  });

  it("§1.5 line 18: nothing under src/server names pdfjs-dist, the sandbox and type-only imports included", () => {
    const violations = namingsOf("pdfjs-dist", allServerSources);
    expect(violations, `names pdf.js:\n${violations.join("\n")}`).toEqual([]);
  });

  it("§1.5 line 18: the sandbox file names both poppler tools it spawns (so the rule below has something to find)", () => {
    expect(namingsOf("\\bpdftoppm\\b", [sandboxFile]).length).toBeGreaterThan(0);
    expect(namingsOf("\\bpdfinfo\\b", [sandboxFile]).length).toBeGreaterThan(0);
  });

  it("§1.5 line 18: nothing under src/server but the sandbox file names pdftoppm or pdfinfo", () => {
    const others = allServerSources.filter((file) => file !== sandboxFile);
    const violations = namingsOf("\\b(pdftoppm|pdfinfo)\\b", others);
    expect(violations, `names a poppler tool outside the sandbox:\n${violations.join("\n")}`).toEqual([]);
  });

  it.each(["package.json", "web/package.json"])("D4: %s no longer depends on pdfjs-dist", (file) => {
    const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8"));
    const named = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
      .filter((field) => manifest[field] && "pdfjs-dist" in manifest[field]);
    expect(named).toEqual([]);
  });
});
