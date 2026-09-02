import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatJsonRecord,
  formatRecord,
  getLogFormat,
  getLogLevel,
  log,
  operationalDetail,
  resetLoggerForTests,
  setLoggerClockForTests,
  shouldUseColor,
  type OperationalEvent,
  type OperationalRecord,
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

  it("does not repeat steady health or worker ready records", () => {
    process.env.ORBIT_LOG_LEVEL = "info";
    let now = 0;
    setLoggerClockForTests(() => now);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const healthReady = { event: "application.startup" as const, state: "ready" as const, action: "none" as const };
    const workerReady = { event: "notification.worker" as const, state: "ready" as const, action: "none" as const };

    log.info(healthReady);
    log.info(healthReady);
    log.info(workerReady);
    log.info(workerReady);
    now = 120_000;
    log.info(healthReady);
    log.info(workerReady);

    expect(output).toHaveBeenCalledTimes(2);
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

  it("deduplicates a persistent failure across levels and re-emits after cooldown", () => {
    process.env.ORBIT_LOG_LEVEL = "debug";
    let now = 0;
    setLoggerClockForTests(() => now);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const failure = { ...event, state: "retrying" as const, reason: "retry_scheduled" as const, action: "retry" as const };

    log.warn(failure);
    log.info(failure);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(output).not.toHaveBeenCalled();

    now = 60_000;
    log.info(failure);
    expect(output).toHaveBeenCalledTimes(1);
  });

  it("marks a fast unhealthy-to-healthy transition as recovered", () => {
    process.env.ORBIT_LOG_LEVEL = "info";
    let now = 0;
    setLoggerClockForTests(() => now);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    log.warn({
      event: "application.startup",
      state: "degraded",
      reason: "dependency_unavailable",
      action: "check_database",
      impact: "database_unavailable",
    });
    now = 1;
    log.info({ event: "application.startup", state: "ready", action: "none" });
    log.info({ event: "application.startup", state: "ready", action: "none" });

    expect(warnings).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0][0]).toContain("state=recovered");
  });

  it("keeps initial startup readiness as ready rather than recovered", () => {
    process.env.ORBIT_LOG_LEVEL = "info";
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    log.info({ event: "application.startup", state: "starting", action: "none" });
    log.info({ event: "application.startup", state: "ready", action: "none" });

    expect(output).toHaveBeenCalledTimes(2);
    expect(output.mock.calls[1][0]).toContain("state=ready");
    expect(output.mock.calls[1][0]).not.toContain("state=recovered");
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
      detail: null,
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

  /* Every field the event type defines, with what it must look like once
     rendered. Written as a total map of `OperationalEvent`, so a field added
     to the type without renderer support fails to compile here rather than
     disappearing quietly between the call site and the log (#718). */
  const fieldContract: {
    [K in keyof Required<OperationalEvent>]: {
      value: Required<OperationalEvent>[K];
      textFragment: string;
      recordKey: keyof OperationalRecord;
      recordValue: unknown;
    };
  } = {
    event: { value: "startup.migration", textFragment: "startup.migration", recordKey: "event", recordValue: "startup.migration" },
    state: { value: "exhausted", textFragment: "state=exhausted", recordKey: "state", recordValue: "exhausted" },
    reason: { value: "database_mismatch", textFragment: "reason=database_mismatch", recordKey: "reason", recordValue: "database_mismatch" },
    action: { value: "attach_matching_database", textFragment: "action=attach_matching_database", recordKey: "action", recordValue: "attach_matching_database" },
    impact: { value: "migration_blocked", textFragment: "impact=migration_blocked", recordKey: "impact", recordValue: "migration_blocked" },
    durationMs: { value: 12, textFragment: "duration_ms=12", recordKey: "duration_ms", recordValue: 12 },
    setting: { value: "database", textFragment: "setting=database", recordKey: "setting", recordValue: "database" },
    problemCode: { value: "configuration_core", textFragment: "problem_code=configuration_core", recordKey: "problem_code", recordValue: "configuration_core" },
    fallback: { value: "startup_blocked", textFragment: "fallback=startup_blocked", recordKey: "fallback", recordValue: "startup_blocked" },
    detail: {
      value: operationalDetail`applied ${17} of ${18} does not match ${"0018_x"}`,
      textFragment: 'detail="applied 17 of 18 does not match 0018_x"',
      recordKey: "detail",
      recordValue: "applied 17 of 18 does not match 0018_x",
    },
  };

  it("surfaces every field of an operational event in both renderings (#718)", () => {
    const event = Object.fromEntries(
      Object.entries(fieldContract).map(([key, field]) => [key, field.value]),
    ) as unknown as OperationalEvent;

    process.env.ORBIT_LOG_FORMAT = "text";
    const text = formatRecord("error", event, "2026-01-01T00:00:00.000Z");
    const json = JSON.parse(formatJsonRecord("error", event, "2026-01-01T00:00:00.000Z")) as Record<string, unknown>;

    for (const field of Object.values(fieldContract)) {
      expect(text).toContain(field.textFragment);
      expect(json[field.recordKey]).toEqual(field.recordValue);
    }
    expect(text.split("\n")).toHaveLength(1);
  });

  it("uses colour only for a real TTY and never when NO_COLOR is set", () => {
    const tty = { isTTY: true } as NodeJS.WriteStream;
    const redirected = { isTTY: false } as NodeJS.WriteStream;
    expect(shouldUseColor({ NODE_ENV: "test" }, tty)).toBe(true);
    expect(shouldUseColor({ NODE_ENV: "test", NO_COLOR: "" }, tty)).toBe(false);
    expect(shouldUseColor({ NODE_ENV: "test" }, redirected)).toBe(false);
  });

  it("keeps concurrent text and JSON emissions as complete fixed-schema lines", async () => {
    const expectedJsonKeys = ["timestamp", "level", "component", "event", "state", "reason", "action", "impact", "duration_ms", "setting", "problem_code", "fallback", "detail"];
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));

    for (const format of ["text", "json"] as const) {
      output.length = 0;
      resetLoggerForTests();
      process.env.ORBIT_LOG_LEVEL = "info";
      process.env.ORBIT_LOG_FORMAT = format;
      setLoggerClockForTests(() => 0);

      await Promise.all(Array.from({ length: 32 }, (_, index) => Promise.resolve().then(() => log.info({
        event: "document.scan",
        state: index % 2 === 0 ? "starting" : "ready",
        action: index % 2 === 0 ? "check_scanner" : "none",
      }))));

      expect(output).toHaveLength(32);
      for (const line of output) {
        expect(line.split("\n")).toHaveLength(1);
        if (format === "json") {
          expect(Object.keys(JSON.parse(line))).toEqual(expectedJsonKeys);
        } else {
          expect(line).toMatch(/^\S+ (?:ERROR|WARN|INFO|DEBUG) orbit \S+ \S+ state=\S+ reason=\S+ action=\S+ impact=\S+ duration_ms=\S+ setting=\S+ problem_code=\S+ fallback=\S+ detail=\S+$/u);
        }
      }
    }
  });
});

