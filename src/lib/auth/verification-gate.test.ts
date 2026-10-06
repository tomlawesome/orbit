import { describe, expect, it } from "vitest";
import {
  VERIFICATION_MAX_CONCURRENT,
  VERIFICATION_MAX_QUEUED,
  VERIFICATION_QUEUE_WAIT_MS,
  VerificationGate,
} from "./verification-gate";

/** A promise this test resolves by hand, standing in for a derivation. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("the Argon2id verification gate", () => {
  it("ships the limits ADR-0021 §4 fixed", () => {
    expect(VERIFICATION_MAX_CONCURRENT).toBe(2);
    expect(VERIFICATION_MAX_QUEUED).toBe(16);
    expect(VERIFICATION_QUEUE_WAIT_MS).toBe(5_000);
  });

  it("runs two derivations, queues sixteen, refuses the nineteenth caller", async () => {
    const gate = new VerificationGate();
    const tasks = Array.from({ length: 18 }, () => deferred<string>());
    const runs = tasks.map((task, index) => gate.run(async () => `${await task.promise}-${index}`));

    expect(gate.running).toBe(2);
    expect(gate.waiting).toBe(16);

    await expect(gate.run(async () => "nineteenth")).rejects.toMatchObject({
      name: "VerificationGateRefusedError",
      reason: "queue_full",
    });

    // Completing one hands its slot to the head of the queue rather than
    // leaving the gate idle.
    tasks[0].resolve("done");
    await expect(runs[0]).resolves.toBe("done-0");
    expect(gate.running).toBe(2);
    expect(gate.waiting).toBe(15);

    for (const task of tasks) task.resolve("done");
    await Promise.all(runs);
    expect(gate.running).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it("refuses a caller that waits longer than the queue bound", async () => {
    const gate = new VerificationGate({ maxConcurrent: 1, maxQueued: 4, queueWaitMs: 20 });
    const blocker = deferred<string>();
    const held = gate.run(() => blocker.promise);

    await expect(gate.run(async () => "queued")).rejects.toMatchObject({ reason: "queue_timeout" });
    expect(gate.waiting).toBe(0);

    blocker.resolve("held");
    await expect(held).resolves.toBe("held");
    expect(gate.running).toBe(0);
  });

  it("releases the slot when the task throws", async () => {
    const gate = new VerificationGate({ maxConcurrent: 1, maxQueued: 1 });

    await expect(gate.run(async () => {
      throw new Error("derivation failed");
    })).rejects.toThrow("derivation failed");

    expect(gate.running).toBe(0);
    await expect(gate.run(async () => "after")).resolves.toBe("after");
  });
});
