import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
import { GATE_HOOK_TIMEOUT_MS, enterSpecFile, leaveSpecFile } from "./reset-gate";

/**
 * #1077: the acceptance stack's database goes back to its seed between spec
 * files, so a spec's list lengths never depend on what ran before it.
 *
 * The fault this closes is not cross-pipeline pollution -- `smoke` stands its
 * own stack up and tears it down with `down --volumes` in the same job, so
 * every run starts empty. The growth happens INSIDE one run: one stack serves
 * all ~196 specs for twelve or thirteen minutes, specs create households,
 * items, sessions and documents as they go, and the lists the keyboard
 * tab-order tests walk get longer the later a spec lands in the ordering.
 * `tabTo`'s 60-press cap is then exhausted by whichever list crossed it first,
 * which is why the failing test kept moving between runs.
 *
 * WHY A RESET AND NOT PER-SPEC CLEANUP. `support/households.ts` (#730) is the
 * cleanup shape, and it records its own near-miss: the largest leak in the
 * suite was invisible to the first pass because `authenticated-lifecycle`
 * created households through the INTERFACE and never called the helper, so a
 * grep for the command could not see it. Cleanup is a discipline every new
 * spec has to remember; a reset is a guarantee that holds whatever a spec
 * does, including the shapes nobody has written yet. #730's cleanup stays --
 * it is redundant in the happy path now, but it is still the thing that fails
 * loudly when a household outlives its test.
 *
 * NO LONGER SAFE BY SERIALITY (#1080). This helper was written when
 * tests/e2e/playwright.config.ts pinned `workers: 1` everywhere, and said so:
 * with one worker there is no concurrent worker whose rows a restore could
 * pull out from under a running test. #1080 removed that pin, so the restore
 * now needs a moment at which it is provably alone. The gate in
 * tests/e2e/support/reset-gate.ts is that moment, and the long comment at the
 * top of it is the argument for the shape it takes.
 *
 * With one worker -- the local-only profile, and any `--spec`
 * run -- the gate is transparent and this file still resets between every pair
 * of spec files, exactly as #1077 wrote it.
 *
 * THE DATABASE, NOT THE STACK. `compose down`/`up` per file would cost a
 * stack start each -- a minute or more, twenty-five times over -- and would
 * be far worse than the problem. Truncate-and-restore against a near-empty
 * database is milliseconds; the `docker exec` around it is the expensive
 * half, and that is roughly a tenth of a second.
 *
 * LOUD ON FAILURE, for the reason households.ts gives: a silent reset is
 * worse than none, because the suite stays green while the growth it was
 * meant to stop carries on. `ON_ERROR_STOP=1` makes psql exit non-zero on
 * the first failed statement, `execFileSync` turns that into a throw, and
 * the restore verifies itself row-for-row against the seed before it returns.
 */

/** The schema holding the copy of `public` taken once the stack is seeded. */
const SEED_SCHEMA = "e2e_seed";

/**
 * The stack's own database, reached the way `support/bootstrap.ts` reaches
 * its log: `COMPOSE_PROJECT_NAME` is exported by scripts/test-e2e-local.sh
 * and unset in CI, which runs the stack without `-p`. The compose file
 * declares ORBIT_IMAGE as required and is parsed even for `ps`, so a
 * placeholder is supplied exactly as that helper does.
 */
function composeCapture(args: string[]): string {
  const project = process.env.COMPOSE_PROJECT_NAME;
  return execFileSync(
    "docker",
    [
      "compose",
      ...(project ? ["-p", project] : []),
      "--env-file", ".env-orbit", "-f", "docker-compose.yml",
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, ORBIT_IMAGE: process.env.ORBIT_IMAGE ?? "orbit-local:000000000000" },
    },
  );
}

/**
 * Resolved once per worker and then reused. `docker compose exec` re-parses
 * the compose file on every call, which is the whole cost of a reset; asking
 * Compose for the container id once and using plain `docker exec` after that
 * takes a reset from roughly a second to roughly a tenth of one.
 */
let container: string | null = null;
function databaseContainer(): string {
  if (container) return container;
  const resolved = composeCapture(["ps", "-q", "orbit-db"]).trim().split("\n")[0]?.trim();
  if (!resolved) throw new Error("#1077: no orbit-db container for this stack -- is it up?");
  container = resolved;
  return container;
}

