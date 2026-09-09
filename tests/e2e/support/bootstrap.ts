import { execFileSync } from "node:child_process";
import { expect, type Browser, type Page } from "@playwright/test";

/**
 * Claiming the instance, the way an operator does (ADR-0022).
 *
 * The first sign-in no longer promotes anyone: an unclaimed instance refuses
 * to start a provider sign-in at all, and the only way in is the code the
 * container prints as the last line of its own start-up log. So the specs
 * that used to race for the promotion with a bare `establishInstanceAdmin`
 * now read that notice, POST the code, and complete the claim as
 * "Orbit Administrator" — deterministically, once per stack, through exactly
 * the path an operator walks. No test-only hook goes into the shipped image.
 *
 * Idempotent, because the database is not reset between specs
 * (v19-arrival.spec.ts) and CI retries whole files: an already-claimed
 * instance simply signs the administrator in, and a claimant that loses a
 * race is told `bootstrap_claimed` and does the same.
 */
const ADMINISTRATOR = "Orbit Administrator";

/**
 * The stack's own log, the way `v19-tour.spec.ts` asks the stack its other
 * questions. `COMPOSE_PROJECT_NAME` is exported by scripts/test-e2e-local.sh
 * and unset in CI, which runs the stack without `-p`; the compose file
 * declares ORBIT_IMAGE as required and is parsed even for `logs`, so a
 * placeholder is supplied exactly as the workflow's diagnostics step does.
 */
export function stackLog(): string {
  const project = process.env.COMPOSE_PROJECT_NAME;
  return execFileSync(
    "docker",
    [
      "compose",
      ...(project ? ["-p", project] : []),
      "--env-file", ".env-orbit", "-f", "docker-compose.yml",
      "logs", "--no-color", "orbit-app",
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ORBIT_IMAGE: process.env.ORBIT_IMAGE ?? "orbit-local:000000000000" },
    },
  );
}

/**
 * The LAST code the log carries, because a restarted container prints a new
 * one and the old one died with the old process. One expression covers both
 * renderings of the notice: the text form's link line and the
 * `ORBIT_LOG_FORMAT=json` object's `url`, which carry the same fragment.
 */
export function claimCodeFromLog(log: string): string | undefined {
  const matches = [...log.matchAll(/#claim=([A-Z2-7]{1,4}(?:-[A-Z2-7]{1,4})*)/gu)];
  return matches.at(-1)?.[1];
}

async function isClaimed(page: Page): Promise<boolean> {
  const response = await page.request.get("/api/auth/availability");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { claimed: boolean }).claimed;
}

/** Posts the code from the page itself, so the browser keeps the claim cookie. */
async function presentClaim(page: Page, code: string): Promise<number> {
  await page.goto("/login");
  return page.evaluate(async (claim) => {
    const response = await fetch("/api/auth/bootstrap/claim", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim }),
    });
    return response.status;
  }, code);
}

export interface ClaimOptions {
  /** Anything the caller needs from the administrator's own signed-in page. */
  afterSignIn?: (page: Page) => Promise<void>;
}

export async function claimInstanceAsAdministrator(browser: Browser, options: ClaimOptions = {}): Promise<void> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    if (!(await isClaimed(page))) {
      const code = claimCodeFromLog(stackLog());
      if (!code) throw new Error("no claim notice in the stack's log: has orbit-app started?");
      const status = await presentClaim(page, code);
      // 409 is a claimant that lost the race; the instance is claimed either
      // way, and the sign-in below is the same from here on.
      if (status !== 200 && status !== 409) {
        throw new Error(`the claim was refused with HTTP ${status}`);
      }
    }

    await page.goto("/api/auth/login?returnTo=/home");
    await page.getByRole("link", { name: ADMINISTRATOR }).click();
    /* Not a fixed destination: #840 sends a session with no household of its
       own to the arrival at `/` rather than to returnTo. Only the session
       matters here, and every request after this one carries it. */
    const session = await page.request.get("/api/auth/session");
    expect(session.ok()).toBe(true);
    await options.afterSignIn?.(page);
  } finally {
    await context.close();
  }
}
