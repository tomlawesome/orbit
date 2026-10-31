import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

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
 * layout's action is lifted out of its source and run against stand-in state.
 * Since #1353 both are thin calls into ./acts.svelte.js, which is handed in
 * for real with the server calls stood in. The stand-ins are the only names
 * the action may read or write; any other name it reaches for fails the test
 * loudly.
 */

const POCKET_PATH = "web/src/routes/administration/pocket.svelte";
const DESK_PATH = "web/src/routes/administration/+page.svelte";

const server = vi.hoisted(() => ({ commandMailbox: async () => ({}), commandUploadLimit: async () => ({}) }));
vi.mock("$lib/data/workspace.js", () => ({
  addMember: vi.fn(), commandContact: vi.fn(), createLocalUser: vi.fn(), createSystem: vi.fn(),
  restoreHousehold: vi.fn(), retryDocumentJob: vi.fn(), sendSetupLink: vi.fn(), testMail: vi.fn(),
  commandMailbox: (/** @type {unknown} */ command) => server.commandMailbox(command),
  commandUploadLimit: (/** @type {unknown} */ command) => server.commandUploadLimit(command),
  wordsOf: (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error)),
}));
const { commandMail, setUploadLimit } = await import("../../web/src/routes/administration/acts.svelte.js");

/** @param {string} path @returns {string} */
function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

/**
 * Lift `const <name> = <expression>;` out of a component (the statement ends
 * at the first `;` outside brackets) and run it with `scope` as the only names
 * in reach. State the action assigns lands back on `scope`.
 * @param {string} path @param {string} name @param {Record<string, unknown>} scope
 * @returns {Function}
 */
function lift(path, name, scope) {
  const src = read(path);
  const marker = `const ${name} = `;
  const start = src.indexOf(marker);
  expect(start, `${path} has no \`${name}\``).toBeGreaterThan(-1);
  let depth = 0;
  let end = start + marker.length;
  for (; end < src.length; end++) {
    const c = src[end];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) break;
  }
  const body = src.slice(start + marker.length, end);
  const sandbox = new Proxy(scope, {
    has: (target, key) => typeof key === "string" && key in target,
  });
  // Sloppy-mode Function so `with` can route every free name to `scope`.
  return new Function("sandbox", `with (sandbox) { return (${body}); }`)(sandbox);
}

describe("a landed command is never read back as not done (#1316 A1-R1)", () => {
  it("phone mailbox: a re-read failure after a verified rotate leaves the sheet closed, the password cleared, and says done", async () => {
    server.commandMailbox = async () => ({ outcome: "verified" });
    const scope = {
      mailCard: { busy: null, problem: null, outcome: null },
      editOpen: false,
      rotateOpen: true,
      mailPassword: "hunter2-not-real",
      commandMail,
      reread: async () => { throw new Error("the screen would not load"); },
    };
    const mailAction = lift(POCKET_PATH, "mailAction", scope);
    await mailAction("rotate", { action: "rotate", expectedVersion: 3, password: scope.mailPassword });

    expect(scope.rotateOpen, "the rotate sheet should be closed").toBe(false);
    expect(scope.mailPassword, "the password field should be empty").toBe("");
    expect(scope.mailCard.outcome).toBe("verified");
    expect(scope.mailCard.problem).toMatch(/^done —/);
    expect(scope.mailCard.problem).toMatch(/reload/i);
    expect(scope.mailCard.busy).toBeNull();
  });

  it("desk upload limit: a re-read failure after a landed set closes the editor and says done", async () => {
    server.commandUploadLimit = async () => ({});
    const scope = {
      uploadLimitCard: { busy: false, problem: null },
      editingUploadLimit: true,
      need: () => ({ uploadLimit: { version: 7 } }),
      setUploadLimit,
      reread: async () => { throw new Error("the screen would not load"); },
    };
    const saveUploadLimit = lift(DESK_PATH, "saveUploadLimit", scope);
    await saveUploadLimit({ action: "set", megabytes: 20 });

    expect(scope.editingUploadLimit, "the editor should be closed").toBe(false);
    expect(scope.uploadLimitCard.problem).toMatch(/^done —/);
    expect(scope.uploadLimitCard.busy).toBe(false);
  });
});
