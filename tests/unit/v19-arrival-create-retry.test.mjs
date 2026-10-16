// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyWorkspace, workspaceSchema } from "@/lib/workspace";

/*
 * #1316 (GAP-U1): the first-run create must survive a lost reply. The create
 * lands but the answer is lost (a network blip), the browser says
 * "Failed to fetch", and the person presses Create again. Each press used to
 * mint a fresh household id, so the retry made a second household. The id is
 * the idempotency key (the server replays a repeat of the same id): Arrival
 * keeps ONE id for the card until a create succeeds, whatever is edited, and
 * the refusal line is Orbit's own words, never the browser's. After no answer
 * it reads the session before saying anything (U3 design,
 * .agents/reviews/v0.3.0-door/r5/design-U3-lost-reply.md; the numbers in the
 * test names are that design's testable behaviours).
 *
 * Arrival.svelte is compiled here with Svelte's own compiler and mounted in
 * happy-dom over the real workspace.js and a stubbed fetch, as
 * v19-create-partial-landing-words.test.mjs does for the pocket form. Its
 * child components are stood in for: Newcomer (the test presses Create and
 * types the name through the props Arrival hands it), SignIn and Flight.
 */

/** What the stand-in Newcomer was handed: Arrival's bindings, handlers and refusal. */
const newcomer = vi.hoisted(() => ({ props: /** @type {any} */ (null) }));
vi.mock("../../web/src/lib/arrival/Newcomer.svelte", () => ({
  default: (/** @type {unknown} */ _anchor, /** @type {any} */ props) => { newcomer.props = props; },
}));
vi.mock("../../web/src/lib/flight/SignIn.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/flight/Flight.svelte", () => ({ default: () => {} }));
vi.mock("../../web/src/lib/flight/fetch-ahead.js", () => ({ fetchFlightAhead: () => {} }));

/** The commands the server was sent, in order. @type {any[]} */
let commands = [];
/** The household.create commands alone. */
const creates = () => commands.filter((command) => command.type === "household.create");
/**
 * Answers to household.create, in order; the last one repeats.
 * lost: no answer (the browser's TypeError). refused: a 409 in the server's
 * own words. mismatch: the 422 for the same id with different details (U3
 * decision 2). bare: a refusal with no words of its own (an empty message).
 * ok: the household was created. gateway502 / gateway504: the proxy in front
 * of Orbit answered with its own bare page and no Orbit error code, so the
 * create may or may not have landed (a lost reply by another road).
 * @type {("lost" | "refused" | "mismatch" | "bare" | "ok" | "gateway502" | "gateway504")[]}
 */
let answers = [];
/**
 * How /api/auth/session answers once a create has gone unanswered (U3
 * decision 1, "read before telling"). landed: the session points at the id
 * last sent. absent: it points nowhere. fails: the read gets no answer too.
 * Before any lost create it always points nowhere (the empty instance).
 * @type {"landed" | "absent" | "fails" | "hangs"}
 */
let sessionAfterLost = "absent";
/**
 * How /api/workspace answers once the server has refused a create as a
 * mismatch (the card reads the household's name back). stored: the member's
 * own `households` hold the pinned id under the name it was really created
 * with, "Harlow Home", exactly as the real read gives a member: their
 * households in `households`, `visibleHouseholds` EMPTY (it is filled only
 * for a user with no household; workspace-repository.ts). absent: it is not
 * among them. fails: the read gets no answer. hangs: it never answers.
 * Before any mismatch it always answers the empty instance.
 * @type {"stored" | "absent" | "fails" | "hangs"}
 */
let workspaceAfterMismatch = "absent";
let mismatched = false;
/** Set to hold the session read after a lost create until released. @type {Promise<void> | null} */
let holdSession = null;
/**
 * How household.activate answers, in order; the last one repeats.
 * ok: activated. lost: no answer. refused: a 409 in the server's own words.
 * @type {("ok" | "lost" | "refused")[]}
 */
let activateAnswers = [];
let activations = 0;
/** Every request, in order: "session", "create", "activate", "workspace". @type {string[]} */
let requests = [];
let createLost = false;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** A read that never answers (it rejects only if the caller aborts it). */
const never = (/** @type {RequestInit | undefined} */ init) => new Promise((_, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
});

