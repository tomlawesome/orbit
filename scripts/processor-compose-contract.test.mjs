import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const tikaConfig = readFileSync(new URL("../config/tika-config.json", import.meta.url), "utf8");
const tikaAdapter = readFileSync(new URL("../src/server/documents/tika.ts", import.meta.url), "utf8");
const exactProcessorTest = readFileSync(new URL("./test-tika-processor.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/publish-container.yml", import.meta.url), "utf8");

/**
 * Extracts one service block.
 *
 * Slicing to the next top-level key would swallow every service declared after
 * the target, so a sibling's `volumes:` could fail an isolation assertion that
 * is about this service alone. The block ends at the next sibling service.
 */
function serviceBlock(name) {
  const start = compose.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`Service ${name} is not declared`);
  const rest = compose.slice(start + 1);
  const nextSibling = rest.search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/u);
  return nextSibling < 0 ? rest : rest.slice(0, nextSibling);
}

describe("service block extraction", () => {
  it("stops at the next sibling service", () => {
    // Proves the isolation assertions below are about Tika alone. orbit-ollama
    // declares volumes; if the block leaked into it, that assertion would fail
    // for the wrong reason and could later be relaxed to compensate.
    const tika = serviceBlock("orbit-tika");
    expect(tika).toContain("orbit-tika");
    expect(tika).not.toContain("orbit-ollama");
    expect(tika).not.toContain("orbit-clamav");
  });

  it("still sees a violation inside the target service", () => {
    // Guards against the extraction being narrowed until assertions pass
    // vacuously: a service that genuinely declares volumes must show them.
    expect(serviceBlock("orbit-ollama")).toMatch(/\n\s+volumes:/u);
    expect(serviceBlock("orbit-app")).toMatch(/\n\s+secrets:/u);
  });

  it("refuses to silently return nothing for an absent service", () => {
    expect(() => serviceBlock("orbit-does-not-exist")).toThrow(/is not declared/u);
  });
});

describe("hostile document processor contract", () => {
  it("keeps Tika non-root, read-only, capability-free and isolated", () => {
    const tika = serviceBlock("orbit-tika");
    expect(tika).toContain('user: "35002:35002"');
    expect(tika).toContain("read_only: true");
    expect(tika).toContain("TIKA_CONFIG: /etc/orbit/tika-config.json");
    expect(tika).toContain('command: ["-c", "/etc/orbit/tika-config.json"]');
    expect(tika).toContain("cap_drop:\n      - ALL");
    expect(tika).toContain("uid=35002,gid=35002,mode=0700,size=256m");
    expect(tika).toContain("networks:\n      - orbit-document-processing");
    expect(tika).not.toMatch(/\n\s+(?:volumes|secrets|ports):/u);
    expect(compose).toContain("orbit-document-processing:\n    internal: true");
  });

  it("disables OCR and embedded recursion without caller-controlled options", () => {
    // Tika 4 takes JSON and ignores the X-Tika-* request headers Tika 3 honoured,
    // so both restrictions now live in the config file and are asserted from the
    // parsed document rather than from a substring. A wrong shape here parses,
    // loads nothing and reports no error, which is why the array form and the
    // registered component name are pinned rather than merely "mentions OCR".
    const parsed = JSON.parse(tikaConfig);
    expect(Array.isArray(parsed.parsers)).toBe(true);
    const defaultParser = parsed.parsers.find(
      (entry) => typeof entry === "object" && entry !== null && "default-parser" in entry,
    )?.["default-parser"];
    expect(defaultParser?.exclude).toContain("tesseract-ocr-parser");
    // Tika 4 refuses class names outright, so the 3.x spelling must not return.
    expect(tikaConfig).not.toContain("org.apache.tika.parser.ocr.TesseractOCRParser");
    expect(parsed["parse-context"]?.["embedded-limits"]).toMatchObject({ maxDepth: 0, maxCount: 0 });
    expect(tikaAdapter).toContain('new URL("/tika", config.tika.url)');
    expect(tikaAdapter).not.toContain("input.url");
    expect(tikaAdapter).not.toContain("input.headers");
  });

  it("retains protected exact-image runtime evidence for processor changes", () => {
    expect(workflow).toContain("Detect exact processor validation scope");
    expect(workflow).toContain("Verify exact hostile-document processor");
    expect(workflow).toContain("scripts/test-tika-processor.mjs");
    expect(workflow).toContain('test "${tika_uid}" = "35002"');
    expect(workflow).toContain('test "${tika_read_only}" = "true"');
    expect(exactProcessorTest).toContain("EMBEDDED-CONTENT-MUST-NOT-APPEAR");
    expect(exactProcessorTest).toContain("OCR BLOCKED");
  });
});
