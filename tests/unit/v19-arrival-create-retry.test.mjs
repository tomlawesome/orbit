// @vitest-environment happy-dom
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1316 (GAP-U1): the first-run create must survive a lost reply. The create
 * lands but the answer is lost (a network blip), the browser says
 * "Failed to fetch", and the person presses Create again. Each press used to
 * mint a fresh household id, so the retry made a second household. The id is
 * the idempotency key (the server replays a repeat of the same id): Arrival
 * keeps ONE id for the form until the create succeeds or the name changes, and
 * the refusal line is Orbit's own words, never the browser's.
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
/** Answers to household.create, in order; the last one repeats. @type {("lost" | "refused")[]} */
let answers = [];

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function stubFetch() {
  commands = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return json({ user: { id: "u1" }, csrfToken: "t1" });
    if (href.endsWith("/api/workspace") && !init?.method) {
      return json({ workspace: { households: [], visibleHouseholds: [] } });
    }
    if (href.includes("/api/workspace/commands") && init?.method === "POST") {
      commands.push(JSON.parse(String(init.body)));
      const answer = answers[Math.min(commands.length, answers.length) - 1];
      if (answer === "lost") throw new TypeError("Failed to fetch");
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
beforeEach(() => {
  vi.resetModules();
  document.body.className = "";
  document.body.innerHTML = "";
  sessionStorage.clear();
  answers = [];
  stubFetch();
});
afterEach(() => {
  unmountArrival?.();
  unmountArrival = null;
  newcomer.props = null;
  vi.unstubAllGlobals();
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
  return { type, pressCreate, refusal };
}

describe("#1316 GAP-U1: pressing Create again after a lost reply", () => {
  it("sends the same household id both times, and says it could not be created rather than 'Failed to fetch'", async () => {
    answers = ["lost"];
    const { type, pressCreate, refusal } = await mountOnEmptyInstance();
    type("Harlow Home");

    await pressCreate();
    expect(commands, "the first Create was sent").toHaveLength(1);
    expect(refusal(), "a network failure is not the server's words").toBe("could not be created");
    expect(refusal()).not.toMatch(/failed to fetch/iu);

    await pressCreate();
    expect(commands, "the second Create was sent").toHaveLength(2);
    expect(commands[0].household.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(commands[1].household.id, "the retry carries the same id, so the server can replay it").toBe(commands[0].household.id);
  });

  it("keeps the same id across a refusal in the server's words as well", async () => {
    answers = ["refused"];
    const { type, pressCreate, refusal } = await mountOnEmptyInstance();
    type("Harlow Home");

    await pressCreate();
    expect(refusal()).toBe("That name is waiting to be restored");
    await pressCreate();

    expect(commands).toHaveLength(2);
    expect(commands[1].household.id).toBe(commands[0].household.id);
  });

  it("takes a new id once the name changes: a different name is a different household", async () => {
    answers = ["lost"];
    const { type, pressCreate } = await mountOnEmptyInstance();
    type("Harlow Home");
    await pressCreate();
    type("Seaside Cottage");
    await pressCreate();

    expect(commands).toHaveLength(2);
    expect(commands[1].household.name).toBe("Seaside Cottage");
    expect(commands[1].household.id).not.toBe(commands[0].household.id);
  });
});
