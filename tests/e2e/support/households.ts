import type { Page } from "@playwright/test";

/**
 * #730: a spec's households must not survive into other specs' runs.
 *
 * Every e2e spec creates its households in one shared instance, so anything
 * left behind joins the next spec's sky. That is not untidiness: since #711
 * `placeGalaxy` caps the drawn sky at the measured capacity and marks the
 * overflow undrawn, so inherited fixtures can push a spec's OWN household out
 * of the drawn set and the spec then fails looking for a card the product
 * deliberately did not draw.
 *
 * The mechanism chosen is per-spec cleanup (the issue left it to the
 * implementer). Six specs already did this correctly with their own private
 * copy of the same two calls; this is that pattern, once, so a new spec gets
 * it by importing rather than by remembering.
 *
 * Cleanup is LOUD on failure. A silent cleanup is worse than none: the suite
 * stays green while the leak it was meant to stop carries on.
 */

/** The Origin and CSRF pair every mutating request in the suite needs. */
export async function sessionHeaders(page: Page) {
  const response = await page.request.get("/api/auth/session");
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return { Origin: new URL(page.url()).origin, "X-CSRF-Token": csrfToken };
}

/**
 * Remove one household for good: schedule the deletion, then hard-delete it.
 *
 * A 404 on either call means it is already gone, which is success -- specs
 * legitimately delete their own fixtures as the thing under test. A 409 on the
 * schedule means one is already scheduled, so the hard delete still applies.
 * Anything else throws, because a cleanup that swallows its own failure is how
 * this leak survived in the first place.
 */
export async function cleanupHousehold(
  page: Page,
  headers: Record<string, string>,
  householdId: string,
  name: string,
) {
  const url = `/api/households/${householdId}/lifecycle`;

  const schedule = await page.request.post(url, { headers, data: { action: "delete", confirmation: name } });
  if (schedule.status() === 404) return;
  if (!schedule.ok() && schedule.status() !== 409) {
    throw new Error(`Could not schedule cleanup of "${name}" (${schedule.status()})`);
  }

  const remove = await page.request.post(url, { headers, data: { action: "hard_delete", confirmation: name } });
  if (remove.status() !== 404 && !remove.ok()) {
    throw new Error(`Could not remove "${name}" (${remove.status()})`);
  }
}

/**
 * A spec's own register of what it made, swept in one call.
 *
 * Specs create households in several shapes -- through the seam, through
 * `page.evaluate`, through the arrival's own contract -- so the register takes
 * the id and name rather than trying to wrap creation itself.
 *
 * Some create them through the INTERFACE and never learn an id at all
 * (`authenticated-lifecycle.spec.ts` fills in the setup dialog). Those use
 * `sweepNamed` below, which looks the ids up. That spec was the largest leak
 * in the suite and was missed by the first pass precisely because it does not
 * call `household.create`: a grep for the command could not see it.
 *
 * `sweep` removes every household in reverse order of creation and clears the
 * register, so a second call after a partial failure retries only what is
 * left. It reports every failure it hit rather than the first, because one
 * spec's leak usually means several.
 */
export function householdRegister() {
  const created: { id: string; name: string }[] = [];

  return {
    /** Record a household so the sweep will remove it. Returns it unchanged. */
    track<T extends { id: string; name: string }>(household: T): T {
      created.push({ id: household.id, name: household.name });
      return household;
    },

    /** Remove everything recorded. Safe to call twice; safe to call on none. */
    async sweep(page: Page) {
      if (created.length === 0) return;
      const headers = await sessionHeaders(page);
      const failures: string[] = [];

      for (const household of [...created].reverse()) {
        try {
          await cleanupHousehold(page, headers, household.id, household.name);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }

      created.length = 0;
      if (failures.length > 0) {
        throw new Error(`#730: ${failures.length} household(s) left behind:\n  ${failures.join("\n  ")}`);
      }
    },
  };
}

/**
 * Remove households by NAME, for specs that made them through the interface
 * and so never held an id.
 *
 * `page` must belong to an instance administrator: a hard delete is an
 * administrator's power, and the member who created these through the setup
 * dialog cannot do it. Names not present are ignored -- the test may already
 * have deleted them as the thing it was proving.
 */
export async function sweepNamed(page: Page, names: readonly string[]) {
  if (names.length === 0) return;

  const wanted = new Set(names);
  const response = await page.request.get("/api/workspace");
  if (!response.ok()) throw new Error(`#730: could not read the workspace to sweep by name (${response.status()})`);
  const { workspace } = (await response.json()) as { workspace: { households: { id: string; name: string }[] } };

  const headers = await sessionHeaders(page);
  const failures: string[] = [];
  for (const household of workspace.households.filter((one) => wanted.has(one.name))) {
    try {
      await cleanupHousehold(page, headers, household.id, household.name);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (failures.length > 0) {
    throw new Error(`#730: ${failures.length} household(s) left behind:\n  ${failures.join("\n  ")}`);
  }
}
