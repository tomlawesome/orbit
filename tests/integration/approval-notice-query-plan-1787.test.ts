/**
 * #1787: the approval-notice queries (the worker's due-notice lookup and the
 * document-health pending count) must reach audit_log through an index, never
 * a scan of the whole table. Seeds a small audit_log across many households
 * and entity types, a few hundred of them reviewed_intake_notice rows tied to
 * receipts with a mix of statuses, runs ANALYZE, then reads the planner's
 * EXPLAIN (FORMAT JSON) for each query exactly as the app builds it.
 *
 * Why a small table proves the large-table property: on 20,000 rows the
 * planner may legitimately prefer a Seq Scan (or a whole-index bitmap scan by
 * entity_type), so each EXPLAIN runs with seqscan, bitmap scans, hash joins and
 * merge joins switched off with `SET LOCAL`. That only makes those plans very
 * costly, it does not forbid them: when no index can serve the query's filter,
 * the planner still falls back to a Seq Scan (or a whole-index scan). So an
 * Index Scan whose condition starts at household_id means an index exists that
 * can serve the query's lookup, and it serves it at any table size.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb, getDatabaseClient } from "@/db";
import { APPROVAL_NOTICE_ENTITY, dueNoticesQuery } from "@/server/mail-in/approval-notice";
import { pendingNoticeCountQuery } from "@/server/document-health";
import { cleanupIntegrationEnvironment } from "./support/fixtures";

const HOUSEHOLDS = 200;
const AUDIT_ROWS = 20_000;
const NOTICES = 300;

interface PlanNode { "Node Type"?: string; "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string; Plans?: PlanNode[] }

/** Every node of the plan tree, depth first. */
function walk(node: PlanNode, into: PlanNode[] = []): PlanNode[] {
  into.push(node);
  for (const child of node.Plans ?? []) walk(child, into);
  return into;
}

async function explain(query: { toSQL(): { sql: string; params: unknown[] } }): Promise<PlanNode[]> {
  const { sql: text, params } = query.toSQL();
  const rows = await getDatabaseClient().begin(async (transaction) => {
    for (const setting of ["enable_seqscan", "enable_bitmapscan", "enable_hashjoin", "enable_mergejoin"]) {
      await transaction.unsafe(`set local ${setting} = off`);
    }
    return transaction.unsafe(`explain (format json) ${text}`, params as never[]);
  });
  const plan = (rows[0] as Record<string, Array<{ Plan: PlanNode }>>)["QUERY PLAN"]![0]!.Plan;
  return walk(plan);
}

function auditScans(nodes: PlanNode[]): PlanNode[] {
  return nodes.filter((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "audit_log");
}

/**
 * An index on audit_log serves the query when a node reads it through an
 * Index Cond that starts at the index's leading column, household_id. A scan of
 * a whole index with only entity_type in its condition (seqscan off turns an
 * entity_type-only filter into exactly that) does not count: it reads every
 * entry, as a Seq Scan would.
 */
function usesAuditIndex(nodes: PlanNode[]): boolean {
  return nodes.some((node) => typeof node["Index Name"] === "string" && node["Index Name"].startsWith("audit_")
    && /household_id/.test(node["Index Cond"] ?? ""));
}

beforeAll(async () => {
  const db = getDb();
  const tag = randomUUID().slice(0, 8);
  await db.execute(sql`create temp table plan_households_1787 (n int, id uuid)`);
  await db.execute(sql`
    insert into households (id, name)
    select gen_random_uuid(), ${"plan-1787-" + tag} || '-' || g from generate_series(1, ${HOUSEHOLDS}) g`);
  await db.execute(sql`
    insert into plan_households_1787
    select row_number() over (), id from households where name like ${"plan-1787-" + tag + "-%"}`);

  // Receipts across the households, a mix of statuses.
  await db.execute(sql`
    insert into imap_ingestion_messages
      (id, mailbox, mailbox_uid_validity, mailbox_uid, content_sha256, recipient_alias_sha256, household_id, status, expires_at, receipt_status)
    select gen_random_uuid(), 'private', ${"plan-" + tag}, g, md5(g::text || ${tag}), md5(g::text), h.id,
      (array['pending_review','approving','recoverable','completed','discarded','expired'])[1 + g % 6]::imap_ingestion_status,
      now() + interval '1 day', 'pending'
    from generate_series(1, ${NOTICES}) g
    join plan_households_1787 h on h.n = 1 + (g * 7) % ${HOUSEHOLDS}`);

  // The bulk of the log: other entity types, many households. Ids and
  // households ascend with g, so the three btrees fill append-style (random
  // uuids made this insert twice as slow); the planner statistics are unaffected.
  await db.execute(sql`
    insert into audit_log (id, household_id, entity_type, entity_id, action, changes, created_at)
    select lpad(to_hex(g), 32, '0')::uuid, (select array_agg(id order by n) from plan_households_1787)[1 + (g - 1) / ${AUDIT_ROWS / HOUSEHOLDS}],
      (array['item','document','section','metadata_key','household','member','export','receipt'])[1 + g % 8],
      lpad(to_hex(g::bigint * 7919), 32, '0')::uuid, 'update', '{"field":"x"}'::jsonb, now() - (g % 1000) * interval '1 minute'
    from generate_series(1, ${AUDIT_ROWS}) g`);

  // A few hundred notices, one per receipt, in assorted states.
  await db.execute(sql`
    insert into audit_log (id, household_id, entity_type, entity_id, action, changes)
    select gen_random_uuid(), m.household_id, ${APPROVAL_NOTICE_ENTITY}, m.id, 'reviewed_intake_not_added',
      case row_number() over (order by m.id) % 4
        when 0 then '{"email":"pending","push":"pending","titleEnc":"x"}'::jsonb
        when 1 then '{"email":"sent","push":"pending","titleEnc":"x","nextAttemptAt":"2020-01-01T00:00:00Z"}'::jsonb
        when 2 then '{"email":"sent","push":"sent","titleEnc":null}'::jsonb
        else '{"email":"sending","push":"sent","titleEnc":"x","waitingOn":"receipt"}'::jsonb
      end
    from imap_ingestion_messages m where m.mailbox_uid_validity = ${"plan-" + tag}`);

  await db.execute(sql`analyze audit_log`);
  await db.execute(sql`analyze imap_ingestion_messages`);
}, 300_000);

afterAll(async () => { await cleanupIntegrationEnvironment(); });

describe("#1787 approval-notice queries on a audit log", () => {
  it("the due-notice query does not scan audit_log", async () => {
    const nodes = await explain(dueNoticesQuery(getDb(), new Date(), [randomUUID()], 20));
    expect(auditScans(nodes)).toEqual([]);
    expect(usesAuditIndex(nodes)).toBe(true);
  });

  it("the pending-notice count does not scan audit_log", async () => {
    const nodes = await explain(pendingNoticeCountQuery(getDb()));
    expect(auditScans(nodes)).toEqual([]);
    expect(usesAuditIndex(nodes)).toBe(true);
  });
});
