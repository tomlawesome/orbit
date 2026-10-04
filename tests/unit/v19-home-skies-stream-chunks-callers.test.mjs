import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q13 (wiring half; the shared algorithm itself is pinned by
 * v19-home-skies-stream-chunks.test.mjs): confirms all four fill functions
 * — mountPlane's fill, mountTerminator's fill(L, offset), mountCloudSea's
 * fillStratum and fillPeaks — actually call the shared streamChunks()
 * rather than their own first/last loop, and that none still computes
 * first/last by hand.
 */

const SKIES = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/home/skies.js"),
  "utf8",
);

describe("#1151 W1-Q13: every fill function delegates to streamChunks", () => {
  it("exports streamChunks once, at module scope", () => {
    expect([...SKIES.matchAll(/export function streamChunks\(/gu)].length).toBe(1);
  });

  it("mountPlane's fill calls it with CW/BEHIND/AHEAD and the three-group append/remove", () => {
    const fn = SKIES.slice(SKIES.indexOf("function fill(offset) {"), SKIES.indexOf("function fill(offset) {") + 400);
    expect(fn).toMatch(/streamChunks\(live, offset, CW, BEHIND, AHEAD, build,/u);
    expect(fn).toMatch(/c\.gg\.remove\(\); c\.gs\.remove\(\); c\.gd\.remove\(\);/u);
  });

  it("mountTerminator's fill(L, offset) calls it with L.live/L.w", () => {
    const fn = SKIES.slice(SKIES.indexOf("function fill(L, offset) {"), SKIES.indexOf("function fill(L, offset) {") + 700);
    expect(fn).toMatch(/streamChunks\(L\.live, offset, L\.w, BEHIND, AHEAD,/u);
  });

  it("fillStratum calls it with L.live/L.w", () => {
    const fn = SKIES.slice(SKIES.indexOf("function fillStratum(L, off) {"), SKIES.indexOf("function fillStratum(L, off) {") + 400);
    expect(fn).toMatch(/streamChunks\(L\.live, off, L\.w, BEHIND, AHEAD,/u);
  });

  it("fillPeaks calls it with its own 400/400 margins, not a hand-rolled loop", () => {
    const fn = SKIES.slice(SKIES.indexOf("function fillPeaks(off) {"), SKIES.indexOf("function fillPeaks(off) {") + 500);
    expect(fn).toMatch(/streamChunks\(P\.live, off, P\.w, 400, 400,/u);
  });

  it("the first/last windowing arithmetic appears exactly once now, inside streamChunks itself", () => {
    expect([...SKIES.matchAll(/const first = Math\.floor/gu)].length).toBe(1);
    expect([...SKIES.matchAll(/if \(i < first \|\| i > last\)/gu)].length).toBe(1);
  });
});
