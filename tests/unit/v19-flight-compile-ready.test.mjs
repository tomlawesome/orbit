import { afterEach, describe, expect, it, vi } from "vitest";

import { FIT_KEY, rememberedFit, rememberFit } from "$lib/flight/fitness.js";

/*
 * #1310: the work between the flight world's compile and its being ready is
 * shortened. The fitness verdict is remembered per GPU and build, so a later
 * flight skips the timed frames; and the moon's picture goes on the GPU after
 * ready, not before. Shaped like v19-flight-gpu-verdict.test.mjs (stub the
 * page, reset modules per test).
 */

/** a localStorage of its own */
function memoryStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: vi.fn((k) => (m.has(k) ? m.get(k) : null)),
    setItem: vi.fn((k, v) => { m.set(k, String(v)); }),
    m,
  };
}

describe("the remembered fitness verdict (#1310)", () => {
  it("misses where nothing is remembered", () => {
    expect(rememberedFit(memoryStorage(), "ANGLE (NVIDIA)", "b1")).toBeNull();
    expect(rememberedFit(undefined, "ANGLE (NVIDIA)", "b1")).toBeNull();
  });

  it("hits for the same GPU and build, verdict and time as measured", () => {
    const s = memoryStorage();
    rememberFit(s, "ANGLE (NVIDIA)", "b1", { fit: true, ms: 6.24 });
    expect(rememberedFit(s, "ANGLE (NVIDIA)", "b1")).toEqual({ fit: true, ms: 6.2 });
    rememberFit(s, "ANGLE (NVIDIA)", "b1", { fit: false, ms: 48 });
    expect(rememberedFit(s, "ANGLE (NVIDIA)", "b1")).toEqual({ fit: false, ms: 48 });
  });

  it("misses on a new build, failing or passing: no verdict outlives its build", () => {
    const s = memoryStorage();
    rememberFit(s, "ANGLE (NVIDIA)", "b1", { fit: false, ms: 48 });
    expect(rememberedFit(s, "ANGLE (NVIDIA)", "b2")).toBeNull();
    rememberFit(s, "ANGLE (NVIDIA)", "b1", { fit: true, ms: 6 });
    expect(rememberedFit(s, "ANGLE (NVIDIA)", "b2")).toBeNull();
  });

  it("misses on another GPU", () => {
    const s = memoryStorage();
    rememberFit(s, "ANGLE (NVIDIA)", "b1", { fit: true, ms: 6 });
    expect(rememberedFit(s, "ANGLE (Intel)", "b1")).toBeNull();
  });

  it("never keeps a frame that failed to draw, nor a verdict without a GPU name or build", () => {
    const s = memoryStorage();
    rememberFit(s, "ANGLE (NVIDIA)", "b1", { fit: false, ms: Infinity });
    rememberFit(s, "", "b1", { fit: true, ms: 6 });
    rememberFit(s, "ANGLE (NVIDIA)", "", { fit: true, ms: 6 });
    expect(s.setItem).not.toHaveBeenCalled();
  });

  it("reads garbage, or a storage that throws, as nothing remembered", () => {
    expect(rememberedFit(memoryStorage({ [FIT_KEY]: "{not json" }), "ANGLE (NVIDIA)", "b1")).toBeNull();
    const throws = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(rememberedFit(throws, "ANGLE (NVIDIA)", "b1")).toBeNull();
    expect(() => rememberFit(throws, "ANGLE (NVIDIA)", "b1", { fit: true, ms: 6 })).not.toThrow();
  });
});

/*
 * The world itself, on a WebGL2 context that records what it is asked. Every
 * method is a no-op that logs its call; every constant a number of its own.
 * Chores queue, and the test runs them, so what lands before ready can be
 * seen. The pictures arrive at once, each an "image" naming its file.
 */
function fakeGl(log) {
  const consts = new Map();
  /** @type {any} */
  let bound = null;
  let unit = 0;
  const units = new Map();
  const pictures = new Map();
  let ids = 0;
  const methods = {
    getExtension: () => ({}),
    isContextLost: () => false,
    getProgramParameter: (_p, what) => (what === consts.get("ACTIVE_UNIFORMS") ? 0 : true),
    createTexture: () => ({ texture: ++ids }),
    bindTexture: (_t, t) => { bound = t; units.set(unit, t); },
    activeTexture: (u) => { unit = u - consts.get("TEXTURE0"); },
    texImage2D: (...a) => {
      const src = a[a.length - 1];
      if (src && src.picture) { pictures.set(src.picture, bound); log.push(`upload ${src.picture}`); }
    },
    readPixels: () => log.push("readPixels"),
    createFramebuffer: () => (log.push("target"), {}),
    drawArrays: () => log.push(`draw (moon unit: ${pictureOn(5)})`),
  };
  const pictureOn = (u) => [...pictures].find(([, t]) => t === units.get(u))?.[0] ?? "blank";
  const gl = new Proxy({}, {
    get(_o, k) {
      if (typeof k !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(k)) { if (!consts.has(k)) consts.set(k, 0x8000 + consts.size); return consts.get(k); }
      return methods[k] ?? (() => ({}));
    },
  });
  return { gl, pictures };
}

