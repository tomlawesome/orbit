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
    // The shorthand is `animation: orbit-launch-owed <duration> <delay> ...`:
    // the first time value is the duration, the second the delay. Pin both, so
    // a 0.4 s delay or a 4 s duration does not pass for the 4 s failsafe.
    const timings = rules.flatMap((r) =>
      [...r.body.matchAll(/(?:^|;)\s*animation\s*:\s*([^;]*)/g)]
        .map((m) => m[1].trim().split(/\s+/))
        .filter((parts) => parts.includes("orbit-launch-owed"))
        .map((parts) => parts.filter((p) => /^-?[\d.]+m?s$/.test(p))),
    );
    expect(timings, `launch-owed rules: ${JSON.stringify(rules)}`).toContainEqual(["0s", "4s"]);
  });

  it("the orbit-launch-owed keyframe reveals what launch-owed hides", () => {
    const hides = rules.some(
      (r) => /visibility\s*:\s*hidden/.test(r.body) && /orbit-launch-owed/.test(r.body),
    );
    expect(hides, `launch-owed rules: ${JSON.stringify(rules)}`).toBe(true);
    const keyframes = html.match(/@keyframes\s+orbit-launch-owed\s*\{([\s\S]*?\})\s*\}/);
    expect(keyframes, "no @keyframes orbit-launch-owed in web/src/app.html").not.toBeNull();
    expect(keyframes[1]).toMatch(/(?:to|100%)\s*\{[^}]*visibility\s*:\s*visible/);
  });
});
