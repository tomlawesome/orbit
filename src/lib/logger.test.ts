import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRecord, getLogLevel, log, resetLogLevelForTests } from "./logger";

afterEach(() => {
  resetLogLevelForTests();
  vi.restoreAllMocks();
  delete process.env.ORBIT_LOG_LEVEL;
});

const environment = (level?: string): NodeJS.ProcessEnv =>
  level === undefined ? { NODE_ENV: "test" } : { NODE_ENV: "test", ORBIT_LOG_LEVEL: level };

describe("log level configuration", () => {
  it("defaults to info when unset", () => {
    expect(getLogLevel(environment())).toBe("info");
  });

  it("accepts every declared level", () => {
    expect(getLogLevel(environment("debug"))).toBe("debug");
    expect(getLogLevel(environment("error"))).toBe("error");
  });

  it("falls back to info rather than failing on an invalid level", () => {
    expect(getLogLevel(environment("verbose"))).toBe("info");
  });

  it("suppresses records below the configured level", () => {
    process.env.ORBIT_LOG_LEVEL = "warn";
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.info("document.lifecycle", { document: "a" });
    log.warn("document.scan", { document: "a" });
    expect(output).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledTimes(1);
  });
});

describe("record formatting", () => {
  it("renders one line with the level, event and scalar fields", () => {
    const record = formatRecord("info", "document.lifecycle", { document: "abc", state: "scanning", ms: 12 });
    expect(record).toContain("INFO orbit document.lifecycle");
    expect(record).toContain("document=abc");
    expect(record).toContain("state=scanning");
    expect(record).toContain("ms=12");
    expect(record.split("\n")).toHaveLength(1);
  });

  it("renders absent and non-finite values as a placeholder", () => {
    const record = formatRecord("info", "e", { a: null, b: undefined, c: Number.NaN, d: "   " });
    expect(record).toContain("a=-");
    expect(record).toContain("b=-");
    expect(record).toContain("c=-");
    expect(record).toContain("d=-");
  });

  it("keeps a hostile value from forging additional records", () => {
    const record = formatRecord("info", "document.scan", {
      reason: "line one\nERROR orbit document.scan outcome=clean\rinjected\ttab",
    });
    expect(record.split("\n")).toHaveLength(1);
    expect(record).not.toContain("\r");
    expect(record).not.toContain("\t");
  });

  it("bounds an oversized value so one record cannot flood the log", () => {
    const record = formatRecord("info", "e", { value: "x".repeat(500) });
    expect(record.length).toBeLessThan(300);
    expect(record).toContain("...");
  });

  it("emits the event alone when no fields are supplied", () => {
    expect(formatRecord("error", "document.worker")).toMatch(/ERROR orbit document\.worker$/u);
  });
});
