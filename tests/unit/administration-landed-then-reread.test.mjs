import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const server = vi.hoisted(() => {
  const ok = async () => ({});
  return {
    commandMailbox: ok, commandUploadLimit: ok, addMember: ok, commandContact: ok,
    createLocalUser: ok, createSystem: ok, restoreHousehold: ok, testMail: ok,
    setUserDisabled: ok, hardDeleteHousehold: ok,
  };
});
vi.mock("$lib/data/workspace.js", () => ({
  retryDocumentJob: vi.fn(), sendSetupLink: vi.fn(),
  addMember: (/** @type {unknown[]} */ ...a) => server.addMember(...a),
  commandContact: (/** @type {unknown} */ command) => server.commandContact(command),
  createLocalUser: (/** @type {unknown} */ body) => server.createLocalUser(body),
  createSystem: (/** @type {unknown} */ body) => server.createSystem(body),
  restoreHousehold: (/** @type {unknown} */ id) => server.restoreHousehold(id),
  testMail: (/** @type {unknown} */ which) => server.testMail(which),
  setUserDisabled: (/** @type {unknown[]} */ ...a) => server.setUserDisabled(...a),
  hardDeleteHousehold: (/** @type {unknown[]} */ ...a) => server.hardDeleteHousehold(...a),
  commandMailbox: (/** @type {unknown} */ command) => server.commandMailbox(command),
  commandUploadLimit: (/** @type {unknown} */ command) => server.commandUploadLimit(command),
  wordsOf: (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error)),
}));
const {
  commandMail, deleteSystemNow, inviteLocalUser, makeSystem, placePerson, restoreSystem, runMailTest, setContact,
  setDisabled, setUploadLimit,
} = await import("../../web/src/routes/administration/acts.svelte.js");

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

/*
 * The rule for every act in acts.svelte.js (#1584 W-F2, W-F5): the command is
 * acknowledged by its own answer; the re-read after it is a separate step
 * whose failure is said as done-but-unread (`done — ... reload ...`), never
 * as the command refused. A refused command still says its own words and
 * reads nothing again. Each act is called for real with the server's
 * commands stood in above.
 */
const DONE = /^done —.*reload/i;
const READ_FAILS = "the screen would not load";
const failedRead = vi.fn(async () => { throw new Error(READ_FAILS); });
const goodRead = vi.fn(async () => {});
const ok = async () => ({});
const refuses = async () => { throw new Error("no"); };

beforeEach(() => {
  failedRead.mockClear();
  goodRead.mockClear();
  Object.assign(server, {
    commandMailbox: ok, commandUploadLimit: ok, addMember: ok, commandContact: ok,
    createLocalUser: ok, createSystem: ok, restoreHousehold: ok, testMail: ok,
    setUserDisabled: ok, hardDeleteHousehold: ok,
  });
});

