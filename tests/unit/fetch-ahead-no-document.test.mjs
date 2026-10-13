import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * fetch-ahead.js is imported by pages that are also rendered on the server,
 * where there is no `document`. It must return without fetching or queueing
 * anything there. Nothing else stops it in this test: motion is not reduced and
 * save-data is off, so only the `document` guard can.
 */
describe("fetchFlightAhead with no document (server-side rendering)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("$lib/door-host.js");
    vi.doUnmock("$lib/gpu.js");
    vi.resetModules();
  });

  it("returns without fetching, queueing or asking the GPU", async () => {
    vi.resetModules();
    const fetchOnce = vi.fn(() => Promise.resolve());
    const chore = vi.fn((fn) => Promise.resolve().then(fn));
    const hurryChores = vi.fn();
    const openChores = vi.fn();
    const gpu = vi.fn(() => ({ parallel: true }));
    vi.doMock("$lib/door-host.js", () => ({
      chore, fetchOnce, hurryChores, openChores,
      image: (p) => `/img/${p}`, flightPictures: () => ["/img/flight/a.webp"],
    }));
    vi.doMock("$lib/gpu.js", () => ({ gpu }));
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("navigator", { connection: { saveData: false } });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(typeof document).toBe("undefined");

    const { fetchFlightAhead } = await import("$lib/flight/fetch-ahead.js");
    expect(() => fetchFlightAhead()).not.toThrow();
    expect(() => fetchFlightAhead({ hurry: true })).not.toThrow();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(fetchOnce).not.toHaveBeenCalled();
    expect(chore).not.toHaveBeenCalled();
    expect(gpu).not.toHaveBeenCalled();
    expect(openChores).not.toHaveBeenCalled();
    expect(hurryChores).not.toHaveBeenCalled();
  });

  it("does fetch once a document exists, so the test above is not vacuous", async () => {
    vi.resetModules();
    const fetchOnce = vi.fn(() => Promise.resolve());
    vi.doMock("$lib/door-host.js", () => ({
      chore: (fn) => Promise.resolve().then(fn), fetchOnce, hurryChores: vi.fn(), openChores: vi.fn(),
      image: (p) => `/img/${p}`, flightPictures: () => [],
    }));
    vi.doMock("$lib/gpu.js", () => ({ gpu: () => null }));
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", { connection: { saveData: false } });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { fetchFlightAhead } = await import("$lib/flight/fetch-ahead.js");
    fetchFlightAhead();
    expect(fetchOnce).toHaveBeenCalledWith("/img/dawn/dawn.webp");
  });
});