/** A household as the real workspace read gives a member (schema-checked below). */
const memberHousehold = (/** @type {string} */ id, /** @type {string} */ name) => {
  const workspace = workspaceSchema.parse({
    ...createEmptyWorkspace(),
    activeHouseholdId: id,
    households: [{ ...createEmptyWorkspace().households[0], id, name }],
  });
  return workspace.households[0];
};

function stubFetch() {
  commands = [];
  requests = [];
  createLost = false;
  mismatched = false;
  activations = 0;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) {
      requests.push("session");
      if (!createLost) return json({ user: { id: "u1" }, csrfToken: "t1", activeHouseholdId: null });
      if (holdSession) await holdSession;
      if (sessionAfterLost === "hangs") await never(init);
      if (sessionAfterLost === "fails") throw new TypeError("Failed to fetch");
      const landed = sessionAfterLost === "landed" ? creates().at(-1)?.household.id ?? null : null;
      return json({ user: { id: "u1" }, csrfToken: "t1", activeHouseholdId: landed });
    }
    if (href.endsWith("/api/workspace") && !init?.method) {
      requests.push("workspace");
      if (mismatched && workspaceAfterMismatch === "fails") throw new TypeError("Failed to fetch");
      if (mismatched && workspaceAfterMismatch === "hangs") await never(init);
      if (mismatched && workspaceAfterMismatch === "stored") {
        const id = creates().at(-1)?.household.id;
        return json({ workspace: { ...createEmptyWorkspace(), households: [memberHousehold(id, "Harlow Home")], visibleHouseholds: [] } });
      }
      return json({ workspace: { households: [], visibleHouseholds: [] } });
    }
    if (href.includes("/api/workspace/commands") && init?.method === "POST") {
      const command = JSON.parse(String(init.body));
      commands.push(command);
      if (command.type === "household.activate") {
        requests.push("activate");
        const answer = activateAnswers[Math.min(activations, activateAnswers.length - 1)] ?? "ok";
        activations += 1;
        if (answer === "lost") throw new TypeError("Failed to fetch");
        if (answer === "refused") return json({ error: { code: "household_activate_refused", message: "That household cannot be opened" } }, 409);
        return json({ workspace: { activeHouseholdId: command.householdId, households: [], visibleHouseholds: [] } });
      }
      requests.push("create");
      const sent = creates().length;
      const answer = answers[Math.min(sent, answers.length) - 1];
      if (answer === "lost") { createLost = true; throw new TypeError("Failed to fetch"); }
      if (answer === "gateway502") { createLost = true; return new Response("<html>502 Bad Gateway</html>", { status: 502 }); }
      if (answer === "gateway504") { createLost = true; return new Response("<html>504 Gateway Time-out</html>", { status: 504 }); }
      if (answer === "mismatch") {
        mismatched = true;
        return json({ error: { code: "household_create_mismatch", message: "This household was already created with different details" } }, 422);
      }
      if (answer === "bare") return json({ error: { code: "household_create_refused", message: "" } }, 409);
      if (answer === "ok") {
        return json({ workspace: { activeHouseholdId: command.household.id, households: [], visibleHouseholds: [] } });
      }
      return json({ error: { code: "household_name_recoverable", message: "That name is waiting to be restored" } }, 409);
    }
    return json({}, 404);
  }));
}

const web = resolve(import.meta.dirname, "../../web");
const svelteSrc = join(web, "node_modules/svelte/src");
/** @type {string} */
let compiledDir;
/** @type {string} */
let compiledArrival;

