// The single in-process gate every Argon2id derivation passes through
// (ADR-0021 §4). Each derivation holds a 64 MiB arena for as long as it runs,
// so an ungated login flood is an out-of-memory risk on the smallest
// supported host (a 2 GB NAS) rather than a slow-request problem. Two
// concurrent derivations bound the transient cost at 128 MiB; everything
// beyond that waits in a bounded queue or is refused outright.
//
// A refusal is deliberately cheap and immediate: the caller answers with the
// same generic `too_many_attempts` the per-credential backoff uses, so a
// flood costs an attacker requests and tells them nothing.
//
// ADR-0001 (one instance) is what makes an in-process gate coherent: there is
// no second node whose derivations this one would have to know about.

/** At most this many derivations run at once; the memory bound is this × 64 MiB. */
export const VERIFICATION_MAX_CONCURRENT = 2;

/** Callers waiting for a slot. The 19th simultaneous caller (2 + 16) is refused. */
export const VERIFICATION_MAX_QUEUED = 16;

/** How long a queued caller waits for a slot before it is refused. */
export const VERIFICATION_QUEUE_WAIT_MS = 5_000;

/**
 * Why the gate turned a caller away. Both map to the same generic
 * `too_many_attempts` answer at the route; they are separate only so the
 * distinction survives in tests and diagnostics.
 */
export type VerificationRefusalReason = "queue_full" | "queue_timeout";

/** Thrown instead of running the task when the gate is saturated. */
export class VerificationGateRefusedError extends Error {
  constructor(public readonly reason: VerificationRefusalReason) {
    super(
      reason === "queue_full"
        ? "Too many password verifications are already queued"
        : "Waited too long for a password verification slot",
    );
    this.name = "VerificationGateRefusedError";
  }
}

export interface VerificationGateOptions {
  maxConcurrent?: number;
  maxQueued?: number;
  queueWaitMs?: number;
}

interface Waiter {
  admit: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export class VerificationGate {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly queueWaitMs: number;
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(options: VerificationGateOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? VERIFICATION_MAX_CONCURRENT;
    this.maxQueued = options.maxQueued ?? VERIFICATION_MAX_QUEUED;
    this.queueWaitMs = options.queueWaitMs ?? VERIFICATION_QUEUE_WAIT_MS;
  }

  /** Derivations running right now. Exposed for tests and diagnostics only. */
  get running(): number {
    return this.active;
  }

  /** Callers waiting for a slot. Exposed for tests and diagnostics only. */
  get waiting(): number {
    return this.queue.length;
  }

  /**
   * Runs `task` under the gate, waiting for a slot if one is not free.
   * Rejects with {@link VerificationGateRefusedError} without running the task
   * when the queue is full or the wait bound expires. The slot is released
   * whether the task resolves or throws.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new VerificationGateRefusedError("queue_full"));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.queue.findIndex((entry) => entry.timer === timer);
        if (index !== -1) this.queue.splice(index, 1);
        reject(new VerificationGateRefusedError("queue_timeout"));
      }, this.queueWaitMs);
      // A queued caller must never be the reason the process stays alive:
      // the timer exists to refuse a request, not to keep an event loop.
      timer.unref?.();
      this.queue.push({ admit: resolve, timer });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (!next) {
      this.active -= 1;
      return;
    }
    // The slot is handed straight over rather than freed and re-taken, so
    // `active` does not dip and a third caller cannot slip in between.
    clearTimeout(next.timer);
    next.admit();
  }
}

/** The gate the application uses. One process, one gate (ADR-0021 §4). */
export const verificationGate = new VerificationGate();
