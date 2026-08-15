/**
 * What the observatory shows until it is wired to the server.
 *
 * `GET /api/admin/operations` already serves this screen — delivery and
 * document-job counts, recent deliveries with their channel, status and
 * attempt count, scheduler and scanner state. Mapping that payload onto these
 * rows needs an instance-administrator session to verify against, which means
 * the acceptance stack rather than a local build, so it is done as its own
 * step rather than guessed at here.
 *
 * The values are the mockup's own, so the screen renders exactly as designed
 * and the fidelity gate measures the port rather than the placeholder. The
 * tone is a theme token name — `ok`, `warm`, `overdue` — which is what the
 * mockup writes inline on each row's dot.
 */
export const operationsFixture = {
  state: [
    { tone: "ok", name: "application", detail: "ready · uptime 41d" },
    {
      tone: "warm",
      name: "malware scanner",
      detail: "unreachable · scan-required uploads deferred",
    },
    { tone: "ok", name: "scheduler", detail: "lease held · last sweep 12s" },
  ],
  deliveries: [
    { tone: "ok", name: "reminder · email", detail: "delivered · 08:14" },
    { tone: "ok", name: "reminder · push", detail: "delivered · 08:14" },
    { tone: "overdue", name: "reminder · email", detail: "failed · attempt 3 of 5" },
  ],
};
