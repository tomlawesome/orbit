import { Agent } from "node:https";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1929 part 2 (ruling, note 67125): the push POST connects only to an address
 * that passed the same range check the endpoint literal check uses. Written
 * from the ruling alone. Items refer to its numbered "What the code must do".
 */

const webPushMock = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(async () => ({ statusCode: 201, body: "", headers: {} })),
}));
vi.mock("web-push", () => ({ default: webPushMock }));

// The agent's lookup wraps dns.lookup; the stand-in answers from `dnsAnswer`.
const dnsState = vi.hoisted(() => ({
  answer: [] as Array<{ address: string; family: number }>,
  error: null as Error | null,
  calls: [] as Array<{ hostname: string; options: Record<string, unknown> }>,
}));
const fakeLookup = vi.hoisted(() => (
  hostname: string,
  options: unknown,
  callback?: (error: Error | null, address?: unknown, family?: number) => void,
) => {
  const cb = (typeof options === "function" ? options : callback) as (error: Error | null, address?: unknown, family?: number) => void;
  const opts = (typeof options === "function" ? {} : options ?? {}) as Record<string, unknown>;
  dnsState.calls.push({ hostname, options: opts });
  if (dnsState.error) return cb(dnsState.error);
  if (opts.all) return cb(null, dnsState.answer);
  return cb(null, dnsState.answer[0]?.address, dnsState.answer[0]?.family);
});
vi.mock("node:dns", () => ({ default: { lookup: fakeLookup }, lookup: fakeLookup }));
vi.mock("dns", () => ({ default: { lookup: fakeLookup }, lookup: fakeLookup }));

import {
  BlockedPushEndpointError,
  categorizeProviderError,
  createDefaultNotificationProviders,
  getNotificationWorkerConfig,
  type PushNotification,
  isAllowedPushEndpoint,
  isBlockedPushAddress,
  isRevokedPushFailure,
  NOTIFICATION_PROVIDER_TIMEOUT_MS,
} from "./notification-worker";
import { log } from "@/lib/logger";

const ENDPOINT = "https://push.services.example.test/sub/abc123";
const HIDDEN_HOST = "secret-host.push.example.test";

function providers() {
  return createDefaultNotificationProviders(getNotificationWorkerConfig({
    NODE_ENV: "test",
    VAPID_SUBJECT: "mailto:ops@example.test",
    VAPID_PUBLIC_KEY: "public-key",
    VAPID_PRIVATE_KEY: "private-key",
  } as NodeJS.ProcessEnv));
}

type LookupFn = (
  hostname: string,
  options: Record<string, unknown>,
  callback: (error: Error | null, addresses?: Array<{ address: string; family: number }>) => void,
) => void;

async function sendAndCaptureAgent(): Promise<Agent> {
  webPushMock.sendNotification.mockClear();
  await providers().sendPush({
    target: { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } },
    payload: { title: "Due today", body: "An item", url: "/" },
  });
  const [, , options] = webPushMock.sendNotification.mock.calls[0] as unknown as [unknown, unknown, { agent?: Agent }];
  return options.agent as Agent;
}

function agentLookup(agent: Agent): LookupFn {
  return (agent as unknown as { options: { lookup: LookupFn } }).options.lookup;
}

function runLookup(lookup: LookupFn, hostname = HIDDEN_HOST, options: Record<string, unknown> = { all: true }) {
  return new Promise<{ error: Error | null; addresses?: Array<{ address: string; family: number }> }>((resolve) => {
    lookup(hostname, options, (error, addresses) => resolve({ error, addresses }));
  });
}

beforeEach(() => {
  dnsState.answer = [];
  dnsState.error = null;
  dnsState.calls = [];
});

const BLOCKED: Array<[string, number]> = [
  ["127.0.0.1", 4],
  ["::1", 6],
  ["::ffff:7f00:1", 6],
  ["::ffff:a00:5", 6],
  ["64:ff9b::7f00:1", 6],
  ["2002::", 6],
  ["fec0::1", 6],
  ["ff02::1", 6],
  ["::", 6],
];
// A public IPv4 cannot be written here (the commit scan refuses every IPv4
// literal outside 127/8 and the documentation ranges, which are reserved), so
// the allowed case is the public IPv6 prefix 2606::.
const PUBLIC: Array<[string, number]> = [["2606::", 6]];

