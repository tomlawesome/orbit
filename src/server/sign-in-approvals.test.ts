import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The second factor's own arithmetic (#1033, ADR-0027), against an in-memory
 * stand-in for the database.
 *
 * WHY A FAKE AND NOT THE INTEGRATION SUITE. What is pinned here is not SQL --
 * it is the rules a reader's account hangs on: a link that spends once, an
 * approval only the waiting browser can collect, ten minutes, a minute
 * between sends and five sends an hour. Those have to be checkable in the
 * fast suite, on every change, without a PostgreSQL container; the migration
 * and the columns themselves are the integration suite's job.
 *
 * THE FAKE UNDERSTANDS EXACTLY WHAT THIS MODULE ASKS FOR and nothing more:
 * `and`-joined `=`, `is null` and `>` over one table, one aggregate (the
 * hourly send count), and a transaction that is simply the same store. A
 * query shape the module does not use is a query shape this fake cannot run,
 * which is deliberate -- a general fake database would be a second, untested
 * implementation of PostgreSQL living in the test directory.
 */

const APP_URL = "https://orbit.example.invalid";

/** One row as the store holds it, in the module's own JS property names. */
type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  approvals: [] as Row[],
  credentials: [] as Row[],
  users: [] as Row[],
  audit: [] as Row[],
  nextId: 1,
}));

vi.mock("@/server/metadata/fields", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/metadata/fields")>();
  return {
    ...original,
    /* An unlocked reader over plaintext addresses: what this module needs of
       the cipher is only "give me the address", and #969's own tests own the
       question of what happens when it cannot. */
    openInstanceMetadataReader: async () => new original.MetadataCipher(undefined),
  };
});