/**
 * Runs SQL as the database's own superuser over the container's unix socket,
 * which is how scripts/test-e2e-local.sh's own documented fixture query
 * reaches it. The credentials are the container's own environment, so nothing
 * here carries or needs a password.
 */
function runSql(statements: string): string {
  return execFileSync(
    "docker",
    [
      "exec", "-i", databaseContainer(),
      "sh", "-c",
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -t -A -f -',
    ],
    { input: statements, encoding: "utf8", timeout: 120_000 },
  );
}

/**
 * Cached once it is true, and only then: a seed schema is never dropped
 * during a run, so a positive answer cannot go stale, while a negative one
 * becomes positive the moment claim.setup.ts runs. Without this every reset
 * would pay for two `docker exec` round trips instead of one, which on fifty
 * of them is most of the cost.
 */
let seeded = false;
function snapshotExists(): boolean {
  if (seeded) return true;
  const answer = runSql(
    `select count(*) from information_schema.schemata where schema_name = '${SEED_SCHEMA}';`,
  );
  seeded = answer.trim() !== "0";
  return seeded;
}

/**
 * Copies `public` into the seed schema, once. Called at the end of
 * tests/e2e/claim.setup.ts, so the seed is exactly the state the suite
 * assumes every spec starts from: the instance claimed, the first
 * administrator and their provider identity present, and the metadata key
 * that every encrypted account address is sealed under.
 *
 * Deliberately a no-op when a snapshot is already there. `--reuse PROJECT`
 * (#947) runs against a stack a prior `--keep` run left up, and that stack's
 * seed is the clean one taken before anything ran -- re-taking it here would
 * capture whatever the previous run left behind and call that the baseline.
 */
export function captureDatabaseSeed(): void {
  if (snapshotExists()) return;
  seeded = true;
  runSql(`
    do $capture$
    declare entry record;
    begin
      create schema ${SEED_SCHEMA};
      for entry in select tablename from pg_tables where schemaname = 'public' loop
        execute format('create table ${SEED_SCHEMA}.%I as table public.%I', entry.tablename, entry.tablename);
      end loop;
    end
    $capture$;
  `);
}

/**
 * Puts `public` back to the seed: truncate every table, then copy the seed
 * rows back into it.
 *
 * `session_replication_role = replica` is set for the restore alone, because
 * the rows go back table by table rather than in foreign-key order and a
 * membership would otherwise be refused for naming a household that has not
 * been copied back yet. It is a session setting on this one psql connection,
 * so nothing the application does is affected by it.
 *
 * A table the seed has never heard of is emptied and left empty, rather than
 * the whole reset refusing. That can only arise under `--reuse` (#947),
 * against a stack whose seed was taken before a migration added the table;
 * inside one run every migration has already run before anything is seeded.
 *
 * Then it checks its own work. Every public table must hold exactly the row
 * count its seed copy does, or this raises -- the restore reporting success
 * while leaving rows behind is the silent failure this whole helper exists
 * to prevent.
 */
export function resetDatabaseToSeed(): void {
  runSql(`
    set session_replication_role = replica;
    do $reset$
    declare
      entry record;
      targets text;
      in_seed bigint;
      in_public bigint;
      drift text := '';
    begin
      if not exists (select 1 from information_schema.schemata where schema_name = '${SEED_SCHEMA}') then
        raise exception '#1077: no ${SEED_SCHEMA} snapshot to restore -- tests/e2e/claim.setup.ts takes it';
      end if;

      select string_agg(format('public.%I', tablename), ', ')
        into targets from pg_tables where schemaname = 'public';
      execute 'truncate table ' || targets || ' cascade';

      for entry in select tablename from pg_tables where schemaname = 'public' loop
        if to_regclass('${SEED_SCHEMA}.' || quote_ident(entry.tablename)) is not null then
          execute format('insert into public.%I select * from ${SEED_SCHEMA}.%I', entry.tablename, entry.tablename);
        end if;
      end loop;

      for entry in select tablename from pg_tables where schemaname = 'public' loop
        if to_regclass('${SEED_SCHEMA}.' || quote_ident(entry.tablename)) is null then continue; end if;
        execute format('select count(*) from ${SEED_SCHEMA}.%I', entry.tablename) into in_seed;
        execute format('select count(*) from public.%I', entry.tablename) into in_public;
        if in_seed <> in_public then
          drift := drift || format('%s: seed %s, restored %s; ', entry.tablename, in_seed, in_public);
        end if;
      end loop;
      if drift <> '' then
        raise exception '#1077: the database did not come back to its seed -- %', drift;
      end if;
    end
    $reset$;
  `);
}

