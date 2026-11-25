/**
 * The archive slot's core (#1774, ADR-0047): one archive at a time per
 * process, and the first-come queue of those waiting for it. Moved here from
 * web/src/lib/server/archive-slot.js so the document worker's export job can
 * hold it; the web module keeps the request-bound parts (the held-request
 * map, the body watchdog, the upload lanes) and calls this. Behaviour moved,
 * not changed: see that file's header for why the slot exists.
 *
 * The state lives on `globalThis`, as the document worker's does, so the web
 * module and the engine share one holder however the module is loaded.
 */

/** How long a waiter waits for the slot before it gives up (#1792). */
export const ARCHIVE_SLOT_WAIT_MS = 600_000;

export interface ArchiveSlotClaim {
  release(): void;
  /** Whether this claim still holds the slot. */
  held(): boolean;
}

type Waiter = { hand(token: object): void };

const state = globalThis as typeof globalThis & {
  __orbitArchiveSlot?: { holder: object | null; waiting: Waiter[] };
};

function slot(): { holder: object | null; waiting: Waiter[] } {
  state.__orbitArchiveSlot ??= { holder: null, waiting: [] };
  return state.__orbitArchiveSlot;
}

/** Whether the slot is taken. */
export function archiveSlotHeld(): boolean {
  return slot().holder !== null;
}

/** The slot now, or null when it is held. Releasing twice is harmless. */
export function claimArchiveSlot(): ArchiveSlotClaim | null {
  const token = takeSlot();
  return token === null ? null : claimOf(token);
}

function configuredWaitMs(): number {
  const parsed = Number(process.env.ORBIT_ARCHIVE_SLOT_WAIT_MS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : ARCHIVE_SLOT_WAIT_MS;
}

/**
 * The slot at once when it is free and nobody waits, otherwise once every
 * waiter queued before has had it; null when the wait runs out (`waitMs`, or
 * ORBIT_ARCHIVE_SLOT_WAIT_MS read now, else ten minutes) or `until` or
 * `signal` aborts. Already aborted: null at once, even if the slot is free.
 */
export function awaitArchiveSlot(options: { waitMs?: number; until?: AbortSignal; signal?: AbortSignal } = {}): Promise<ArchiveSlotClaim | null> {
  const { until, signal } = options;
  if (until?.aborted || signal?.aborted) return Promise.resolve(null);
  const token = slot().waiting.length === 0 ? takeSlot() : null;
  if (token !== null) return Promise.resolve(claimOf(token));
  const wait = options.waitMs ?? configuredWaitMs();
  return new Promise((resolve) => {
    const detach = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", leave);
      until?.removeEventListener("abort", leave);
    };
    const leave = () => {
      detach();
      const queue = slot().waiting;
      const at = queue.indexOf(waiter);
      if (at !== -1) queue.splice(at, 1);
      resolve(null);
    };
    const waiter: Waiter = {
      hand(given) {
        detach();
        resolve(claimOf(given));
      },
    };
    const timer = setTimeout(leave, wait);
    /* unref: a waiter must never be what keeps the process alive. */
    timer.unref?.();
    signal?.addEventListener("abort", leave, { once: true });
    until?.addEventListener("abort", leave, { once: true });
    slot().waiting.push(waiter);
  });
}

function claimOf(token: object): ArchiveSlotClaim {
  return {
    release() {
      releaseSlot(token);
    },
    held() {
      return slot().holder === token;
    },
  };
}

/** Frees the slot, or hands it straight to the longest waiter. */
function releaseSlot(token: object): void {
  const current = slot();
  if (current.holder !== token) return;
  current.holder = null;
  const next = current.waiting.shift();
  if (next === undefined) return;
  next.hand(takeSlot() as object);
}

function takeSlot(): object | null {
  const current = slot();
  if (current.holder !== null) return null;
  const token = {};
  current.holder = token;
  return token;
}