function stubWorld({ storage = memoryStorage(), build = "b1", renderer = "ANGLE (NVIDIA)", dpr = 1, width = 800, height = 600 } = {}) {
  const log = [];
  const { gl, pictures } = fakeGl(log);
  const canvas = { id: "", style: {}, width: 0, height: 0, setAttribute() {}, addEventListener() {} };
  /** @type {(() => unknown)[]} */
  const jobs = [];
  vi.doMock("$app/environment", () => ({ building: false, version: build }));
  vi.doMock("$lib/flight/chores.js", () => ({
    chore: (fn) => new Promise((resolve, reject) => { jobs.push(() => { try { resolve(fn()); } catch (e) { reject(e); } }); }),
    fetchOnce: (url) => Promise.resolve({ url }),
    note: (what) => log.push(what),
  }));
  vi.doMock("$lib/flight/fitness.js", async (actual) => ({
    ...(await actual()),
    gpu: () => ({ canvas, gl, parallel: false, renderer }),
    sayVerdict: (v) => log.push(`verdict ${v}`),
  }));
  vi.stubGlobal("document", { hidden: true });
  vi.stubGlobal("window", { devicePixelRatio: dpr });
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("createImageBitmap", (blob) => Promise.resolve({ picture: blob.url.split("/").pop(), close() {} }));
  /** run every chore queued, and those they queue, until none is left (or `until` is logged) */
  const settle = async (until) => {
    for (let spins = 0; spins < 200; spins++) {
      await new Promise((r) => setTimeout(r, 0));
      if (until && log.includes(until)) return;
      const job = jobs.shift();
      if (job) job();
    }
  };
  return { log, pictures, settle, storage };
}

afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock("$app/environment"); vi.doUnmock("$lib/flight/chores.js"); vi.doUnmock("$lib/flight/fitness.js"); vi.resetModules(); });