vi.mock("@/db", async () => {
  const schema = await import("@/db/schema");

  /** SQL column name -> the JS property the module writes and reads. */
  function columnKeys(table: Record<string, { name?: string }>): Map<string, string> {
    const keys = new Map<string, string>();
    for (const [property, column] of Object.entries(table)) {
      if (column && typeof column === "object" && typeof column.name === "string") keys.set(column.name, property);
    }
    return keys;
  }

  /** Which of the three tables a builder was pointed at. */
  function rowsFor(table: unknown): Row[] {
    if (table === schema.signInApprovals) return store.approvals;
    if (table === schema.localCredentials) return store.credentials;
    if (table === schema.users) return store.users;
    if (table === schema.auditLog) return store.audit;
    throw new Error("the fake database was handed a table it does not hold");
  }

  /** The condition, flattened to [column | operator | value] in written order. */
  function tokens(node: unknown, out: unknown[] = []): unknown[] {
    if (node === null || node === undefined) return out;
    const shape = (node as { constructor?: { name?: string } }).constructor?.name;
    if (shape === "SQL") {
      for (const chunk of (node as { queryChunks: unknown[] }).queryChunks) tokens(chunk, out);
      return out;
    }
    if (shape === "StringChunk") {
      for (const piece of (node as { value: string[] }).value) {
        const word = piece.trim();
        if (word && word !== "(" && word !== ")") out.push({ op: word });
      }
      return out;
    }
    if (shape === "Param") {
      out.push({ value: (node as { value: unknown }).value });
      return out;
    }
    const column = node as { name?: string; table?: unknown };
    if (typeof column.name === "string" && column.table) out.push({ column: column.name });
    return out;
  }

  function matches(row: Row, condition: unknown, keys: Map<string, string>): boolean {
    const stream = tokens(condition) as Array<{ op?: string; value?: unknown; column?: string }>;
    let verdict = true;
    for (let at = 0; at < stream.length; at += 1) {
      const column = stream[at].column;
      if (column === undefined) continue;
      const held = row[keys.get(column) ?? column];
      const operator = stream[at + 1]?.op ?? "";
      if (operator === "is null") verdict &&= held === null || held === undefined;
      else if (operator === "is not null") verdict &&= held !== null && held !== undefined;
      else if (operator === "=") verdict &&= String(held) === String(stream[at + 2]?.value);
      else if (operator === ">") verdict &&= held instanceof Date
        && held.getTime() > new Date(stream[at + 2]?.value as string).getTime();
      else throw new Error(`the fake database does not implement "${operator}"`);
    }
    return verdict;
  }

  /** `select({ alias: column })` -> the row, narrowed to those columns. */
  function project(row: Row, selection: Record<string, unknown>, keys: Map<string, string>): Row {
    const out: Row = {};
    for (const [alias, column] of Object.entries(selection)) {
      const name = (column as { name?: string }).name;
      out[alias] = name ? row[keys.get(name) ?? name] : undefined;
    }
    return out;
  }

  /** The one aggregate this module asks for: ADR-0027 §8's hourly send count. */
  function isSendCount(selection: Record<string, unknown>): boolean {
    return Object.keys(selection).length === 1 && "sends" in selection;
  }

  function select(selection: Record<string, unknown>) {
    let table: unknown;
    let condition: unknown = null;
    const builder = {
      from(from: unknown) { table = from; return builder; },
      leftJoin() { return builder; },
      where(where: unknown) { condition = where; return builder; },
      for() { return builder; },
      limit() { return builder; },
      orderBy() { return builder; },
      then(resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          const rows = rowsFor(table);
          const keys = columnKeys(table as Record<string, { name?: string }>);
          const found = rows.filter((row) => condition === null || matches(row, condition, keys));
          if (isSendCount(selection)) {
            const sends = found.reduce((total, row) => total + Number(row.sendCount ?? 0), 0);
            return Promise.resolve([{ sends }]).then(resolve, reject);
          }
          return Promise.resolve(found.map((row) => project(row, selection, keys))).then(resolve, reject);
        } catch (error) {
          return Promise.resolve().then(() => { throw error; }).then(resolve, reject);
        }
      },
    };
    return builder;
  }

  function insert(table: unknown) {
    return {
      values(value: Row) {
        const row: Row = {
          id: `row-${store.nextId += 1}`,
          createdAt: new Date(),
          consumedAt: null,
          outcome: null,
          decidedAt: null,
          noticeShownAt: null,
          sendCount: 0,
          lastSentAt: null,
          ...value,
        };
        rowsFor(table).push(row);
        return Promise.resolve();
      },
    };
  }

  function update(table: unknown) {
    let values: Row = {};
    let condition: unknown = null;
    /** Every SQL-valued `set` in this module is "the column plus one". */
    const applied = (row: Row) => {
      for (const [key, value] of Object.entries(values)) {
        row[key] = value && typeof value === "object" && value.constructor?.name === "SQL"
          ? Number(row[key] ?? 0) + 1
          : value;
      }
    };
    const run = () => {
      const keys = columnKeys(table as Record<string, { name?: string }>);
      const touched = rowsFor(table).filter((row) => condition === null || matches(row, condition, keys));
      touched.forEach(applied);
      return { touched, keys };
    };
    const builder = {
      set(next: Row) { values = next; return builder; },
      where(where: unknown) { condition = where; return builder; },
      returning(selection: Record<string, unknown>) {
        const { touched, keys } = run();
        return Promise.resolve(touched.map((row) => project(row, selection, keys)));
      },
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
        try {
          run();
          return Promise.resolve([]).then(resolve, reject);
        } catch (error) {
          return Promise.resolve().then(() => { throw error; }).then(resolve, reject);
        }
      },
    };
    return builder;
  }

  const db = {
    select,
    insert,
    update,
    /* One process, one store: a transaction here is the rules running in
       order, which is what these tests are about. Rollback is PostgreSQL's
       to prove, and the integration suite's to check. */
    transaction: (body: (executor: unknown) => unknown) => Promise.resolve(body(db)),
  };
  return { getDb: () => db };
});

