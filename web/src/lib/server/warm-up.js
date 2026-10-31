/**
 * The start-up warm-up (#1575): once the server is listening, it sends itself
 * three requests and loads every route module, so the first reader after a
 * restart does not pay for the once-per-process work.
 *
 * The three requests are open routes only, sent with no cookie: they run the
 * shared render and page-data path without getting round the session gate.
 * Nothing here throws, and `init` does not wait for it; readiness never
 * depends on it.
 */

const POLL_MS = 50;
const PROBE_MS = 1_000;
const GIVE_UP_MS = 15_000;
const DEADLINE_MS = 20_000;
const WARM_PATHS = ["/__data.json", "/", "/api/auth/session"];
const HEADERS = { "user-agent": "orbit-warm-up" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {number} options.port the listening port; anything else skips the task
 * @param {string} options.host the address to dial
 * @param {Array<() => Promise<unknown>>} options.loaders the route modules' importers
 * @param {typeof fetch} [options.fetch]
 * @param {{ debug: Function, info: Function }} options.log
 * @returns {Promise<void>} never rejects
 */
export async function warmUp({ port, host, loaders, fetch = globalThis.fetch, log }) {
  if (typeof port !== "number" || !Number.isFinite(port)) return;

  const startedAt = Date.now();
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  let stopped = false;
  let timer;

  const discard = (response) => response?.body?.cancel().catch(() => {});
  const skipped = () => {
    log.debug({
      event: "application.startup",
      state: "degraded",
      reason: "unexpected_failure",
      action: "none",
      impact: "none",
    });
  };

  async function task() {
    // Any HTTP answer, a 503 included, means the server is listening.
    while (!stopped) {
      if (Date.now() - startedAt >= GIVE_UP_MS) return;
      try {
        const response = await fetch(`${base}/api/health`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(PROBE_MS),
        });
        await discard(response);
        break;
      } catch {
        await sleep(POLL_MS);
      }
    }

    for (const load of loaders) {
      if (stopped) return;
      try {
        await load();
      } catch {
        skipped();
      }
    }

    for (const path of WARM_PATHS) {
      if (stopped) return;
      try {
        const response = await fetch(`${base}${path}`, { headers: HEADERS });
        await response?.arrayBuffer?.();
      } catch {
        skipped();
      }
    }
    if (stopped) return;

    log.info({
      event: "application.startup",
      state: "completed",
      action: "none",
      impact: "none",
      durationMs: Date.now() - startedAt,
    });
  }

  try {
    await Promise.race([
      task(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, DEADLINE_MS - (Date.now() - startedAt));
      }),
    ]);
  } catch {
    /* a courtesy: the first reader pays for whatever was not warmed */
  } finally {
    stopped = true;
    clearTimeout(timer);
  }
}
