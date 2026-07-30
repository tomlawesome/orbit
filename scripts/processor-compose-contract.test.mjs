import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const tikaConfig = readFileSync(new URL("../config/tika-config.xml", import.meta.url), "utf8");
const tikaAdapter = readFileSync(new URL("../src/server/documents/tika.ts", import.meta.url), "utf8");
const exactProcessorTest = readFileSync(new URL("./test-tika-processor.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/publish-container.yml", import.meta.url), "utf8");

describe("hostile document processor contract", () => {
  it("keeps Tika non-root, read-only, capability-free and isolated", () => {
    const tika = compose.slice(compose.indexOf("  orbit-tika:"), compose.indexOf("\nnetworks:"));
    expect(tika).toContain('user: "35002:35002"');
    expect(tika).toContain("read_only: true");
    expect(tika).toContain("TIKA_CONFIG: /etc/orbit/tika-config.xml");
    expect(tika).toContain('command: ["-c", "/etc/orbit/tika-config.xml"]');
    expect(tika).toContain("cap_drop:\n      - ALL");
    expect(tika).toContain("uid=35002,gid=35002,mode=0700,size=256m");
    expect(tika).toContain("networks:\n      - orbit-document-processing");
    expect(tika).not.toMatch(/\n\s+(?:volumes|secrets|ports):/u);
    expect(compose).toContain("orbit-document-processing:\n    internal: true");
  });

  it("disables OCR and embedded recursion without caller-controlled options", () => {
    expect(tikaConfig).toContain("org.apache.tika.parser.ocr.TesseractOCRParser");
    expect(tikaAdapter).toContain('"X-Tika-OCRskipOcr": "true"');
    expect(tikaAdapter).toContain('"X-Tika-Skip-Embedded": "true"');
    expect(tikaAdapter).toContain('new URL("/tika/text", config.tika.url)');
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