describe("bounded detail (#718)", () => {
  const mismatch = {
    event: "startup.migration" as const,
    state: "exhausted" as const,
    reason: "database_mismatch" as const,
    action: "attach_matching_database" as const,
    impact: "migration_blocked" as const,
  };

  it("carries a detail from a real log.error into the emitted text and JSON lines", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const detail = operationalDetail`applied migration ${25} of ${25} does not match ${"0026_x"}`;

    process.env.ORBIT_LOG_FORMAT = "text";
    log.error({ ...mismatch, detail });
    resetLoggerForTests();
    process.env.ORBIT_LOG_FORMAT = "json";
    log.error({ ...mismatch, detail });

    expect(errors).toHaveBeenCalledTimes(2);
    const [textLine, jsonLine] = errors.mock.calls.map((call) => String(call[0]));
    expect(textLine).toContain('detail="applied migration 25 of 25 does not match 0026_x"');
    expect(textLine.split("\n")).toHaveLength(1);
    expect(JSON.parse(jsonLine)).toMatchObject({ detail: "applied migration 25 of 25 does not match 0026_x" });
  });

  it("keeps interpolations to numbers and bounded tokens, redacting anything else", () => {
    expect(operationalDetail`applied ${17} of ${18}`).toBe("applied 17 of 18");
    expect(operationalDetail`floor is ${"0017_imap_recipient_alias_index"}`).toBe("floor is 0017_imap_recipient_alias_index");
    expect(operationalDetail`rejected ${"connection string with spaces"}`).toBe("rejected [unavailable]");
    expect(operationalDetail`rejected ${{ nested: true }}`).toBe("rejected [unavailable]");
    expect(operationalDetail`counted ${Number.NaN}`).toBe("counted [unavailable]");
    expect(operationalDetail`tag ${"a".repeat(65)}`).toBe("tag [unavailable]");
  });

  it("stays one bounded printable line whatever the literal contains", () => {
    expect(operationalDetail`first line\nsecond ${"line"}`).toBe("first line second line");
    expect(operationalDetail`bidi \u202e override ${"tag"}`).toBe("bidi override tag");
    expect(operationalDetail`${"x".repeat(64)} ${"y".repeat(64)} ${"z".repeat(64)} ${"w".repeat(64)} tail`).toHaveLength(256);
  });

  it("renders an absent detail as the same empty column as every other field", () => {
    process.env.ORBIT_LOG_FORMAT = "text";
    expect(formatRecord("error", mismatch, "2026-01-01T00:00:00.000Z")).toContain("detail=-");
    expect(JSON.parse(formatJsonRecord("error", mismatch, "2026-01-01T00:00:00.000Z"))).toMatchObject({ detail: null });
  });
});

describe("closed schema enforcement (#718)", () => {
  const rogue = {
    event: "startup.migration",
    state: "exhausted",
    /* The shape that used to compile through a spread and then vanish. */
    message: "free text nobody bounded",
  } as unknown as OperationalEvent;

  it("refuses a field outside the schema at compile time, spread or not", () => {
    const verdict = { reason: "database_mismatch", action: "attach_matching_database" } as const;
    /* The @ts-expect-error is the assertion: if this ever compiles, the hole
       that let #437's detail vanish is open again (#718). */
    // @ts-expect-error - `note` is not a field of OperationalEvent.
    expect(() => log.error({ event: "startup.migration", state: "exhausted", ...verdict, note: "free text" })).toThrow();
  });

  it("throws outside production when an event carries a field outside the schema", () => {
    expect(() => formatRecord("error", rogue, "2026-01-01T00:00:00.000Z")).toThrow(/outside its schema: message/u);
  });

  it("strips the unknown field instead of throwing in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      process.env.ORBIT_LOG_FORMAT = "json";
      const json = JSON.parse(formatJsonRecord("error", rogue, "2026-01-01T00:00:00.000Z")) as Record<string, unknown>;
      expect(json).not.toHaveProperty("message");
      expect(JSON.stringify(json)).not.toContain("free text");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