describe("a re-read that fails after a landed command is said as done, not as the command refused (#1584 W-F2, W-F5)", () => {
  const person = { id: "p1", displayName: "Ada" };
  const system = { id: "s1", name: "Home" };

  it("placePerson: wakes the placement, then the done line (no failure wake); the card says done", async () => {
    const landed = vi.fn();
    const wake = vi.fn();
    const card = { busy: /** @type {string | null} */ (null), problem: /** @type {string | null} */ (null) };
    await placePerson(person, system, { card, reread: failedRead, landed, wake });

    expect(landed).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake.mock.calls[0][0]).toBe("Ada is in Home");
    expect(wake.mock.calls[1][0]).toMatch(DONE);
    for (const call of wake.mock.calls) expect(call[1]?.failure, "no failure wake after a landed command").toBeFalsy();
    expect(card.problem).toMatch(DONE);
    expect(card.busy).toBeNull();
  });

  it("inviteLocalUser: lands with the new user's id; the card says done, not setupWords' text", async () => {
    server.createLocalUser = async () => ({ user: { id: "u1" }, sentTo: "a@b", expiresAt: "2026-11-30T00:00:00Z" });
    const landed = vi.fn();
    const wake = vi.fn();
    const card = { busy: false, problem: /** @type {string | null} */ (null) };
    await inviteLocalUser(
      { email: "a@b", displayName: "A", expiresInDays: 7 }, "",
      { card, actorHasPassword: false, reread: failedRead, landed, wake },
    );

    expect(landed).toHaveBeenCalledTimes(1);
    expect(landed.mock.calls[0][0].userId).toBe("u1");
    expect(card.problem).toMatch(/^done —/);
    expect(card.problem).not.toBe(READ_FAILS);
    expect(card.busy).toBe(false);
    // The phone's line at the foot of the screen: the link was sent, then the done line (not the read error).
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake.mock.calls[0][0]).toMatch(/^setup link sent/);
    expect(wake.mock.calls[1][0]).toMatch(DONE);
    expect(wake.mock.calls[1][0]).not.toBe(READ_FAILS);
    for (const call of wake.mock.calls) expect(call[1]?.failure, "no failure wake after a landed command").toBeFalsy();
  });

  it("makeSystem: lands; the card says done and so does the wake it is given", async () => {
    const landed = vi.fn();
    const wake = vi.fn();
    const card = { busy: false, problem: /** @type {string | null} */ (null) };
    await makeSystem("Flat", { id: "u1" }, "", { card, actorHasPassword: false, reread: failedRead, landed, wake });

    expect(landed).toHaveBeenCalledTimes(1);
    expect(card.problem).toMatch(/^done —/);
    expect(wake).toHaveBeenCalledWith(card.problem);
    expect(card.busy).toBe(false);
  });

  it("setContact: lands and settles (the editor closes), and the card says done", async () => {
    const landed = vi.fn();
    const settled = vi.fn();
    const wake = vi.fn();
    const card = { busy: false, problem: /** @type {string | null} */ (null) };
    await setContact({ version: 2 }, { action: "set", address: "hello@example.test" }, { card, reread: failedRead, landed, settled, wake });

    expect(landed).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(card.problem).toMatch(/^done —/);
    expect(card.busy).toBe(false);
    // The phone's line: the contact was saved, then the done line (not the read error).
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake.mock.calls[0][0]).toBe("the public contact is hello@example.test");
    expect(wake.mock.calls[1][0]).toMatch(DONE);
    expect(wake.mock.calls[1][0]).not.toBe(READ_FAILS);
    for (const call of wake.mock.calls) expect(call[1]?.failure, "no failure wake after a landed command").toBeFalsy();
  });

  it("runMailTest: the card says done and is no longer busy", async () => {
    const card = { busy: /** @type {"mailbox" | "relay" | null} */ (null), problem: /** @type {string | null} */ (null) };
    await runMailTest("mailbox", { card, reread: failedRead });

    expect(card.problem).toMatch(/^done —/);
    expect(card.busy).toBeNull();
  });

  it("restoreSystem: the row stays green (ok), says it is back and to reload, never 'not restored'", async () => {
    const said = /** @type {Record<string, { ok: boolean, text: string }>} */ ({});
    await restoreSystem({ id: "s1", name: "Home" }, said, failedRead);

    expect(said.s1.ok).toBe(true);
    expect(said.s1.text.startsWith("restored · Home")).toBe(true);
    expect(said.s1.text).toMatch(/reload/i);
    expect(said.s1.text).not.toMatch(/not restored/);
  });
});

describe("a refused command says its own words and reads nothing again (guards, #1584 W-F2)", () => {
  it("placePerson: the refusal and a failure wake; nothing landed", async () => {
    server.addMember = refuses;
    const landed = vi.fn();
    const wake = vi.fn();
    const card = { busy: /** @type {string | null} */ (null), problem: /** @type {string | null} */ (null) };
    await placePerson({ id: "p1", displayName: "Ada" }, { id: "s1", name: "Home" }, { card, reread: goodRead, landed, wake });

    expect(card.problem).toBe("no");
    expect(wake).toHaveBeenCalledWith("no", { failure: true });
    expect(landed).not.toHaveBeenCalled();
    expect(goodRead).not.toHaveBeenCalled();
    expect(card.busy).toBeNull();
  });

  it("inviteLocalUser and makeSystem: the refusal in setupWords' text; nothing landed", async () => {
    server.createLocalUser = refuses;
    server.createSystem = refuses;
    const landed = vi.fn();
    const invite = { busy: false, problem: /** @type {string | null} */ (null) };
    await inviteLocalUser({ email: "a@b", displayName: "A", expiresInDays: 7 }, "", { card: invite, actorHasPassword: false, reread: goodRead, landed });
    const system = { busy: false, problem: /** @type {string | null} */ (null) };
    await makeSystem("Flat", { id: "u1" }, "", { card: system, actorHasPassword: false, reread: goodRead, landed });

    expect(invite.problem).toBe("no");
    expect(system.problem).toBe("no");
    expect(landed).not.toHaveBeenCalled();
    expect(goodRead).not.toHaveBeenCalled();
    expect(invite.busy).toBe(false);
    expect(system.busy).toBe(false);
  });

  it("setContact and runMailTest: the refusal; nothing landed or settled", async () => {
    server.commandContact = refuses;
    server.testMail = refuses;
    const landed = vi.fn();
    const settled = vi.fn();
    const contact = { busy: false, problem: /** @type {string | null} */ (null) };
    await setContact({ version: 2 }, { action: "clear" }, { card: contact, reread: goodRead, landed, settled });
    const test = { busy: /** @type {"mailbox" | "relay" | null} */ (null), problem: /** @type {string | null} */ (null) };
    await runMailTest("relay", { card: test, reread: goodRead });

    expect(contact.problem).toBe("no");
    expect(test.problem).toBe("no");
    expect(landed).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(goodRead).not.toHaveBeenCalled();
    expect(contact.busy).toBe(false);
    expect(test.busy).toBeNull();
  });

  it("restoreSystem: 'not restored — no', not ok, and no re-read", async () => {
    server.restoreHousehold = refuses;
    const said = /** @type {Record<string, { ok: boolean, text: string }>} */ ({});
    await restoreSystem({ id: "s1", name: "Home" }, said, goodRead);

    expect(said.s1).toEqual({ ok: false, text: "not restored — no" });
    expect(goodRead).not.toHaveBeenCalled();
  });
});

