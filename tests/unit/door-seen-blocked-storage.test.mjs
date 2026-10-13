import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isFirstVisit } from "../../web/src/lib/flight/door-seen.js";

/*
 * #1383 (sign-in survives blocked site storage). Where a browser blocks site
 * storage, reading the `localStorage` property itself throws a SecurityError.
 * The sign-in must treat that as a first visit and carry on, so the property
 * read has to happen inside the first-visit check's try/catch, not while the
 * argument is worked out before the call. Written from the issue alone.
 */

const root = path.resolve(import.meta.dirname, "../..");
const signInSource = readFileSync(
  path.join(root, "web/src/lib/flight/SignIn.svelte"),
  "utf8",
);

const securityError = () =>
  new DOMException("The operation is insecure.", "SecurityError");

describe("first-visit check with blocked storage (#1383)", () => {
  it("reports a first visit, without throwing, when the storage source throws on access", () => {
    const blocked = () => {
      throw securityError();
    };
    let result;
    expect(() => {
      result = isFirstVisit(blocked);
    }).not.toThrow();
    expect(result).toBe(true);
  });

  it("reports a first visit, without throwing, when the storage's getItem throws", () => {
    const blocked = {
      getItem() {
        throw securityError();
      },
      setItem() {
        throw securityError();
      },
    };
    let result;
    expect(() => {
      result = isFirstVisit(blocked);
    }).not.toThrow();
    expect(result).toBe(true);
  });

  it("reports a first visit when given no storage", () => {
    expect(isFirstVisit(undefined)).toBe(true);
  });
});

describe("sign-in call site (#1383)", () => {
  it("still calls the first-visit check", () => {
    expect(signInSource).toMatch(/\bisFirstVisit\s*\(/);
  });

  it("does not read the localStorage property while working out the argument", () => {
    const calls = [...signInSource.matchAll(/\bisFirstVisit\s*\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [call, argument] of calls) {
      expect(argument, call).not.toMatch(
        /^\s*(?:(?:window|globalThis|self)\s*\.\s*)?localStorage\s*(?:,|$)/,
      );
    }
  });
});
