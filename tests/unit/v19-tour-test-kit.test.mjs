import { describe, expect, it } from "vitest";

import { playOut } from "./v19-tour-test-kit.mjs";

/* #1360: nine chapter tests' own playOut copies returned normally when a
   chapter hung. The shared one must fail the test instead. */
const clock = () => {
  let now = 0;
  return { advance: (ms) => { now += ms; }, get now() { return now; } };
};

describe("playOut (#1360)", () => {
  it("returns the simulated time a finished chapter took", async () => {
    const film = clock();
    const chapter = new Promise((done) => { const wait = () => (film.now >= 300 ? done() : setTimeout(wait, 0)); wait(); });
    expect(await playOut(film, chapter)).toBeGreaterThanOrEqual(300);
  });

  it("throws when the chapter never finishes", async () => {
    await expect(playOut(clock(), new Promise(() => {}), { cap: 1000 })).rejects.toThrow(/did not finish within 1000ms/);
  });

  it("throws the chapter's own error when it fails", async () => {
    await expect(playOut(clock(), Promise.reject(new Error("chapter broke")))).rejects.toThrow("chapter broke");
  });

  it("refuses the old positional step", async () => {
    await expect(playOut(clock(), Promise.resolve(), 70)).rejects.toThrow(TypeError);
  });
});