describe("the phone passes what the acts need (source check on pocket.svelte, #1584 W-F2)", () => {
  /**
   * The text of the call that follows `marker`: from its first `(` to the
   * matching `)`.
   * @param {string} src @param {string} marker
   */
  function callAfter(src, marker) {
    const start = src.indexOf(marker);
    expect(start, `pocket.svelte has no \`${marker}\``).toBeGreaterThan(-1);
    const open = src.indexOf("(", start);
    let depth = 0;
    for (let end = open; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")" && --depth === 0) return src.slice(open, end + 1);
    }
    throw new Error(`unbalanced call after ${marker}`);
  }

  it("the upload limit is sent without its own `unread:` override, so the phone wakes the done line like every act", () => {
    expect(callAfter(read(POCKET_PATH), "setUploadLimit(view")).not.toMatch(/\bunread\s*:/);
  });

  it("makeSystem is handed `wake`, as an option beside `landed` (not only called inside it)", () => {
    expect(callAfter(read(POCKET_PATH), "await makeSystem(")).toMatch(/(?:^|[\s{,])wake\s*(?:,|\}|:)/);
  });
});

/*
 * #1584 web-admin-1: disable/enable and the hard delete, whose command lands
 * and whose re-read then fails. The disable says done on the people card
 * alone (its success wake carries the undo, which a second wake would take
 * away). The hard delete rewrites the tail of its row's `gone` line; the phone
 * also wakes it, the desk (no `wake`) does not. Neither says "not deleted" or
 * wakes a failure once the command has landed.
 */