describe("item 1: one address predicate", () => {
  it.each(BLOCKED)("isBlockedPushAddress refuses %s", (address) => {
    expect(isBlockedPushAddress(address)).toBe(true);
  });

  it.each(PUBLIC)("isBlockedPushAddress allows public %s", (address) => {
    expect(isBlockedPushAddress(address)).toBe(false);
  });

  it.each(BLOCKED.filter(([address]) => address.includes(":")))(
    "refuses %s as a literal endpoint and as the resolved address of a hostname alike",
    async (address, family) => {
      expect(isAllowedPushEndpoint(`https://[${address}]/probe`)).toBe(false);
      const agent = await sendAndCaptureAgent();
      dnsState.answer = [{ address, family }];
      const { error, addresses } = await runLookup(agentLookup(agent));
      expect(error).toBeInstanceOf(BlockedPushEndpointError);
      expect(addresses).toBeUndefined();
    },
  );

  it("refuses 127.0.0.1 as a resolved address of a hostname", async () => {
    const agent = await sendAndCaptureAgent();
    dnsState.answer = [{ address: "127.0.0.1", family: 4 }];
    const { error, addresses } = await runLookup(agentLookup(agent));
    expect(error).toBeInstanceOf(BlockedPushEndpointError);
    expect(addresses).toBeUndefined();
  });

  it("lets a public resolved address through", async () => {
    const agent = await sendAndCaptureAgent();
    dnsState.answer = [{ address: "2606::", family: 6 }];
    const { error, addresses } = await runLookup(agentLookup(agent));
    expect(error).toBeNull();
    expect(addresses).toEqual([{ address: "2606::", family: 6 }]);
  });
});

describe("item 2: the agent", () => {
  it("passes sendNotification an https.Agent whose lookup filters resolved addresses", async () => {
    const agent = await sendAndCaptureAgent();
    expect(agent).toBeInstanceOf(Agent);
    expect(typeof agentLookup(agent)).toBe("function");
  });

  it("keeps the options Node passes to the lookup (all, hints, family) when calling dns.lookup", async () => {
    const agent = await sendAndCaptureAgent();
    dnsState.answer = [{ address: "2606::", family: 6 }];
    await runLookup(agentLookup(agent), HIDDEN_HOST, { all: true, hints: 1024, family: 6 });
    const call = dnsState.calls.at(-1)!;
    expect(call.hostname).toBe(HIDDEN_HOST);
    expect(call.options).toMatchObject({ all: true, hints: 1024, family: 6 });
  });

  it("passes a resolution failure through unchanged", async () => {
    const agent = await sendAndCaptureAgent();
    const failure = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    dnsState.error = failure;
    const { error, addresses } = await runLookup(agentLookup(agent));
    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(BlockedPushEndpointError);
    expect(addresses).toBeUndefined();
  });
});

describe("item 3: all or nothing on the address list", () => {
  it("refuses the whole connection when one resolved address is blocked, giving no addresses", async () => {
    const agent = await sendAndCaptureAgent();
    dnsState.answer = [{ address: "2606::", family: 6 }, { address: "127.0.0.1", family: 4 }];
    const { error, addresses } = await runLookup(agentLookup(agent));
    expect(error).toBeInstanceOf(BlockedPushEndpointError);
    expect(addresses).toBeUndefined();
  });

  it("refuses when the blocked address comes first, too", async () => {
    const agent = await sendAndCaptureAgent();
    dnsState.answer = [{ address: "127.0.0.1", family: 4 }, { address: "2606::", family: 6 }];
    const { error } = await runLookup(agentLookup(agent));
    expect(error).toBeInstanceOf(BlockedPushEndpointError);
  });

  it("passes an all-public list through unchanged: same objects, same order", async () => {
    const agent = await sendAndCaptureAgent();
    const first = { address: "2606::", family: 6 };
    const second = { address: "2606::", family: 6 };
    dnsState.answer = [first, second];
    const { error, addresses } = await runLookup(agentLookup(agent));
    expect(error).toBeNull();
    expect(addresses).toHaveLength(2);
    expect(addresses![0]).toBe(first);
    expect(addresses![1]).toBe(second);
  });
});