const {
  APPROVAL_RESEND_INTERVAL_MS,
  APPROVAL_SENDS_PER_HOUR,
  SIGN_IN_APPROVAL_TTL_MS,
  collectSignInApproval,
  decideSignInApproval,
  describeClientAddress,
  deviceInWords,
  isPrivateAddress,
  normalizeAddress,
  readSignInApproval,
  resendSignInApproval,
  secondFactorConfigured,
  startSignInApproval,
  takeDeniedSignInNotice,
} = await import("@/server/sign-in-approvals");

const USER = "22222222-2222-4222-8222-222222222222";
const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

/** Every mail this run put on the wire, in order. */
let posted: Array<{ to: string; subject: string; text: string }>;

/** The token out of the newest mail -- the only place it ever exists. */
function tokenFromLatestMail(): string {
  const link = /\/approve\/([^\s)]+)/u.exec(posted[posted.length - 1].text);
  if (!link) throw new Error("the approval mail carried no link");
  return decodeURIComponent(link[1]);
}

const mailer = {
  async sendEmail(notification: { to: string; subject: string; text: string }) {
    posted.push({ to: notification.to, subject: notification.subject, text: notification.text });
  },
};

/** Moves the module's own clock as well as the `now` a caller passes in. */
function at(from: Date, offsetMs = 0): Date {
  const moment = new Date(from.getTime() + offsetMs);
  vi.setSystemTime(moment);
  return moment;
}

const NINE = new Date("2026-09-18T09:00:00.000Z");