describe("disable and hard delete: a failed re-read after a landed command is said as done (#1584 web-admin-1)", () => {
  const person = { id: "p1", displayName: "Ada" };
  const row = { id: "s1", name: "Home" };
  const newCard = () => ({ busy: /** @type {string | null} */ (null), problem: /** @type {string | null} */ (null) });
  const GONE = "deleted · Home is gone for good";

  it("setDisabled, disabling, read fails: one wake with the undo standing; the card says done; the undo re-enables", async () => {
    const calls = /** @type {unknown[][]} */ ([]);
    server.setUserDisabled = async (/** @type {unknown[]} */ ...args) => { calls.push(args); return {}; };
    const wake = vi.fn();
    const card = newCard();
    await setDisabled(person, true, { card, reread: failedRead, wake });

    expect(calls).toEqual([["p1", true]]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toBe("Ada is disabled · they can’t sign in");
    expect(typeof wake.mock.calls[0][1]?.undo).toBe("function");
    expect(wake.mock.calls[0][1]?.failure).toBeFalsy();
    expect(card.problem).toMatch(DONE);
    expect(card.busy).toBeNull();

    wake.mock.calls[0][1].undo();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual(["p1", false]);
  });

  it("setDisabled, enabling, read fails: one plain wake (no undo, no failure); the card says done", async () => {
    const wake = vi.fn();
    const card = newCard();
    await setDisabled(person, false, { card, reread: failedRead, wake });

    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toBe("Ada can sign in again");
    expect(wake.mock.calls[0][1]?.undo).toBeUndefined();
    expect(wake.mock.calls[0][1]?.failure).toBeFalsy();
    expect(card.problem).toMatch(DONE);
  });

  it("setDisabled, read lands: the card is clear and the disabled line is woken once", async () => {
    const wake = vi.fn();
    const card = newCard();
    await setDisabled(person, true, { card, reread: goodRead, wake });

    expect(card.problem).toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toBe("Ada is disabled · they can’t sign in");
  });

  it("setDisabled refused: the refusal on the card and as one failure wake; nothing re-read", async () => {
    server.setUserDisabled = refuses;
    const wake = vi.fn();
    const card = newCard();
    await setDisabled(person, true, { card, reread: goodRead, wake });

    expect(card.problem).toBe("no");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith("no", { failure: true });
    expect(goodRead).not.toHaveBeenCalled();
  });

  it("deleteSystemNow, phone shape, read fails: the sheet closes, the gone line says reload, and the phone wakes done", async () => {
    const calls = /** @type {unknown[][]} */ ([]);
    server.hardDeleteHousehold = async (/** @type {unknown[]} */ ...args) => { calls.push(args); return {}; };
    const gone = /** @type {Record<string, string>} */ ({});
    const landed = vi.fn();
    const refused = vi.fn();
    const wake = vi.fn();
    await deleteSystemNow(row, "Home", { gone, reread: failedRead, landed, refused, wake });

    expect(calls).toEqual([["s1", "Home"]]);
    expect(landed).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
    expect(gone.s1.startsWith(GONE)).toBe(true);
    expect(gone.s1).toMatch(/reload/i);
    expect(gone.s1).not.toMatch(/not deleted/);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toMatch(DONE);
    expect(wake.mock.calls[0][1]?.failure).toBeFalsy();
  });

  it("deleteSystemNow, desk shape (no wake), read fails: resolves; the gone line says reload; landed once", async () => {
    const gone = /** @type {Record<string, string>} */ ({});
    const landed = vi.fn();
    const refused = vi.fn();
    await deleteSystemNow(row, "Home", { gone, reread: failedRead, landed, refused });

    expect(landed).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
    expect(gone.s1.startsWith(GONE)).toBe(true);
    expect(gone.s1).toMatch(/reload/i);
    expect(gone.s1).not.toMatch(/not deleted/);
  });

  it("deleteSystemNow, read lands: the gone line keeps its members' words and nothing is woken", async () => {
    const gone = /** @type {Record<string, string>} */ ({});
    const landed = vi.fn();
    const wake = vi.fn();
    await deleteSystemNow(row, "Home", { gone, reread: goodRead, landed, refused: vi.fn(), wake });

    expect(gone.s1).toBe("deleted · Home is gone for good · its members keep their accounts");
    expect(wake).not.toHaveBeenCalled();
    expect(landed).toHaveBeenCalledTimes(1);
  });

  it("deleteSystemNow refused: the server's words to `refused`; nothing landed, said, re-read or woken", async () => {
    server.hardDeleteHousehold = refuses;
    const gone = /** @type {Record<string, string>} */ ({});
    const landed = vi.fn();
    const refused = vi.fn();
    const wake = vi.fn();
    await deleteSystemNow(row, "Home", { gone, reread: goodRead, landed, refused, wake });

    expect(refused).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledWith("no");
    expect(landed).not.toHaveBeenCalled();
    expect(gone).not.toHaveProperty("s1");
    expect(goodRead).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it("the layouts send these through the acts (import lines of pocket.svelte and +page.svelte)", () => {
    /**
     * Every named import from `from`, across all its import statements.
     * @param {string} src @param {RegExp} from @returns {string[]}
     */
    const names = (src, from) => [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)]
      .filter((m) => from.test(m[2]))
      .flatMap((m) => m[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    const workspace = /\/data\/workspace\.js$/;
    const acts = /acts\.svelte\.js$/;
    const pocket = read(POCKET_PATH);
    const desk = read(DESK_PATH);

    expect(names(pocket, workspace)).not.toContain("setUserDisabled");
    expect(names(pocket, workspace)).not.toContain("hardDeleteHousehold");
    expect(names(pocket, acts)).toEqual(expect.arrayContaining(["setDisabled", "deleteSystemNow"]));
    expect(names(desk, workspace)).not.toContain("hardDeleteHousehold");
    expect(names(desk, acts)).toContain("deleteSystemNow");
  });
});