describe("item 4: the error", () => {
  it("is an Error with code EPUSH_ENDPOINT_BLOCKED, no statusCode, and fixed text that names no host or address", async () => {
    const agent = await sendAndCaptureAgent();
    dnsState.answer = [{ address: "127.0.0.1", family: 4 }];
    const { error } = await runLookup(agentLookup(agent), HIDDEN_HOST);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(BlockedPushEndpointError);
    expect((error as { code?: string }).code).toBe("EPUSH_ENDPOINT_BLOCKED");
    expect((error as { statusCode?: unknown }).statusCode).toBeUndefined();
    const text = `${String(error)} ${error!.message} ${error!.stack ?? ""}`;
    expect(text).not.toContain(HIDDEN_HOST);
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("secret-host");
  });

  it("is also constructible directly with the same code and no statusCode", () => {
    const error = new BlockedPushEndpointError();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("EPUSH_ENDPOINT_BLOCKED");
    expect((error as { statusCode?: unknown }).statusCode).toBeUndefined();
  });
});

describe("item 5: classification", () => {
  /* Flipped by #1943 A-R4 (ruling note 68569): a blocked resolver answer is
     the network, not the push service, so it is transient. */
  it("categorises a BlockedPushEndpointError as push_unavailable, while 410 stays push_unsubscribed (#1943 A-R4)", () => {
    expect(categorizeProviderError("web_push", new BlockedPushEndpointError())).toBe("push_unavailable");
    expect(categorizeProviderError("web_push", { statusCode: 410 })).toBe("push_unsubscribed");
  });

  it("isRevokedPushFailure is false for a BlockedPushEndpointError, still with its one warn line, and true for 410 (#1943 A-R4)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    try {
      expect(isRevokedPushFailure(new BlockedPushEndpointError(), "sub-1943")).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({ reason: "push_endpoint_blocked" });
      expect(isRevokedPushFailure({ statusCode: 410 }, "sub-1943")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("item 8: TLS unchanged", () => {
  it("sets no servername, rejectUnauthorized or checkServerIdentity on the agent", async () => {
    const agent = await sendAndCaptureAgent();
    const options = (agent as unknown as { options: Record<string, unknown> }).options;
    expect(options).not.toHaveProperty("servername");
    expect(options).not.toHaveProperty("rejectUnauthorized");
    expect(options).not.toHaveProperty("checkServerIdentity");
  });
});

describe("item 9: timeouts unchanged", () => {
  it("keeps the 5 s timeout on every sendNotification call, alongside agent", async () => {
    webPushMock.sendNotification.mockClear();
    const p = providers();
    const notification: PushNotification = {
      target: { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } },
      payload: { title: "Due today", body: "An item", url: "/" },
    };
    await p.sendPush(notification);
    await p.sendPush(notification);
    expect(webPushMock.sendNotification).toHaveBeenCalledTimes(2);
    for (const call of webPushMock.sendNotification.mock.calls as unknown as Array<[unknown, unknown, { timeout?: number; agent?: unknown }]>) {
      expect(call[2].timeout).toBe(NOTIFICATION_PROVIDER_TIMEOUT_MS);
      expect(call[2].agent).toBeInstanceOf(Agent);
    }
  });
});

describe("item 11: agent lifetime", () => {
  it("hands two sendPush calls on one providers object the same agent, with keepAlive left off", async () => {
    webPushMock.sendNotification.mockClear();
    const p = providers();
    const notification: PushNotification = {
      target: { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } },
      payload: { title: "Due today", body: "An item", url: "/" },
    };
    await p.sendPush(notification);
    await p.sendPush(notification);
    const calls = webPushMock.sendNotification.mock.calls as unknown as Array<[unknown, unknown, { agent?: Agent }]>;
    expect(calls[0]![2].agent).toBeDefined();
    expect(calls[1]![2].agent).toBe(calls[0]![2].agent);
    const options = (calls[0]![2].agent as unknown as { options: { keepAlive?: boolean } }).options;
    expect(options.keepAlive ?? false).toBe(false);
  });
});
