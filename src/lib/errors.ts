/**
 * Domain error classes, deliberately free of any runtime framework import
 * (ADR-0015 decision 1).
 *
 * Operator artifacts bundle domain modules that throw these — the
 * `end-maintenance` command in the bundled CLI is the first — and the bundle
 * must not link Next. `src/lib/app-error.ts` keeps `appErrorResponse`, the
 * Next mapping, and re-exports both classes so existing imports are
 * unaffected; domain modules that operator artifacts bundle import from here
 * directly.
 *
 * The boundary is enforced at the artifact rather than by convention: the CLI
 * bundles with `--external:next` and `scripts/bundle-orbit-cli.test.mjs`
 * fails if any `next` reference survives in the output.
 */

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * The bounded blocked-request contract of ADR-0013 decision 2 (#523).
 * Deliberately outside the `{ error: { code, message } }` envelope: the body
 * is the fixed `{"error":"maintenance_active"}` and never carries the
 * message, schedule or configuration.
 */
export class MaintenanceActiveError extends Error {
  constructor(public readonly expectedEndAt: Date | null) {
    super("Orbit is in maintenance");
    this.name = "MaintenanceActiveError";
  }
}
