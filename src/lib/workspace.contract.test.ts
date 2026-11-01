import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { reminderPreferenceSchema } from "./preferences";
import { workspaceSchema } from "./workspace";

/*
 * Contract fixtures (#1357, ADR-0039 section 2): every canned engine answer in
 * web/src/lib/data/fixtures/ must parse with the schema of the engine route it
 * stands in for, so a fixture can never describe a field, a value or a shape
 * the engine would not send. The fidelity gate serves these as JSON; if they
 * drift from the engine, the gate proves a parallel path, not the live one.
 *
 * One `it` per fixture export, named "<file>.<export>". A fixture whose route
 * has no response schema yet is skipped by name (`it.skip`), so the gap is
 * visible in the report rather than silent. A new fixture export that is in
 * neither list fails the last test here.
 */

const FIXTURES_DIR = fileURLToPath(new URL("../../web/src/lib/data/fixtures", import.meta.url));

type Problems = string[];
type Check = { check: (value: unknown) => Problems };
type Contract = Check | { skip: string };

const formatIssues = (error: z.ZodError): Problems =>
  error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);

/* The fields a schema (looked through its optional, nullable and default
   wrappers) declares, walked alongside the value. zod strips unknown keys on
   parse, so without this a fixture field the schema lacks would pass silently. */
function unknownFields(schema: unknown, value: unknown, path: string[] = []): Problems {
  let current = schema as { def?: { innerType?: unknown; type?: string }; shape?: Record<string, unknown>; element?: unknown };
  while (current?.def?.innerType) current = current.def.innerType as typeof current;
  if (value === null || typeof value !== "object") return [];
  if (current?.def?.type === "array" && Array.isArray(value)) {
    return value.flatMap((entry, index) => unknownFields(current.element, entry, [...path, String(index)]));
  }
  if (current?.def?.type === "object" && current.shape && !Array.isArray(value)) {
    const shape = current.shape;
    return Object.entries(value).flatMap(([key, entry]) =>
      key in shape
        ? unknownFields(shape[key], entry, [...path, key])
        : [`${[...path, key].join(".")}: the schema has no such field`],
    );
  }
  return [];
}

/** A fixture field the schema lacks that a screen reads anyway: a product
    defect, not a fixture to fix. Named so it stays visible (an `it.skip` in
    the report) until the screen stops relying on it. */
type KnownGap = { field: RegExp; skip: string };

/** Parse with the engine's schema and also refuse fields it does not declare,
    except the known gaps. */
const parsesWith = (schema: z.ZodType, gaps: KnownGap[] = []): Check => ({
  check: (value) => {
    const parsed = schema.safeParse(value);
    const unknown = unknownFields(schema, value).filter((problem) => !gaps.some((gap) => gap.field.test(problem)));
    return [...(parsed.success ? [] : formatIssues(parsed.error)), ...unknown];
  },
});

/** The same, for a fixture that is a map of answers (one per key). */
const parsesEachWith = (schema: z.ZodType): Check => ({
  check: (value) =>
    Object.entries(value as Record<string, unknown>).flatMap(([name, entry]) =>
      parsesWith(schema).check(entry).map((problem) => `${name}.${problem}`),
    ),
});

const noSchema = (what: string): Contract => ({ skip: what });

/* Item cost estimates: the home screen reads `costIsEstimate` off every item
   (chart.js dialBodiesOf, manifest and search rows, ItemView, ItemDrawer) to
   draw the "~" estimate mark, but the engine's item has no such field (not in
   workspaceItemShape or the database), so zod strips it and the live app
   never shows the mark on a stored item; only mail suggestions are hard-set
   to estimates. The fixture keeps the field so the pixel baselines do not
   move. Product defect, #1619 (item cost estimate mark is
   fixture-only). Remove this entry when the field is real or the reads go. */
const WORKSPACE_GAPS: KnownGap[] = [
  { field: /^households\.\d+\.items\.\d+\.costIsEstimate: the schema has no such field$/, skip: "items.costIsEstimate: read by the home screens, sent by no engine route (product defect, #1619)" },
];

