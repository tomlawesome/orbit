import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #741: no e2e spec may name a host or port.
 *
 * Eleven specs asserted the post-sign-in URL against a literal
 * `127.0.0.1:3000`. CI publishes the application there, so they passed in CI
 * and could never pass anywhere else -- `scripts/test-e2e-local.sh` publishes
 * on 13777 deliberately, to avoid colliding with a real deployment. The result
 * was a documented local harness that failed 37 tests before testing anything,
 * and a wall of red that hid whatever was actually broken.
 *
 * The replacement is `toHaveURL("/workspace")`, which Playwright resolves
 * against `baseURL` -- so the origin is still asserted, just not written down.
 *
 * This test is the tripwire. A spec that reintroduces a literal port fails
 * here, in the fast suite, rather than three minutes into a container run.
 */

const specDirectory = new URL("../e2e/", import.meta.url).pathname;

/* A literal port on a host: `:3000`, `127.0.0.1:13777`, `localhost:8080`.
   Deliberately not matching a bare `:3000` inside a longer number, nor the
   port names the specs legitimately read from the environment
   (TEST_SMTP_PORT and friends), which are how a spec is SUPPOSED to learn
   where something is listening. */
const literalHostPort = /(?:\d{1,3}(?:\\?\.\d{1,3}){3}|localhost)\\?:\d{2,5}/;

function specFiles() {
  return readdirSync(specDirectory)
    .filter((name) => name.endsWith(".spec.ts"))
    .sort();
}

describe("e2e specs name no host or port", () => {
  it("finds spec files to check, so a rename cannot silently empty this test", () => {
    expect(specFiles().length).toBeGreaterThan(10);
  });

  it.each(specFiles())("%s", (name) => {
    const source = readFileSync(join(specDirectory, name), "utf8");
    const offenders = source
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => literalHostPort.test(line));

    expect(
      offenders,
      `${name} names a host and port literally. Use a baseURL-relative assertion ` +
        `(toHaveURL("/path")) or read the port from the environment, as ` +
        `v19-mail-collection.spec.ts does with TEST_SMTP_PORT. See #741.`,
    ).toEqual([]);
  });
});