beforeEach(() => {
  /* Every deadline in this module is measured against the process clock, so
     the tests hold it still rather than writing expiries relative to whenever
     the suite happens to run. */
  vi.useFakeTimers();
  vi.setSystemTime(NINE);
  store.approvals.length = 0;
  store.credentials.length = 0;
  store.users.length = 0;
  store.audit.length = 0;
  posted = [];
  process.env.APP_URL = APP_URL;
  store.users.push({ id: USER, email: "priya@example.invalid", emailEnc: null, displayName: "Priya Shah" });
  store.credentials.push({ userId: USER, failedAttemptCount: 0, lockedUntil: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("describeClientAddress (owner ruling, 2026-09-18)", () => {
  it("tells a private address as a place, not as a number", () => {
    for (const address of ["192.168.1.24", "10.0.0.5", "172.16.4.9", "172.31.255.1", "127.0.0.1", "169.254.1.1"]) {
      expect(describeClientAddress(address), address).toBe("your home network");
    }
  });

  it("reads IPv6 loopback, unique-local and link-local the same way", () => {
    for (const address of ["::1", "fd00::1", "fc00::abcd", "fe80::1%eth0", "FD12:3456::9"]) {
      expect(describeClientAddress(address), address).toBe("your home network");
    }
  });

  it("unwraps an IPv4-mapped IPv6 address before judging it", () => {
    /* What a dual-stack Node server reports for a plain IPv4 client. Read as
       "some IPv6 address" it would tell somebody at home they were elsewhere. */
    expect(describeClientAddress("::ffff:192.168.1.5")).toBe("your home network");
    expect(describeClientAddress("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeAddress("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("shows a public address as it is, and never invents one", () => {
    expect(describeClientAddress("203.0.113.9")).toBe("203.0.113.9");
    expect(describeClientAddress("2001:db8::1")).toBe("2001:db8::1");
    /* 100.64/10 is carrier-grade NAT: somebody else's network, not this one's. */
    expect(describeClientAddress("100.64.0.1")).toBe("100.64.0.1");
    expect(isPrivateAddress("100.64.0.1")).toBe(false);
  });

  it("says so plainly when there is no address to show", () => {
    expect(describeClientAddress(null)).toBe("an address Orbit could not read");
    expect(describeClientAddress("")).toBe("an address Orbit could not read");
    expect(describeClientAddress("   ")).toBe("an address Orbit could not read");
  });

  it("joins the device pair in words, for a plain-ASCII mail", () => {
    expect(deviceInWords(CHROME)).toBe("Chrome on Linux");
    expect(deviceInWords(null)).toBe("unknown device");
  });
});

describe("secondFactorConfigured (ADR-0027 §2)", () => {
  const smtp = { SMTP_HOST: process.env.SMTP_HOST, SMTP_USER: process.env.SMTP_USER, SMTP_PASSWORD: process.env.SMTP_PASSWORD };
  afterEach(() => {
    for (const [name, value] of Object.entries(smtp)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("is off with no relay configured, and on once one is", () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    expect(secondFactorConfigured()).toBe(false);

    process.env.SMTP_HOST = "smtp.example.invalid";
    process.env.SMTP_USER = "orbit";
    process.env.SMTP_PASSWORD = "not-a-real-password";
    expect(secondFactorConfigured()).toBe(true);
  });

  it("is off, rather than throwing, on a configuration it cannot parse", () => {
    process.env.SMTP_HOST = "smtp.example.invalid";
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    expect(secondFactorConfigured()).toBe(false);
  });
});

describe("a pending sign-in, from the password to the session (ADR-0027 §4-§6)", () => {
  it("mails one link, tells the waiting tab nothing about the address, and lasts ten minutes", async () => {
    const now = NINE;
    const pending = await startSignInApproval(USER, { userAgent: CHROME, clientAddress: "192.168.1.24" }, { mailer, now });

    expect(pending.sendError).toBeNull();
    expect(pending.limited).toBe(false);
    expect(pending.expiresAt.getTime() - now.getTime()).toBe(SIGN_IN_APPROVAL_TTL_MS);
    expect(pending.canResendAt.getTime() - now.getTime()).toBe(APPROVAL_RESEND_INTERVAL_MS);

    expect(posted).toHaveLength(1);
    expect(posted[0].to).toBe("priya@example.invalid");
    expect(posted[0].subject).toBe("Approve your Orbit sign-in");
    /* The four bullets ADR-0027 §5 puts before the link, in its order. */
    expect(posted[0].text).toContain("- Orbit at orbit.example.invalid");
    expect(posted[0].text).toContain("- Chrome on Linux");
    expect(posted[0].text).toContain("- From your home network");
    expect(posted[0].text).toContain("- 18 Sep 2026 at 09:00 UTC");

    /* Only the digests reach the table: neither secret is stored. */
    const token = tokenFromLatestMail();
    expect(store.approvals).toHaveLength(1);
    expect(JSON.stringify(store.approvals[0])).not.toContain(token);
    expect(JSON.stringify(store.approvals[0])).not.toContain(pending.claim);
  });

  it("holds the tab until somebody presses Approve, then hands it one session", async () => {
    const pending = await startSignInApproval(USER, { userAgent: CHROME, clientAddress: "203.0.113.9" }, { mailer });
    const token = tokenFromLatestMail();

    expect(await collectSignInApproval(pending.claim)).toEqual({ state: "waiting" });

    expect(await decideSignInApproval(token, "approved")).toEqual({ recorded: true });
    expect(await collectSignInApproval(pending.claim)).toEqual({ state: "approved", userId: USER });
    /* Spent: a second tab sharing the cookie gets nothing, so one approval is
       one session and never two. */
    expect(await collectSignInApproval(pending.claim)).toEqual({ state: "unknown" });
  });

  it("gives nothing to anyone but the browser that typed the password", async () => {
    await startSignInApproval(USER, { userAgent: CHROME, clientAddress: "203.0.113.9" }, { mailer });
    const token = tokenFromLatestMail();
    await decideSignInApproval(token, "approved");

    /* Whoever read the mail holds the token and can approve with it. They
       still cannot collect: the claim never left the waiting tab. */
    expect(await collectSignInApproval(token)).toEqual({ state: "unknown" });
    expect(await collectSignInApproval("")).toEqual({ state: "unknown" });
    expect(await collectSignInApproval("a-claim-nobody-issued")).toEqual({ state: "unknown" });
  });

  it("refuses an approval after ten minutes, and tells the tab nothing else", async () => {
    const now = NINE;
    const pending = await startSignInApproval(USER, { userAgent: CHROME, clientAddress: null }, { mailer, now });
    const token = tokenFromLatestMail();

    at(now, SIGN_IN_APPROVAL_TTL_MS + 1);

    expect(await decideSignInApproval(token, "approved")).toEqual({ recorded: false });
    expect(await collectSignInApproval(pending.claim)).toEqual({ state: "unknown" });
    expect((await readSignInApproval(token))?.state).toBe("lapsed");
  });

  it("records the first press and no other", async () => {
    await startSignInApproval(USER, { userAgent: CHROME, clientAddress: null }, { mailer });
    const token = tokenFromLatestMail();

    expect(await decideSignInApproval(token, "approved")).toEqual({ recorded: true });
    /* A second reader of the same forwarded link cannot turn an approval into
       a refusal, or the other way round. */
    expect(await decideSignInApproval(token, "denied")).toEqual({ recorded: false });
    expect(store.approvals[0].outcome).toBe("approved");
  });

  it("answers an unknown token with nothing at all", async () => {
    expect(await readSignInApproval("a-token-nobody-issued")).toBeNull();
    expect(await readSignInApproval("")).toBeNull();
    expect(await decideSignInApproval("a-token-nobody-issued", "approved")).toEqual({ recorded: false });
  });

  it("shows the request without deciding it, because mail scanners follow links", async () => {
    await startSignInApproval(USER, { userAgent: CHROME, clientAddress: "192.168.1.24" }, { mailer });
    const token = tokenFromLatestMail();

    const view = await readSignInApproval(token);
    expect(view).toMatchObject({
      instance: "orbit.example.invalid",
      device: "Chrome on Linux",
      where: "your home network",
      state: "open",
    });
    /* Read twice, changed neither time. */
    expect((await readSignInApproval(token))?.state).toBe("open");
    expect(store.approvals[0].outcome).toBeNull();
    expect(store.approvals[0].consumedAt).toBeNull();
  });
});

describe("a refusal (ADR-0027 §8 and consequences)", () => {
  it("revokes the sign-in, counts as a failed attempt, and leaves a notice", async () => {
    const pending = await startSignInApproval(USER, { userAgent: CHROME, clientAddress: null }, { mailer });
    const token = tokenFromLatestMail();

    expect(await decideSignInApproval(token, "denied")).toEqual({ recorded: true });
    expect(await collectSignInApproval(pending.claim)).toEqual({ state: "denied" });
    expect(store.credentials[0].failedAttemptCount).toBe(1);
    expect(store.audit.map((row) => row.action)).toContain("sign_in_refused");
  });

  it("tells the account holder once, on their next successful sign-in", async () => {
    await startSignInApproval(USER, { userAgent: CHROME, clientAddress: null }, { mailer });
    await decideSignInApproval(tokenFromLatestMail(), "denied");

    const notice = await takeDeniedSignInNotice(USER);
    expect(notice).not.toBeNull();
    /* Taken, not read: the second sign-in is not told again. */
    expect(await takeDeniedSignInNotice(USER)).toBeNull();
  });

  it("says nothing when nobody has refused anything", async () => {
    await startSignInApproval(USER, { userAgent: CHROME, clientAddress: null }, { mailer });
    await decideSignInApproval(tokenFromLatestMail(), "approved");
    expect(await takeDeniedSignInNotice(USER)).toBeNull();
  });
});

describe("send limits (ADR-0027 §8)", () => {
  it("refuses a resend inside the first minute and says when it will answer", async () => {
    const now = NINE;
    const pending = await startSignInApproval(USER, { userAgent: CHROME, clientAddress: null }, { mailer, now });

    const tooSoon = await resendSignInApproval(pending.claim, {
      mailer,
      now: at(now, APPROVAL_RESEND_INTERVAL_MS - 1),
    });
    expect(tooSoon.state).toBe("too_soon");
    expect(posted).toHaveLength(1);
  });

  it("replaces the link rather than adding a second one", async () => {
    const now = NINE;
    const pending = await startSignInApproval(USER, { userAgent: CHROME, clientAddress: null }, { mailer, now });
    const first = tokenFromLatestMail();

    const again = await resendSignInApproval(pending.claim, {
      mailer,
      now: at(now, APPROVAL_RESEND_INTERVAL_MS),
    });
    expect(again.state).toBe("sent");
    const second = tokenFromLatestMail();
    expect(second).not.toBe(first);

    /* One live link per pending sign-in: the superseded one is simply not
       there any more, and says the same nothing an invented token says. */
    expect(await readSignInApproval(first)).toBeNull();
    expect((await readSignInApproval(second))?.state).toBe("open");
  });

  it("stops at five sends an hour, and the answer is to read the mail already sent", async () => {
    const start = NINE;
    const pending = await startSignInApproval(USER, { userAgent: CHROME, clientAddress: null }, { mailer, now: start });

    for (let send = 1; send < APPROVAL_SENDS_PER_HOUR; send += 1) {
      const outcome = await resendSignInApproval(pending.claim, {
        mailer,
        now: at(start, send * APPROVAL_RESEND_INTERVAL_MS),
      });
      expect(outcome.state, `send ${send + 1}`).toBe("sent");
    }
    expect(posted).toHaveLength(APPROVAL_SENDS_PER_HOUR);

    const limited = await resendSignInApproval(pending.claim, {
      mailer,
      now: at(start, APPROVAL_SENDS_PER_HOUR * APPROVAL_RESEND_INTERVAL_MS),
    });
    expect(limited).toEqual({ state: "limited" });
    expect(posted).toHaveLength(APPROVAL_SENDS_PER_HOUR);
  });

  it("opens a pending sign-in without a mail once the account is at its limit", async () => {
    const start = NINE;
    const first = await startSignInApproval(USER, { userAgent: CHROME, clientAddress: null }, { mailer, now: start });
    for (let send = 1; send < APPROVAL_SENDS_PER_HOUR; send += 1) {
      await resendSignInApproval(first.claim, { mailer, now: at(start, send * APPROVAL_RESEND_INTERVAL_MS) });
    }

    /* A sixth attempt in the hour still gets a pending sign-in of its own --
       it must not fall through into a session -- but nothing is posted, and
       the card is told to read the mail that already went. */
    const next = await startSignInApproval(
      USER,
      { userAgent: CHROME, clientAddress: null },
      { mailer, now: at(start, 10 * 60 * 1000) },
    );
    expect(next.limited).toBe(true);
    expect(posted).toHaveLength(APPROVAL_SENDS_PER_HOUR);
    expect(await collectSignInApproval(next.claim)).toEqual({ state: "waiting" });
  });

  it("forgets a send once its hour has passed", async () => {
    const start = NINE;
    const first = await startSignInApproval(USER, { userAgent: CHROME, clientAddress: null }, { mailer, now: start });
    for (let send = 1; send < APPROVAL_SENDS_PER_HOUR; send += 1) {
      await resendSignInApproval(first.claim, { mailer, now: at(start, send * APPROVAL_RESEND_INTERVAL_MS) });
    }

    /* Past the hour measured from the LAST send, which is what sendsInWindow
       counts from -- see its own note for why it rounds that way. */
    const later = at(start, 70 * 60 * 1000);
    const fresh = await startSignInApproval(USER, { userAgent: CHROME, clientAddress: null }, { mailer, now: later });
    expect(fresh.limited).toBe(false);
    expect(posted).toHaveLength(APPROVAL_SENDS_PER_HOUR + 1);
  });

  it("refuses to resend for a sign-in that has already been answered", async () => {
    const start = NINE;
    const pending = await startSignInApproval(USER, { userAgent: CHROME, clientAddress: null }, { mailer, now: start });
    await decideSignInApproval(tokenFromLatestMail(), "denied");

    const outcome = await resendSignInApproval(pending.claim, {
      mailer,
      now: at(start, APPROVAL_RESEND_INTERVAL_MS),
    });
    expect(outcome).toEqual({ state: "unknown" });
  });
});