/**
 * How far above its seed one table may grow before a reset is due (#1080).
 *
 * This is the invariant #1077 was defending, said out loud. Its fault was a
 * list that grew until `tabTo`'s 60-press cap could not reach the end of it,
 * so what has to be bounded is list length, and every list in the suite is
 * one table's rows. Twenty is comfortably inside sixty for a screen that also
 * has chrome to tab through, and well under the 113 sessions and 168 rows
 * docs/flakes.md watched a run reach.
 *
 * Two tables are allowed more, each for a stated reason. Nothing else gets an
 * entry without one: a table quietly given a larger budget is the growth
 * coming back.
 */
const DEFAULT_ROW_BUDGET = 20;
const ROW_BUDGETS: Record<string, number> = {
  /* Not a list anybody walks. The activity feed reads it through a bounded,
     household-filtered, createdAt-descending query (src/db/schema.ts's
     `audit_household_activity_idx` exists for exactly that read), so its
     length reaches no screen's tab order. It grows about seven rows per spec
     file, and a budget of twenty here would mean a reset every third file. */
  audit_log: 300,
  /* The sessions list is per reader, not instance-wide
     (src/lib/auth/session.ts lists `where(eq(sessions.userId, userId))`), and
     since #1080 each worker reads it as its own identity -- so the instance
     total is shared out between the live workers and no single reader sees
     all of it. Forty instance-wide keeps every reader inside the cap. */
  sessions: 40,
};

/**
 * The table furthest above its seed, and by how much, in one round trip.
 *
 * `query_to_xml` is how a single statement can count every table without
 * knowing their names: it runs the generated query and returns its one row as
 * XML, which `xpath` reads back out. The alternative is a `do` block, and a
 * `do` block cannot return anything.
 *
 * A table the seed has never heard of counts as entirely excess, which is the
 * right answer: under `--reuse` (#947) that is a table a migration added after
 * the seed was taken, and its rows are all growth.
 */
function worstExcess(): { table: string; excess: number } | null {
  const answer = runSql(`
    select t.tablename,
           (xpath('/row/n/text()',
                  query_to_xml(format('select count(*) as n from public.%I', t.tablename),
                               false, true, '')))[1]::text::bigint
         - case when to_regclass('${SEED_SCHEMA}.' || quote_ident(t.tablename)) is null then 0
                else (xpath('/row/n/text()',
                            query_to_xml(format('select count(*) as n from ${SEED_SCHEMA}.%I', t.tablename),
                                         false, true, '')))[1]::text::bigint
           end as excess
      from pg_tables t
     where t.schemaname = 'public'
     order by 2 desc;
  `);

  let worst: { table: string; excess: number } | null = null;
  for (const line of answer.split("\n")) {
    const [table, excess] = line.split("|");
    if (!table || excess === undefined) continue;
    const over = Number(excess) - (ROW_BUDGETS[table] ?? DEFAULT_ROW_BUDGET);
    if (over > 0 && (!worst || over > worst.excess)) worst = { table, excess: Number(excess) };
  }
  return worst;
}

/**
 * Registers the reset as the FIRST `beforeAll` of the spec file that calls
 * it, which is why it is a call at the top of the file rather than something
 * imported for its side effect. Playwright runs a file's `beforeAll` hooks in
 * the order they were registered, so this has to be registered before the
 * spec registers its own -- otherwise the reset would wipe the fixtures the
 * file's own setup had just made. Registering it from a module's top level
 * cannot work: the module is evaluated once per worker process and the hook
 * would attach to whichever file that worker happened to load first.
 *
 * It also registers the matching `afterAll`, which is why the pair is one
 * call. Declared first, that hook runs BEFORE the spec's own cleanup, so it
 * does not release this worker outright -- it marks it as tearing down, which
 * still holds the gate shut (tests/e2e/support/reset-gate.ts). #730's
 * household sweep runs in that window and still needs its session.
 *
 * Absent snapshot is a no-op, and says so. That is the local-only profile
 * (`--profile local-only`, CI's `smoke_local_only`): it has no identity
 * provider, claim.setup.ts skips itself there, and tests/e2e/local-sign-in.spec.ts
 * IS the claim journey -- it asserts the instance is still unclaimed when it
 * starts, so there is deliberately nothing to restore.
 */
