/**
 * Shared by the #1629 integration suites (outgoing mail becomes app-managed,
 * ADR-0017 amendment "outgoing mail is app-managed too").
 *
 * Nothing here knows the sending row's table or column names: the build
 * chooses them. What the suites rely on instead:
 *
 *  - the engine module `@/server/mail-in/sending-settings`, beside the
 *    mailbox's `mailbox-settings`, exporting `setSendingSettings`,
 *    `readSendingSettings` and `importSendingFromEnvironment` (the tests'
 *    choice of names; the spec names the behaviour, not the functions);
 *  - the password living in an envelope-encrypted table, which every such
 *    table in this schema marks with a `wrapped_dek` column;
 *  - the sending row living in a table whose name says so (`sending`,
 *    `smtp`, `outgoing` or `mail_out`), so cleanup can empty it.
 *
 * All hosts are `.example`; every password is obviously fake.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

export type SendingModule = typeof import("@/server/mail-in/sending-settings");

/** Loaded per case, so a missing module fails each case with that reason. */
export const sending = async (): Promise<SendingModule> => import("@/server/mail-in/sending-settings");

export const MAILBOX_PASSWORD = "fake-mailbox-pass-1629";
export const RELAY_PASSWORD = "fake-relay-pass-1629";

/** The mailbox: a mailcow server, whose submission server is the same host. */
export const mailboxInput = {
  host: "mail.orbit-test.example",
  port: 993,
  accountUser: "orbit@orbit-test.example",
  mailbox: "INBOX",
  tlsServerName: "mail.orbit-test.example",
  providerProfile: "mailcow" as const,
  trustedRecipientHeader: "X-Original-To",
  pollSeconds: 300,
  password: MAILBOX_PASSWORD,
};

/** "Another account": its own server, port 465 implicit TLS. */
export const anotherAccount = {
  via: "account" as const,
  host: "smtp.relay.example",
  port: 465,
  security: "implicit_tls" as const,
  user: "relay-user",
  password: RELAY_PASSWORD,
  senderName: "Orbit",
  senderAddress: "orbit@orbit-test.example",
};

/** "The mailbox account": sender name and address only, no password. */
export const viaMailbox = {
  via: "mailbox" as const,
  senderName: "Orbit",
  senderAddress: "orbit@orbit-test.example",
};

type Rows = Array<Record<string, unknown>>;
async function rowsOf(query: ReturnType<typeof sql>): Promise<Rows> {
  const result = await getDb().execute(query) as unknown;
  return (Array.isArray(result) ? result : (result as { rows: Rows }).rows) as Rows;
}

async function publicTables(): Promise<string[]> {
  const rows = await rowsOf(sql`select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'`);
  return rows.map((row) => String(row.table_name));
}

/** Every row of every envelope-encrypted table: where a stored password must be. */
export async function encryptedRowCount(): Promise<number> {
  const tables = await rowsOf(sql`select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'wrapped_dek'`);
  let total = 0;
  for (const { table_name: table } of tables) {
    const [row] = await rowsOf(sql`select count(*)::int as n from ${sql.identifier(String(table))}`);
    total += Number(row?.n ?? 0);
  }
  return total;
}

/** The tables and columns where `needle` appears as plain text, anywhere in the database. */
export async function plaintextHits(needle: string): Promise<string[]> {
  const columns = await rowsOf(sql`select table_name, column_name, data_type from information_schema.columns
    where table_schema = 'public' and data_type in ('text', 'character varying', 'json', 'jsonb', 'bytea')`);
  const hits: string[] = [];
  for (const { table_name: table, column_name: column, data_type: type } of columns) {
    const t = sql.identifier(String(table));
    const c = sql.identifier(String(column));
    const condition = type === "bytea"
      ? sql`position(convert_to(${needle}, 'UTF8') in ${c}) > 0`
      : sql`${c}::text like ${`%${needle}%`}`;
    const [row] = await rowsOf(sql`select count(*)::int as n from ${t} where ${condition}`);
    if (Number(row?.n ?? 0) > 0) hits.push(`${String(table)}.${String(column)}`);
  }
  return hits;
}

