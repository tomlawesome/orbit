import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1316 A1-R1: a landed command is never read back as not done.
 *
 * The phone's mailbox action and the desk's upload-limit action each send a
 * command and then re-read the screen. When the command lands and only the
 * re-read fails, both used to report the re-read error as if the command had
 * failed: the sheet stayed open, a typed password stayed in its field, and the
 * problem text said nothing worked. The command did land, so the reader must
 * see it as done -- sheet closed, password cleared, outcome kept -- with a
 * problem line that begins `done —` and tells them to reload.
 *
 * Evaluated rather than mounted: there is no component-mounting harness in
 * this suite (see administration-pocket-tells-scope.test.mjs), so each
 * function is lifted out of its source and run against stand-in state and
 * stand-in server calls. The stand-ins are the only names the function may
 * read or write; any other name it reaches for fails the test loudly.
 */

const POCKET_PATH = "web/src/routes/administration/pocket.svelte";
const DESK_PATH = "web/src/routes/administration/+page.svelte";

/** @param {string} path @returns {string} */
function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

/**
 * Lift `async function <name>(...) { ... }` out of a component and run it
 * with `scope` as the only names in reach. State the function assigns lands
 * back on `scope`.
 * @param {string} path @param {string} name @param {Record<string, unknown>} scope
 * @returns {Function}
 */
function lift(path, name, scope) {
  const src = read(path);
  const start = src.indexOf(`async function ${name}(`);
  expect(start, `${path} has no \`${name}\``).toBeGreaterThan(-1);
  const end = src.indexOf("\n  }\n", start);
  const body = src.slice(start, end + "\n  }".length);
  const sandbox = new Proxy(scope, {
    has: (target, key) => typeof key === "string" && key in target,
  });
  // Sloppy-mode Function so `with` can route every free name to `scope`.
  return new Function("sandbox", `with (sandbox) { return (${body}); }`)(sandbox);
}

describe("a landed command is never read back as not done (#1316 A1-R1)", () => {
  it("phone mailbox: a re-read failure after a verified rotate leaves the sheet closed, the password cleared, and says done", async () => {
    const scope = {
      mailBusy: null,
      mailProblem: null,
      mailOutcome: null,
      editOpen: false,
      rotateOpen: true,
      mailPassword: "hunter2-not-real",
      commandMailbox: async () => ({ outcome: "verified" }),
      reread: async () => { throw new Error("the screen would not load"); },
      wordsOf: (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error)),
    };
    const mailAction = lift(POCKET_PATH, "mailAction", scope);
    await mailAction("rotate", { action: "rotate", expectedVersion: 3, password: scope.mailPassword });

    expect(scope.rotateOpen, "the rotate sheet should be closed").toBe(false);
    expect(scope.mailPassword, "the password field should be empty").toBe("");
    expect(scope.mailOutcome).toBe("verified");
    expect(scope.mailProblem).toMatch(/^done —/);
    expect(scope.mailProblem).toMatch(/reload/i);
    expect(scope.mailBusy).toBeNull();
  });

  it("desk upload limit: a re-read failure after a landed set closes the editor and says done", async () => {
    const scope = {
      uploadLimitBusy: false,
      uploadLimitProblem: null,
      editingUploadLimit: true,
      view: { uploadLimit: { version: 7 } },
      need: () => ({ uploadLimit: { version: 7 } }),
      commandUploadLimit: async () => ({}),
      readAdminScreen: async () => { throw new Error("the screen would not load"); },
      wordsOf: (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error)),
    };
    const uploadLimitAction = lift(DESK_PATH, "uploadLimitAction", scope);
    await uploadLimitAction({ action: "set", megabytes: 20 });

    expect(scope.editingUploadLimit, "the editor should be closed").toBe(false);
    expect(scope.uploadLimitProblem).toMatch(/^done —/);
    expect(scope.uploadLimitBusy).toBe(false);
  });
});