const CONTRACTS: Record<string, Contract> = {
  /* GET /api/workspace answers { workspace }, parsed here as workspaceSchema. */
  "workspace.WORKSPACE_FIXTURE": parsesWith(workspaceSchema, WORKSPACE_GAPS),
  "workspace.WORKSPACE_FIXTURE_TODAY": noSchema("not an API field: the chart's date pin, sent beside the workspace by the fixture routes (#1357)"),
  "arrival.NEWCOMER_ARRIVAL_FIXTURE": parsesWith(workspaceSchema),
  "arrival.ARRIVAL_FIXTURES": parsesEachWith(workspaceSchema),

  /* GET /api/settings/reminders: only the preference pair has a schema
     (reminderPreferenceSchema, the PUT body); the rendered labels and
     outboundMail have none, so only the pair is checked. */
  "settings.REMINDERS_FIXTURE": {
    check: (value) => {
      const { emailEnabled, firstWarningDays, finalWarningDays } = (value as { reminders: Record<string, unknown> }).reminders;
      const parsed = reminderPreferenceSchema.safeParse({ emailEnabled, firstWarningDays, finalWarningDays });
      return parsed.success ? [] : formatIssues(parsed.error).map((problem) => `reminders.${problem}`);
    },
  },

  /* Waits on #1326: no response schema for the session or auth routes yet. */
  "workspace.SESSION_FIXTURE": noSchema("GET /api/auth/session has no response schema (waits on #1326)"),
  "admin.SIGN_IN_METHODS_FIXTURES": noSchema("GET /api/auth/methods has no response schema (waits on #1326)"),
  "admin.SETUP_LINK_FIXTURES": noSchema("POST /api/admin/users/{userId}/setup-link has no response schema (waits on #1326)"),

  /* Routes whose answer is a TypeScript interface only. */
  "workspace.DOCUMENTS_FIXTURE": noSchema("DocumentSummary (src/server/document-repository.ts) has no zod schema"),
  "about.ABOUT_FIXTURE": noSchema("AboutFacts (src/server/about.ts) has no zod schema"),
  "about.LIBRARIES_FIXTURE": noSchema("readLibraries result has no zod schema"),
  "admin.ADMIN_USERS_FIXTURE": noSchema("GET /api/admin/users has no response schema"),
  "household.MEMBERS_FIXTURE": noSchema("HouseholdMember (src/server/workspace-repository.ts) has no zod schema"),
  "household.INVITATIONS_FIXTURE": noSchema("GET /api/households/{householdId}/invitations has no response schema"),
  "inbox.INBOX_FIXTURE": noSchema("GET /api/imap-inbox receipt list has no response schema"),
  "relay.RELAY_FIXTURE": noSchema("RelaySettings (src/server/mail-in/relay-settings.ts) has no zod schema"),
  "relay.SENDER_SCENES": noSchema("the relay sender block has no zod schema"),
  "system-status.SYSTEM_STATUS_FIXTURE": noSchema("SystemStatus (src/server/system-status.ts) has no zod schema"),
  "settings.SENT_LATELY_FIXTURE": noSchema("no route reads notification_deliveries yet (#1003); no schema"),

  /* Page data and display values, not an engine route's answer. */
  "admin.adminFixture": noSchema("display values for rows no route answers; no schema"),
  "relay.relayFixture": noSchema("the mockup's display values, not a route answer; no schema"),
  "settings.settingsFixture": noSchema("the mockup's display values, not a route answer; no schema"),
  "maintenance.MAINTENANCE_FIXTURE": noSchema("maintenance page data has no zod schema"),
  "maintenance.MAINTENANCE_FIXTURE_ONE": noSchema("maintenance page data has no zod schema"),
  "maintenance.MAINTENANCE_KEY_FIXTURE": noSchema("maintenance page data has no zod schema"),
  "maintenance.MAINTENANCE_KEY_FIXTURE_CONTACT": noSchema("maintenance page data has no zod schema"),
};

const modules: Record<string, Record<string, unknown>> = {};
for (const file of readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".js")).sort()) {
  modules[basename(file, ".js")] = await import(/* @vite-ignore */ join(FIXTURES_DIR, file));
}

const failWith = (name: string, problems: Problems) => {
  if (problems.length > 0) {
    expect.fail(`${name} does not match the engine's schema (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n  ${problems.join("\n  ")}`);
  }
};

describe("contract fixtures parse with the engine's schemas (#1357)", () => {
  for (const [file, exports] of Object.entries(modules)) {
    for (const [exportName, value] of Object.entries(exports)) {
      const name = `${file}.${exportName}`;
      const contract = CONTRACTS[name];
      if (contract && "skip" in contract) {
        it.skip(`${name}: ${contract.skip}`, () => {});
      } else if (contract) {
        it(name, () => failWith(name, contract.check(value)));
      }
    }
  }

  for (const gap of WORKSPACE_GAPS) {
    it.skip(`workspace.WORKSPACE_FIXTURE: ${gap.skip}`, () => {});
  }

  it("every fixture export is covered by this table, and every entry names a real export", () => {
    const real = Object.entries(modules).flatMap(([file, exports]) => Object.keys(exports).map((exportName) => `${file}.${exportName}`));
    failWith("the contract table", [
      ...real.filter((name) => !(name in CONTRACTS)).map((name) => `${name}: a fixture export with no entry in CONTRACTS`),
      ...Object.keys(CONTRACTS).filter((name) => !real.includes(name)).map((name) => `${name}: an entry for an export that does not exist`),
    ]);
  });
});
