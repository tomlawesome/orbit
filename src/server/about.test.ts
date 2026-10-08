import { afterEach, describe, expect, it, vi } from "vitest";

import { getAboutFacts, imageOf, versionAfter, versionOnly, type AboutProbes } from "@/server/about";

/*
 * The About page's first card (#1256): each sidecar's own version, "off"
 * for one that is switched off, and null -- drawn "not known" -- for every
 * answer that cannot be read. Never a hostname, URL or error string.
 */

const HEALTHY: AboutProbes = {
  postgres: async () => "PostgreSQL 18.0 on x86_64-pc-linux-musl, compiled by gcc (Alpine 14.2.0) 14.2.0, 64-bit",
  tika: async () => "Apache Tika 4.1.0",
  clamav: async () => "ClamAV 1.5.4/27800/Mon Oct  6 09:12:00 2026",
  ollama: async () => "0.35.1",
  tikaOn: () => true,
  clamavOn: () => true,
  ollamaOn: () => true,
};

const ROW = (facts: Awaited<ReturnType<typeof getAboutFacts>>, id: string) =>
  facts.sidecars.find((sidecar) => sidecar.id === id);

describe("getAboutFacts (#1256)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("reads each sidecar's own version out of its own answer", async () => {
    const facts = await getAboutFacts(HEALTHY, {});
    expect(facts.sidecars).toEqual([
      { id: "postgres", state: "running", version: "18.0" },
      { id: "tika", state: "running", version: "4.1.0" },
      { id: "clamav", state: "running", version: "1.5.4" },
      { id: "ollama", state: "running", version: "0.35.1" },
    ]);
    expect(facts.node).toBe(process.version);
  });

  it("carries the build stamp and the image the launcher passed through", async () => {
    vi.stubEnv("ORBIT_VERSION", "0.3.0");
    vi.stubEnv("ORBIT_CHANNEL", "preview");
    vi.stubEnv("ORBIT_REVISION", "fd6a7e6c0b1d");
    const digest = `sha256:${"ab".repeat(32)}`;
    const facts = await getAboutFacts(HEALTHY, { ORBIT_IMAGE: `ghcr.io/example/orbit@${digest}` });
    expect(facts.build).toEqual({ version: "0.3.0", channel: "preview", revision: "fd6a7e6c0b1d", image: digest });
  });

  it("falls back to null -- 'not known' -- for an unset build stamp and image", async () => {
    vi.stubEnv("ORBIT_VERSION", "");
    vi.stubEnv("ORBIT_CHANNEL", "");
    vi.stubEnv("ORBIT_REVISION", "");
    const facts = await getAboutFacts(HEALTHY, {});
    expect(facts.build).toEqual({ version: null, channel: null, revision: null, image: null });
  });

  it("says off, and asks nothing, for a sidecar that is switched off", async () => {
    const tika = vi.fn(HEALTHY.tika);
    const ollama = vi.fn(HEALTHY.ollama);
    const facts = await getAboutFacts({ ...HEALTHY, tika, ollama, tikaOn: () => false, ollamaOn: () => false }, {});
    expect(ROW(facts, "tika")).toEqual({ id: "tika", state: "off", version: null });
    expect(ROW(facts, "ollama")).toEqual({ id: "ollama", state: "off", version: null });
    expect(tika).not.toHaveBeenCalled();
    expect(ollama).not.toHaveBeenCalled();
  });

  it("gives null for a failing, unreadable or silent version call -- on that row only", async () => {
    vi.useFakeTimers();
    const facts = getAboutFacts({
      ...HEALTHY,
      tika: async () => { throw new Error("connect ECONNREFUSED orbit-tika:9998"); },
      clamav: async () => "<html>gateway error from proxy.internal.example</html>",
      ollama: () => new Promise(() => {}),
    }, {});
    await vi.advanceTimersByTimeAsync(2_500);
    const settled = await facts;
    expect(ROW(settled, "postgres")?.version).toBe("18.0");
    expect(ROW(settled, "tika")).toEqual({ id: "tika", state: "running", version: null });
    expect(ROW(settled, "clamav")).toEqual({ id: "clamav", state: "running", version: null });
    expect(ROW(settled, "ollama")).toEqual({ id: "ollama", state: "running", version: null });
  });

  it("treats a check that throws as off rather than failing the read", async () => {
    const facts = await getAboutFacts({ ...HEALTHY, clamavOn: () => { throw new Error("bad config"); } }, {});
    expect(ROW(facts, "clamav")?.state).toBe("off");
  });

  it("never lets a hostname, URL or error text into the answer", async () => {
    const leaky: AboutProbes = {
      postgres: async () => "PostgreSQL db.internal.example refused",
      tika: async () => "Apache Tika http://orbit-tika:9998/version",
      clamav: async () => { throw new Error("orbit-clamav:3310 timed out"); },
      ollama: async () => "http://orbit-ollama:11434",
      tikaOn: () => true,
      clamavOn: () => true,
      ollamaOn: () => true,
    };
    const facts = await getAboutFacts(leaky, { ORBIT_IMAGE: `registry.internal.example:5000/orbit@sha256:${"cd".repeat(32)}` });
    const text = JSON.stringify(facts);
    expect(text).not.toMatch(/internal\.example|orbit-tika|orbit-clamav|orbit-ollama|http|:\d{2,5}\b|refused|timed out/);
    expect(facts.sidecars.every((sidecar) => sidecar.version === null)).toBe(true);
  });
});

describe("the About read's small parsers (#1256)", () => {
  it("takes the word after the product name, only when it is version-shaped", () => {
    expect(versionAfter("PostgreSQL", "PostgreSQL 17.6 on aarch64")).toBe("17.6");
    expect(versionAfter("Tika", "Apache Tika 4.1.0")).toBe("4.1.0");
    expect(versionAfter("ClamAV", "ClamAV 1.5.4/27800/Mon")).toBe("1.5.4");
    expect(versionAfter("Tika", "Apache Tika")).toBeNull();
    expect(versionAfter("Tika", null)).toBeNull();
  });

  it("accepts a bare version and drops a leading v", () => {
    expect(versionOnly("0.35.1")).toBe("0.35.1");
    expect(versionOnly("v24.11.0")).toBe("24.11.0");
    expect(versionOnly("not a version at all")).toBeNull();
    expect(versionOnly(undefined)).toBeNull();
  });

  it("reduces a digest reference to its digest and shows a local tag as given", () => {
    const digest = `sha256:${"0f".repeat(32)}`;
    expect(imageOf(`ghcr.io/tomlawesome/orbit@${digest}`)).toBe(digest);
    expect(imageOf("orbit-local:000000000000")).toBe("orbit-local:000000000000");
    expect(imageOf("  ")).toBeNull();
    expect(imageOf(undefined)).toBeNull();
  });
});
