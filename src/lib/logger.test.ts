import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatJsonRecord,
  formatRecord,
  getLogFormat,
  getLogLevel,
  log,
  resetLoggerForTests,
  setLoggerClockForTests,
  shouldUseColor,
} from "./logger";

afterEach(() => {
  resetLoggerForTests();
  vi.restoreAllMocks();
  delete process.env.ORBIT_LOG_LEVEL;
  delete process.env.ORBIT_LOG_FORMAT;
  delete process.env.NO_COLOR;
});

const environment = (level?: string, format?: string): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  ...(level === undefined ? {} : { ORBIT_LOG_LEVEL: level }),
  ...(format === undefined ? {} : { ORBIT_LOG_FORMAT: format }),
});

const event = {
  event: "document.scan" as const,
  state: "degraded" as const,
  reason: "scanner_timeout" as const,
  action: "check_scanner" as const,
  impact: "document_upload_blocked" as const,
  durationMs: 12,
};

describe("log configuration", () => {
  it("keeps the existing level contract and defaults safely", () => {
    expect(getLogLevel(environment())).toBe("info");
    expect(getLogLevel(environment("debug"))).toBe("debug");
    expect(getLogLevel(environment("verbose"))).toBe("info");
  });

  it("supports the documented machine format without changing level semantics", () => {
    expect(getLogFormat(environment())).toBe("text");
    expect(getLogFormat(environment(undefined, "json"))).toBe("json");
    expect(getLogFormat(environment(undefined, "yaml"))).toBe("text");
    expect(getLogLevel(environment("debug", "yaml"))).toBe("debug");
  });

  it("suppresses records below the configured level and deduplicates transitions", () => {
    process.env.ORBIT_LOG_LEVEL = "warn";
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.info(event);
    log.warn({ ...event, state: "retrying", reason: "retry_scheduled", action: "retry" });
    log.warn({ ...event, state: "retrying", reason: "retry_scheduled", action: "retry" });
    expect(output).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  it("re-emits a persistent transition after the bounded cooldown", () => {
    process.env.ORBIT_LOG_LEVEL = "warn";
    let now = 0;
    setLoggerClockForTests(() => now);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const retrying = { ...event, state: "retrying" as const, reason: "retry_scheduled" as const, action: "retry" as const };

    log.warn(retrying);
    log.warn(retrying);
    expect(warnings).toHaveBeenCalledTimes(1);

    now = 60_000;
    log.warn(retrying);
    expect(warnings).toHaveBeenCalledTimes(2);
  });
});

describe("record formatting", () => {
  it("renders a bounded one-line text record with stable fields", () => {
    process.env.ORBIT_LOG_FORMAT = "text";
    const record = formatRecord("info", event, "2026-01-01T00:00:00.000Z");
    expect(record).toContain("INFO orbit scanner document.scan");
    expect(record).toContain("state=degraded");
    expect(record).toContain("reason=scanner_timeout");
    expect(record).toContain("action=check_scanner");
    expect(record).toContain("impact=document_upload_blocked");
    expect(record).toContain("duration_ms=12");
    expect(record.split("\n")).toHaveLength(1);
  });

  it("renders JSON with the same semantic record as text", () => {
    process.env.ORBIT_LOG_FORMAT = "json";
    const json = JSON.parse(formatJsonRecord("warn", event, "2026-01-01T00:00:00.000Z")) as Record<string, unknown>;
    expect(json).toEqual({
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "warn",
      component: "scanner",
      event: "document.scan",
      state: "degraded",
      reason: "scanner_timeout",
      action: "check_scanner",
      impact: "document_upload_blocked",
      duration_ms: 12,
      setting: null,
      problem_code: null,
      fallback: null,
    });
  });

  it("rejects malformed event values without copying hostile input", () => {
    const malformed = {
      event: "document.scan\nforged",
      state: "not-a-state",
      reason: "private\rvalue",
      action: "private\tvalue",
      impact: "private value",
    } as unknown as typeof event;
    const record = formatRecord("error", malformed, "2026-01-01T00:00:00.000Z");
    expect(record).not.toContain("forged");
    expect(record).not.toContain("private");
    expect(record).not.toContain("\r");
    expect(record).not.toContain("\t");
    expect(record.split("\n")).toHaveLength(1);
  });

  it("uses colour only for a real TTY and never when NO_COLOR is set", () => {
    const tty = { isTTY: true } as NodeJS.WriteStream;
    const redirected = { isTTY: false } as NodeJS.WriteStream;
    expect(shouldUseColor({ NODE_ENV: "test" }, tty)).toBe(true);
    expect(shouldUseColor({ NODE_ENV: "test", NO_COLOR: "" }, tty)).toBe(false);
    expect(shouldUseColor({ NODE_ENV: "test" }, redirected)).toBe(false);
  });
});
