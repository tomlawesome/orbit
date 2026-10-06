import { describe, expect, it } from "vitest";
import { parseEnvOrbitContent } from "./env-orbit-file";

// Mirrors scripts/configuration.test.mjs's coverage of the same rule,
// kept in sync because parseEnvOrbitContent is a line-for-line port of
// scripts/configuration.sh's validate_value (issue #383).
describe("parseEnvOrbitContent value validation (#383)", () => {
  it("accepts a non-leading quote, a backslash, or a `#` not preceded by whitespace", () => {
    for (const value of [
      "Xk7#pq2rLm",
      String.raw`a\b`,
      'abc"def',
      "abc'def",
      "https://a.example.invalid#fragment",
      String.raw`C:\Users\orbit`,
    ]) {
      const result = parseEnvOrbitContent(`APP_URL=https://a.example.invalid\nSMTP_PASSWORD=${value}\n`);
      expect(result).toMatchObject({ ok: true, record: { SMTP_PASSWORD: value } });
    }
  });

  it("still rejects a leading quote, `$`/backtick anywhere, and a `#` preceded by whitespace", () => {
    for (const content of [
      'SMTP_PASSWORD="quoted\n',
      "SMTP_PASSWORD='quoted\n",
      "SMTP_PASSWORD=abc$def\n",
      "SMTP_PASSWORD=abc`def\n",
      "SMTP_PASSWORD=abc #comment\n",
    ]) {
      expect(parseEnvOrbitContent(content)).toEqual({ ok: false, code: "configuration_syntax" });
    }
  });
});

// SQ1-Q1: configuration.sh's removed_keys list (scripts/configuration.sh)
// names keys this project used to accept and now refuses with a dedicated
// "removed" refusal (so an upgrading operator gets a clear message instead
// of a generic "unknown key") — this TS port must classify the same keys
// the same way.
describe("parseEnvOrbitContent removed-key classification (SQ1-Q1)", () => {
  it("classifies a retired IMAP_* key as configuration_removed_key, not configuration_unknown_key", () => {
    expect(parseEnvOrbitContent("IMAP_ENABLED=true\n")).toEqual({ ok: false, code: "configuration_removed_key" });
  });

  it("still classifies a key that was never valid as configuration_unknown_key", () => {
    expect(parseEnvOrbitContent("TOTALLY_MADE_UP_KEY=1\n")).toEqual({ ok: false, code: "configuration_unknown_key" });
  });
});
