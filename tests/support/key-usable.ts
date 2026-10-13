/**
 * The unit suite's baseline encryption key verdict (#1405).
 *
 * Nothing in this suite boots the server, so the startup key self-test never
 * runs and the verdict would read "unknown", which every gate treats as
 * closed: every route test built on the `api()` wrapper would then answer 503
 * for a reason that has nothing to do with it. So each test file starts with
 * a usable key, as tests/integration/support/fixtures.ts does for the
 * integration suite; a file about the key sets its own verdict.
 *
 * Written straight onto the process slot `src/server/key-state.ts` reads,
 * rather than through that module, because importing it here would load it
 * (and the database module it imports) before a test file's own `vi.mock`
 * calls could replace them.
 */
const KEY_STATE = Symbol.for("orbit.encryption-key-state");

(globalThis as Record<symbol, unknown>)[KEY_STATE] = { verdict: "usable", heldKeyId: "0".repeat(24) };