beforeAll(async () => {
  const { compile } = await import(pathToFileURL(join(svelteSrc, "compiler/index.js")).href);
  const file = join(web, "src/lib/arrival/Arrival.svelte");
  const quoted = (/** @type {string} */ path) => JSON.stringify(path);
  const js = compile(readFileSync(file, "utf8"), { filename: file, generate: "client", dev: false }).js.code
    .replaceAll("'svelte/internal/client'", quoted(join(svelteSrc, "internal/client/index.js")))
    .replaceAll("'svelte/internal/disclose-version'", quoted(join(svelteSrc, "internal/disclose-version.js")))
    .replaceAll('from "svelte"', `from ${quoted(join(svelteSrc, "index-client.js"))}`)
    .replaceAll('"$lib/flight/SignIn.svelte"', quoted(join(web, "src/lib/flight/SignIn.svelte")))
    .replaceAll('"$lib/flight/Flight.svelte"', quoted(join(web, "src/lib/flight/Flight.svelte")))
    .replaceAll('"$lib/flight/fetch-ahead.js"', quoted(join(web, "src/lib/flight/fetch-ahead.js")))
    .replaceAll('"./stage.js"', quoted(join(web, "src/lib/arrival/stage.js")))
    .replaceAll('"./Newcomer.svelte"', quoted(join(web, "src/lib/arrival/Newcomer.svelte")))
    .replaceAll('"$lib/ringcard.css"', quoted(join(web, "src/lib/ringcard.css")))
    .replaceAll('"./arrival.css"', quoted(join(web, "src/lib/arrival/arrival.css")));
  /* Inside the checkout (tmp/ is git-ignored), so the module resolves Svelte,
     the $lib alias and the vitest transforms the way any web/ module does. */
  mkdirSync(resolve(import.meta.dirname, "../../tmp"), { recursive: true });
  compiledDir = mkdtempSync(resolve(import.meta.dirname, "../../tmp/arrival-create-retry-"));
  writeFileSync(join(compiledDir, "environment.mjs"), "export const browser = true;");
  writeFileSync(join(compiledDir, "state.mjs"), 'export const page = { url: new URL("http://localhost/") };');
  compiledArrival = join(compiledDir, "arrival.mjs");
  writeFileSync(
    compiledArrival,
    js.replaceAll('"$app/environment"', quoted(join(compiledDir, "environment.mjs")))
      .replaceAll('"$app/state"', quoted(join(compiledDir, "state.mjs"))),
  );
});
afterAll(() => { rmSync(compiledDir, { recursive: true, force: true }); });