/** Empties the mailbox, the sending row, every secret and the audit log. */
export async function clearMailState(): Promise<void> {
  const tables = await publicTables();
  const sendingTables = tables.filter((name) => /sending|smtp|outgoing|mail_out/u.test(name)
    && name !== "mail_probe_results");
  for (const name of sendingTables) await getDb().execute(sql`truncate table ${sql.identifier(name)} cascade`);
  await getDb().execute(sql`delete from imap_ingestion_messages`);
  await getDb().execute(sql`delete from imap_recipient_aliases`);
  await getDb().execute(sql`delete from mail_in_relays`);
  await getDb().execute(sql`update mail_in_mailbox set password_secret_id = null, alias_key_secret_id = null`);
  await getDb().execute(sql`delete from mail_in_mailbox`);
  await getDb().execute(sql`truncate table mail_in_secrets cascade`);
  await getDb().execute(sql`delete from audit_log`);
}

/**
 * Where a transport was pointed, whatever shape the build hands nodemailer:
 * the URL string today's `createSmtpTransport` builds, or an options object.
 */
export function targetOf(argument: unknown): {
  host: string; port: number; user: string; pass: string; implicitTls: boolean; requireTls: boolean;
} {
  if (typeof argument === "string") {
    const url = new URL(argument);
    const implicitTls = url.protocol === "smtps:";
    return {
      host: url.hostname,
      port: Number(url.port) || (implicitTls ? 465 : 587),
      user: decodeURIComponent(url.username),
      pass: decodeURIComponent(url.password),
      implicitTls,
      requireTls: url.searchParams.get("requireTLS") === "true",
    };
  }
  const options = (argument ?? {}) as {
    host?: string; port?: number | string; secure?: boolean; requireTLS?: boolean; auth?: { user?: string; pass?: string };
  };
  return {
    host: String(options.host ?? ""),
    port: Number(options.port),
    user: String(options.auth?.user ?? ""),
    pass: String(options.auth?.pass ?? ""),
    implicitTls: options.secure === true,
    requireTls: options.requireTLS === true,
  };
}

/** A stand-in for nodemailer's transporter: what a test drives and inspects. */
export function fakeTransporter() {
  return {
    verify: async () => true as const,
    sendMail: async (_message: Record<string, unknown>) => ({ messageId: "<fake@orbit-test.example>" }),
    close: () => undefined,
  };
}

/** Errors shaped like nodemailer's own, for a refused and an unreachable server. */
export const refusedSignIn = () => Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 });
export const unreachable = () => Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });

/**
 * For the older suites that only need outgoing mail to be set up (#1629 moved
 * it from `SMTP_*` to the sending row): the values those suites used to put
 * in `SMTP_*`, as "another account" on port 587 with STARTTLS. Saving runs the
 * live sign-in, so the suite's nodemailer stand-in must answer `verify()`.
 */
export const relaySending = {
  via: "account" as const,
  host: "smtp.example.test",
  port: 587,
  security: "starttls" as const,
  user: "orbit-test",
  password: "fake-smtp-password",
  senderName: "Orbit",
  senderAddress: "orbit@example.test",
};

/** Sets outgoing mail up through the engine, as an administrator would on the Mail card. */
export async function setUpSending(actorUserId: string, input: Parameters<SendingModule["setSendingSettings"]>[2] = relaySending): Promise<void> {
  const { setSendingSettings } = await sending();
  const { outcome } = await setSendingSettings(actorUserId, null, input);
  if (outcome !== "verified") throw new Error(`sending was not saved: ${String(outcome)}`);
}

/** Empties the sending row and its stored password: outgoing mail is not set up again. */
export async function clearSending(): Promise<void> {
  const tables = await publicTables();
  for (const name of tables.filter((table) => /sending|smtp|outgoing|mail_out/u.test(table) && table !== "mail_probe_results")) {
    await getDb().execute(sql`truncate table ${sql.identifier(name)} cascade`);
  }
  await getDb().execute(sql`delete from mail_in_secrets where kind = 'smtp_password'`);
}