export function resetDatabaseBetweenSpecFiles(): void {
  test.beforeAll(async () => {
    if (!snapshotExists()) {
      console.log("#1077: no database seed on this stack (local-only profile); leaving it as found");
      return;
    }
    /* The gate's wait is not this spec's own time and must not be charged to
       it: a worker waits for the longest file still running, which at four
       workers was measured at fifty seconds, and the ordinary 60s hook budget
       failed four spec files that way. Raised only where there is something
       to wait for, so a single-worker run keeps the ordinary budget and a
       hook that genuinely hangs there still fails in a minute. */
    if (test.info().config.workers > 1) test.setTimeout(GATE_HOOK_TIMEOUT_MS);

    await enterSpecFile({
      /* The configured count, not how many Playwright happens to have
         started: a worker that is alone only because the others have not
         spun up yet must still take the gate. */
      workers: test.info().config.workers,
      overBudget: () => {
        const worst = worstExcess();
        return worst ? `${worst.table} is ${worst.excess} rows above its seed` : null;
      },
      /* Timed out loud, because the whole case for a reset over per-spec
         cleanup rests on it being cheap: a run whose resets have quietly
         grown to seconds each is a different trade-off, and this is where
         that shows up rather than in the total. */
      reset: () => {
        const started = Date.now();
        resetDatabaseToSeed();
        console.log(`#1077: database back to its seed in ${Date.now() - started}ms`);
      },
    });
  });

  test.afterAll(async () => {
    if (!snapshotExists() || test.info().config.workers <= 1) return;
    leaveSpecFile();
  });
}

/**
 * The one spec file that must NOT reset, and why. `bootstrap-protection.spec.ts`
 * is the only subject that needs the state BEFORE the claim, so restoring a
 * seed taken after it would destroy the precondition it exists to prove; it
 * also runs first, in its own Playwright project, with nothing ahead of it to
 * have left anything behind.
 */
const RESETS_NOTHING = new Set(["bootstrap-protection.spec.ts"]);

/**
 * Proves every spec file actually asks for the reset, rather than trusting
 * that whoever writes the next one remembers.
 *
 * This is the difference between a guarantee and a discipline, and the whole
 * reason #1077 chose a reset over per-spec cleanup. `support/households.ts`
 * records what a discipline is worth: the largest leak in the suite was
 * invisible because one spec created its fixtures in a shape the helper never
 * saw. A reset that a new file can silently opt out of would be the same
 * trap wearing different clothes.
 *
 * Called from claim.setup.ts, which runs once ahead of every browser project,
 * so a file that forgot fails the run at the start with its own name in the
 * message rather than as somebody else's tab-order test twenty minutes later.
 *
 * `suite` is the directory to read, handed in rather than worked out here.
 * Playwright transpiles these files to CommonJS, where `import.meta` is a
 * syntax error that takes down every spec that imports this module -- so the
 * caller, which is a test and therefore knows its own path from
 * `test.info().file`, says where the suite is.
 */
export function assertEverySpecFileResets(suite: string): void {
  const missing = readdirSync(suite)
    .filter((name) => name.endsWith(".spec.ts") && !RESETS_NOTHING.has(name))
    .filter((name) => !readFileSync(join(suite, name), "utf8").includes("resetDatabaseBetweenSpecFiles()"));

  if (missing.length > 0) {
    throw new Error(
      `#1077: ${missing.length} spec file(s) never put the database back to its seed, so whatever they `
      + "leave behind lengthens the lists every later spec walks. Add "
      + `resetDatabaseBetweenSpecFiles() below the imports:\n  ${missing.join("\n  ")}`,
    );
  }
}