/** @type {(() => void) | null} */
let unmountArrival = null;
/** The page's own navigations (location.assign), stubbed so the test stays put. @type {any} */
let assigned = null;
beforeEach(() => {
  vi.resetModules();
  document.body.className = "";
  document.body.innerHTML = "";
  sessionStorage.clear();
  answers = [];
  sessionAfterLost = "absent";
  workspaceAfterMismatch = "absent";
  holdSession = null;
  activateAnswers = [];
  stubFetch();
  assigned = vi.spyOn(window.location, "assign").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  unmountArrival?.();
  unmountArrival = null;
  newcomer.props = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = async () => { await new Promise((done) => setTimeout(done, 80)); };

/** Mounts Arrival on an empty instance and returns the first administrator's two moves. */
async function mountOnEmptyInstance() {
  const { mount, unmount, flushSync } = await import(pathToFileURL(join(svelteSrc, "index-client.js")).href);
  const { default: Arrival } = await import(/* @vite-ignore */ compiledArrival);
  const component = mount(Arrival, { target: document.body, props: { data: {} } });
  unmountArrival = () => unmount(component);
  await settle(); // the session and the (empty) workspace are read
  expect(newcomer.props, "the create card is on screen").not.toBeNull();
  const type = (/** @type {string} */ words) => {
    newcomer.props.name = words;
    flushSync();
    newcomer.props.onnaming?.();
  };
  const pressCreate = async () => {
    await newcomer.props.onsubmit();
    await settle();
  };
  /** The refusal line under the name: Orbit's words, as Newcomer is handed them. */
  const refusal = () => newcomer.props.rejected?.reason ?? "";
  /**
   * The whole line as the card renders it (CreateSystem.svelte: the quoted
   * name, the lower-case reason, then any link after a dash). The link's words
   * may come in the reason itself or in a `link` field beside it.
   */
  const line = () => {
    const rejected = newcomer.props.rejected;
    if (!rejected) return "";
    return `“${rejected.name}” ${rejected.reason}${rejected.link ? ` — ${rejected.link}` : ""}`;
  };
  /** Presses the link on the refusal line: the card's one link road, `onask`. */
  const pressLink = async () => {
    await newcomer.props.onask?.(newcomer.props.rejected);
    await settle();
  };
  const set = (/** @type {"timezone" | "currency"} */ field, /** @type {string} */ value) => {
    newcomer.props[field] = value;
    flushSync();
  };
  /** Whether the card's Create button is being held (Newcomer's `busy`). */
  const busy = () => Boolean(newcomer.props.busy);
  return { type, pressCreate, refusal, line, pressLink, set, busy };
}

describe("#1316 GAP-U1: pressing Create again after a lost reply", () => {
  /* U3 design, decision 1: one household id per card for the card's whole
     life, cleared only when a create succeeds. The old "new id when the name
     changes" rule is dropped: a second press can never mint a second household. */

  it("(1) sends the same household id when the name was edited between two presses", async () => {
    answers = ["lost"];
    const { type, pressCreate } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();
    type("Harlow House");
    await pressCreate();

    expect(creates()).toHaveLength(2);
    expect(creates()[0].household.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(creates()[1].household.name, "the edited name is what is sent").toBe("Harlow House");
    expect(creates()[1].household.id, "an id that never landed carries any name").toBe(creates()[0].household.id);
  });

  it("(2) sends the same household id when the time zone or currency changed between presses", async () => {
    answers = ["lost"];
    const { TIME_ZONES, CURRENCIES } = await import(pathToFileURL(join(web, "src/lib/arrival/stage.js")).href);
    const { type, pressCreate, set } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();
    const firstZone = creates()[0].household.timezone;
    const firstCurrency = creates()[0].household.currency;

    const otherZone = TIME_ZONES.map((/** @type {any} */ zone) => zone.value).find((/** @type {string} */ zone) => zone !== firstZone);
    set("timezone", otherZone);
    await pressCreate();
    const otherCurrency = CURRENCIES.find((/** @type {string} */ currency) => currency !== firstCurrency);
    set("currency", otherCurrency);
    await pressCreate();

    expect(creates()).toHaveLength(3);
    expect(creates()[1].household.timezone, "the changed zone is what is sent").toBe(otherZone);
    expect(creates()[2].household.currency, "the changed currency is what is sent").toBe(otherCurrency);
    expect(creates()[1].household.id).toBe(creates()[0].household.id);
    expect(creates()[2].household.id).toBe(creates()[0].household.id);
  });

  it("(3) keeps the id across every refusal: a 409, a 422 and no answer never change it", async () => {
    answers = ["lost", "refused", "mismatch", "bare", "lost"];
    const { type, pressCreate } = await mountOnEmptyInstance();
    type("Harlow HQ");
    for (let press = 0; press < 5; press += 1) await pressCreate();

    expect(creates()).toHaveLength(5);
    const ids = new Set(creates().map((command) => command.household.id));
    expect([...ids], "one id across every refusal").toHaveLength(1);
  });

  it("(4) after a create that got no answer, reads the session once before showing any line", async () => {
    answers = ["lost"];
    sessionAfterLost = "absent";
    /** @type {() => void} */
    let release = () => {};
    holdSession = new Promise((done) => { release = done; });
    const { type, line } = await mountOnEmptyInstance();
    type("Harlow HQ");

    const pressed = newcomer.props.onsubmit();
    await settle();
    const afterCreate = requests.slice(requests.lastIndexOf("create") + 1);
    expect(afterCreate, "the session is read after the lost create").toEqual(["session"]);
    expect(line(), "no line while the session read is still out").toBe("");

    release();
    await pressed;
    await settle();
    expect(requests.slice(requests.lastIndexOf("create") + 1), "read once, not again").toEqual(["session"]);
    expect(line()).not.toBe("");
  });

  it("(5) when the session read says the household landed, shows no line and goes home", async () => {
    answers = ["lost"];
    sessionAfterLost = "landed";
    const { type, pressCreate, line } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();

    expect(line(), "it landed: there is nothing to refuse").toBe("");
    expect(assigned).toHaveBeenCalledWith("/home");
    expect(creates(), "no second create is sent").toHaveLength(1);
  });

  it("(6) when the session read says it did not land, says it wasn't created and to try again", async () => {
    answers = ["lost"];
    sessionAfterLost = "absent";
    const { type, pressCreate, line, refusal } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();

    expect(line()).toBe("“Harlow HQ” wasn't created — no answer came back. Try again");
    expect(refusal()).not.toMatch(/failed to fetch/iu);
    expect(assigned).not.toHaveBeenCalled();
  });

  it("(7) when the session read fails too, says it may or may not have been created", async () => {
    answers = ["lost"];
    sessionAfterLost = "fails";
    const { type, pressCreate, line, refusal } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();

    expect(line()).toBe("“Harlow HQ” may or may not have been created — Orbit can't be reached. Try again");
    expect(refusal()).not.toMatch(/failed to fetch/iu);
    expect(assigned).not.toHaveBeenCalled();
  });

  it("(8) a 422 household_create_mismatch names the first-sent name and says it was already created", async () => {
    answers = ["lost", "mismatch"];
    sessionAfterLost = "absent";
    const { type, pressCreate, line } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();
    type("Harlow House");
    await pressCreate();

    expect(creates()).toHaveLength(2);
    expect(line(), "the name that landed, not the field's").toBe(
      "“Harlow HQ” was already created — carry on, and change it in settings →",
    );
  });

  it("(8b) the already-created line names the household as stored, read back from the workspace", async () => {
    /* Press 1 sends "Harlow Hme": no answer, and it did not land. Press 2
       sends "Harlow Home" (same id): it lands but its reply is lost too.
       Press 3 sends "Harlow HQ": the server refuses, and the card reads the
       workspace once to see what the household with its id is called. The
       read gives a member their own `households` and leaves
       `visibleHouseholds` empty, so the name is found there, by the pinned id. */
    answers = ["lost", "lost", "mismatch"];
    sessionAfterLost = "absent";
    workspaceAfterMismatch = "stored";
    const { type, pressCreate, line } = await mountOnEmptyInstance();
    type("Harlow Hme");
    await pressCreate();
    type("Harlow Home");
    await pressCreate();
    type("Harlow HQ");
    const readsBefore = requests.filter((request) => request === "workspace").length;
    await pressCreate();

    expect(creates().map((command) => command.household.name)).toEqual(["Harlow Hme", "Harlow Home", "Harlow HQ"]);
    expect(requests.filter((request) => request === "workspace").length - readsBefore, "one workspace read after the 422").toBe(1);
    expect(line()).toBe("“Harlow Home” was already created — carry on, and change it in settings →");
  });

  it("(8c) when the workspace read fails, the line falls back to the first-sent name", async () => {
    answers = ["lost", "mismatch"];
    sessionAfterLost = "absent";
    workspaceAfterMismatch = "fails";
    const { type, pressCreate, line } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();
    type("Harlow House");
    await pressCreate();

    expect(line()).toBe("“Harlow HQ” was already created — carry on, and change it in settings →");
  });

  it("(9) that line's link activates the pinned household and goes home, sending no second create", async () => {
    answers = ["lost", "mismatch"];
    sessionAfterLost = "absent";
    const { type, pressCreate, pressLink } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();
    type("Harlow House");
    await pressCreate();
    const pinned = creates()[0].household.id;

    await pressLink();

    const activations = commands.filter((command) => command.type === "household.activate");
    expect(activations).toEqual([{ type: "household.activate", householdId: pinned }]);
    expect(assigned).toHaveBeenCalledWith("/home");
    expect(creates(), "the link sends no further create").toHaveLength(2);
    expect(commands.at(-1).type, "activate comes after the last create").toBe("household.activate");
  });

  it("(10) a refusal in the server's own words shows those words", async () => {
    answers = ["refused"];
    const { type, pressCreate, refusal } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();

    expect(refusal()).toBe("That name is waiting to be restored");
  });

  it("(10) 'could not be created' only for a refusal with no words of its own", async () => {
    answers = ["bare"];
    const { type, pressCreate, line } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();

    expect(line()).toBe("“Harlow HQ” could not be created");
  });

  it("(11) a 502 after a create is a lost reply: when the session says it landed, goes home with no line", async () => {
    answers = ["gateway502"];
    sessionAfterLost = "landed";
    const { type, pressCreate, line } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();

    expect(requests.slice(requests.lastIndexOf("create") + 1), "the session is read once").toEqual(["session"]);
    expect(line(), "it landed: there is nothing to refuse").toBe("");
    expect(assigned).toHaveBeenCalledWith("/home");
    expect(creates()).toHaveLength(1);
  });

  it("(11) a 504 after a create is a lost reply: when the session says it did not land, says it wasn't created", async () => {
    answers = ["gateway504"];
    sessionAfterLost = "absent";
    const { type, pressCreate, line, busy } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();

    expect(requests.slice(requests.lastIndexOf("create") + 1), "the session is read once").toEqual(["session"]);
    expect(line()).toBe("“Harlow HQ” wasn't created — no answer came back. Try again");
    expect(assigned).not.toHaveBeenCalled();
    expect(busy()).toBe(false);
  });
});

describe("#1316 U3 follow-up: the carry-on link and reads that never answer", () => {
  /** Reaches the "already created" line: press 1 is lost, press 2 is refused as a mismatch. */
  async function reachCarryOnLine() {
    answers = ["lost", "mismatch"];
    sessionAfterLost = "absent";
    const card = await mountOnEmptyInstance();
    card.type("Harlow HQ");
    await card.pressCreate();
    card.type("Harlow House");
    await card.pressCreate();
    expect(card.line()).toBe("“Harlow HQ” was already created — carry on, and change it in settings →");
    return card;
  }

  for (const failure of /** @type {const} */ (["lost", "refused"])) {
    it(`(12) when household.activate is ${failure}, says it couldn't open it, keeps the link and frees the button`, async () => {
      const card = await reachCarryOnLine();
      activateAnswers = [failure, "ok"];
      await card.pressLink();

      expect(commands.filter((command) => command.type === "household.activate")).toHaveLength(1);
      expect(card.line()).toContain("couldn't open it — try again");
      expect(assigned).not.toHaveBeenCalled();
      expect(card.busy(), "the Create button is not left busy").toBe(false);

      /* The link is still there to press: the second press goes through. */
      await card.pressLink();
      expect(commands.filter((command) => command.type === "household.activate")).toHaveLength(2);
      expect(assigned).toHaveBeenCalledWith("/home");
      expect(creates(), "no further create is sent").toHaveLength(2);
    });
  }

  it("(13) a session read that never answers is given up on within 3 s: the honest unknown line, button free", async () => {
    answers = ["lost"];
    sessionAfterLost = "hangs";
    const { type, line, busy } = await mountOnEmptyInstance();
    type("Harlow HQ");

    vi.useFakeTimers();
    let finished = false;
    const pressed = Promise.resolve(newcomer.props.onsubmit()).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.slice(requests.lastIndexOf("create") + 1), "the read is out").toEqual(["session"]);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(100);
    void pressed; // not awaited: an unbounded read must fail the checks below, not hang the test

    expect(finished, "the press settled within 3 s of fake time").toBe(true);
    expect(line()).toBe("“Harlow HQ” may or may not have been created — Orbit can't be reached. Try again");
    expect(busy()).toBe(false);
    expect(assigned).not.toHaveBeenCalled();
  });

  it("(14) a workspace read that never answers after a 422 is given up on within 3 s: the first-sent name, button free", async () => {
    answers = ["lost", "mismatch"];
    sessionAfterLost = "absent";
    workspaceAfterMismatch = "hangs";
    const { type, pressCreate, line, busy } = await mountOnEmptyInstance();
    type("Harlow HQ");
    await pressCreate();
    type("Harlow House");

    vi.useFakeTimers();
    let finished = false;
    const pressed = Promise.resolve(newcomer.props.onsubmit()).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.at(-1), "the workspace read is out").toBe("workspace");
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(100);
    void pressed; // not awaited: an unbounded read must fail the checks below, not hang the test

    expect(finished, "the press settled within 3 s of fake time").toBe(true);
    expect(line()).toBe("“Harlow HQ” was already created — carry on, and change it in settings →");
    expect(busy()).toBe(false);
  });
});