describe("readying the flight's world (#1310)", () => {
  it("a miss measures the frames as before, and remembers the verdict for this GPU and build", async () => {
    const { log, settle, storage } = stubWorld();
    const { voyageOnce } = await import("$lib/flight/voyage.js");
    const w = /** @type {any} */ (voyageOnce());
    const warmed = w.warm();
    await settle();
    await warmed;
    expect(w.ready).toBe(true);
    /* two warm-up draws, then the fitness test's own frames, each read back */
    expect(log.filter((l) => l === "readPixels").length).toBeGreaterThan(2);
    expect(log.find((l) => l.startsWith("verdict"))).toMatch(/^verdict on \(frame \d+ ms\)$/);
    expect(JSON.parse(storage.m.get(FIT_KEY))).toMatchObject({ renderer: "ANGLE (NVIDIA)", build: "b1", fit: true });
  });

  it("a hit skips the test frames: only the two warm-up draws are read back", async () => {
    const storage = memoryStorage({ [FIT_KEY]: JSON.stringify({ renderer: "ANGLE (NVIDIA)", build: "b1", fit: true, ms: 7 }) });
    const { log, settle } = stubWorld({ storage });
    const { voyageOnce } = await import("$lib/flight/voyage.js");
    const w = /** @type {any} */ (voyageOnce());
    const warmed = w.warm();
    await settle();
    await warmed;
    expect(w.ready).toBe(true);
    expect(log.filter((l) => l === "readPixels")).toHaveLength(2);
    expect(log).toContain("verdict on: frame 7 ms, remembered for this GPU and build");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("a remembered failing verdict keeps the world off for the same build", async () => {
    const storage = memoryStorage({ [FIT_KEY]: JSON.stringify({ renderer: "ANGLE (NVIDIA)", build: "b1", fit: false, ms: 48 }) });
    const { log, settle } = stubWorld({ storage });
    const { voyageOnce } = await import("$lib/flight/voyage.js");
    const w = /** @type {any} */ (voyageOnce());
    const warmed = w.warm();
    await settle();
    await warmed;
    expect(w.ready).toBe(false);
    expect(log.filter((l) => l === "readPixels")).toHaveLength(2);
  });

  it("a new build measures again, even after a failing verdict", async () => {
    const storage = memoryStorage({ [FIT_KEY]: JSON.stringify({ renderer: "ANGLE (NVIDIA)", build: "b1", fit: false, ms: 48 }) });
    const { log, settle } = stubWorld({ storage, build: "b2" });
    const { voyageOnce } = await import("$lib/flight/voyage.js");
    const w = /** @type {any} */ (voyageOnce());
    const warmed = w.warm();
    await settle();
    await warmed;
    expect(w.ready).toBe(true);
    expect(log.filter((l) => l === "readPixels").length).toBeGreaterThan(2);
    expect(JSON.parse(storage.m.get(FIT_KEY))).toMatchObject({ build: "b2", fit: true });
  });
});

/** a frame of the climb at ascent time `tu` */
const frameAt = (tu) => ({ t: tu, v: 1, K: 7.4, vp: [400, -330], rmax: 1500, tint: [1, 0.8, 0.4],
  progress: 0.4, world: null, bloom: 0, tu, star: true, dt: 16 });

describe("the moon goes on the GPU after ready (#1310)", () => {
  it("every other map is uploaded before ready, the moon after it", async () => {
    const { log, settle } = stubWorld();
    const { voyageOnce } = await import("$lib/flight/voyage.js");
    const w = /** @type {any} */ (voyageOnce());
    const warmed = w.warm();
    await settle();
    await warmed;
    const ready = log.indexOf("flight: ready");
    expect(ready).toBeGreaterThan(-1);
    for (const p of ["earth-lights.webp", "europe-lights.webp", "earth-clouds.webp", "earth-day.webp", "galaxy-2k.webp"]) {
      expect(log.indexOf(`upload ${p}`)).toBeGreaterThan(-1);
      expect(log.indexOf(`upload ${p}`)).toBeLessThan(ready);
    }
    expect(log.indexOf("upload moon.webp")).toBeGreaterThan(ready);
    expect(log.indexOf("flight: moon on the GPU")).toBeGreaterThan(ready);
    /* the warm-up draws never put it there themselves */
    expect(log.slice(0, ready).filter((l) => l.startsWith("draw")).every((l) => l.endsWith("moon unit: blank)"))).toBe(true);
  });

  it("ready does not wait for the moon's upload", async () => {
    const { log, settle } = stubWorld();
    const { voyageOnce } = await import("$lib/flight/voyage.js");
    const w = /** @type {any} */ (voyageOnce());
    w.warm();
    await settle("flight: ready");
    expect(w.ready).toBe(true);
    expect(log).not.toContain("upload moon.webp");
  });

  it("a frame that shows the moon before its chore has run uploads it first, and draws it", async () => {
    const { log, settle } = stubWorld();
    const { voyageOnce } = await import("$lib/flight/voyage.js");
    const w = /** @type {any} */ (voyageOnce());
    w.warm();
    await settle("flight: ready");
    const before = log.length;
    w.draw(frameAt(100));
    /* no moon yet at 100 ms: nothing uploaded */
    expect(log.slice(before)).not.toContain("upload moon.webp");
    const mid = log.length;
    w.draw(frameAt(900));
    const after = log.slice(mid);
    expect(after[0]).toBe("upload moon.webp");
    expect(after.filter((l) => l.startsWith("draw"))[0]).toBe("draw (moon unit: moon.webp)");
    /* the chore then finds it done, and uploads nothing more */
    await settle();
    expect(log.filter((l) => l === "upload moon.webp")).toHaveLength(1);
  });

  it("a world that is not ready never puts the moon on the GPU", async () => {
    const storage = memoryStorage({ [FIT_KEY]: JSON.stringify({ renderer: "ANGLE (NVIDIA)", build: "b1", fit: false, ms: 48 }) });
    const { log, settle } = stubWorld({ storage });
    const { voyageOnce } = await import("$lib/flight/voyage.js");
    const w = /** @type {any} */ (voyageOnce());
    await Promise.all([w.warm(), settle()]);
    expect(log).not.toContain("upload moon.webp");
  });
});

describe("the fitness test remakes the render targets only when their size changes (#1310)", () => {
  /** the render targets (framebuffers) made while the world is readied, measured or not */
  async function targetsMade(how) {
    const remembered = { [FIT_KEY]: JSON.stringify({ renderer: "ANGLE (NVIDIA)", build: "b1", fit: true, ms: 7 }) };
    const { log, settle } = stubWorld({ ...how, storage: memoryStorage(how.remembered ? remembered : {}) });
    const { voyageOnce } = await import("$lib/flight/voyage.js");
    const w = /** @type {any} */ (voyageOnce());
    await Promise.all([w.warm(), settle()]);
    vi.unstubAllGlobals(); vi.resetModules();
    return log.filter((l) => l === "target").length;
  }

  it("on a large dense screen, where the pixel cap sets the size at both scales, the test remakes none", async () => {
    const screen = { dpr: 2, width: 2560, height: 1440 };
    const skipped = await targetsMade({ ...screen, remembered: true });
    expect(await targetsMade(screen)).toBe(skipped);
  });

  it("where the test's smaller scale is a smaller drawing, it still draws at it and goes back", async () => {
    const screen = { dpr: 1, width: 800, height: 600 };
    const skipped = await targetsMade({ ...screen, remembered: true });
    /* the HDR target and five bloom halvings, made twice */
    expect(await targetsMade(screen)).toBe(skipped + 12);
  });
});
