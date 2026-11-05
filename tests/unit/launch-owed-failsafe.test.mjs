import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * #1700 (sign-in flash of the dial): while body.launch-owed is set the page is
 * unpainted, and a CSS-only failsafe paints it after 4 s even if no script
 * ever runs. The failsafe is the `launch-owed` rule carrying the delayed
 * reveal, in web/src/app.html (the document that exists before any script).
 */
const html = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../web/src/app.html"),
  "utf8",
);

const rules = [...html.matchAll(/([^{}]*launch-owed[^{}]*)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim(),
  body: m[2],
}));

describe("#1700 launch-owed CSS failsafe", () => {
  it("app.html styles body.launch-owed", () => {
    expect(rules.length, "no CSS rule mentions launch-owed in web/src/app.html").toBeGreaterThan(0);
  });

  it("carries a delayed reveal of 4 s, in CSS alone", () => {
    const delayed = rules.some((r) =>
      /(animation|transition)[^;]*\b4s\b|(animation|transition)-delay\s*:\s*4s/.test(r.body),
    );
    expect(delayed, `launch-owed rules: ${JSON.stringify(rules)}`).toBe(true);
  });
});
