// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FamilyScreen, resolveFamilyThemePack } from "./family-screen";
import { NotFoundScreen } from "./not-found-screen";

function stubMatchMedia(reducedMotion: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

describe("resolveFamilyThemePack", () => {
  it("defaults to the star-chart pack when a visitor has no stored preference", () => {
    expect(resolveFamilyThemePack(null)).toBe("starchart");
    expect(resolveFamilyThemePack("")).toBe("starchart");
  });

  it("keeps a stored pack", () => {
    expect(resolveFamilyThemePack(JSON.stringify({ theme: "atlas" }))).toBe("atlas");
  });

  it("refuses anything that is not one of the four packs", () => {
    expect(resolveFamilyThemePack(JSON.stringify({ theme: "midnight" }))).toBe("starchart");
    expect(resolveFamilyThemePack("<script>")).toBe("starchart");
  });
});

describe("FamilyScreen", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    stubMatchMedia(false);
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(node: React.ReactNode) {
    await act(async () => {
      root.render(node);
    });
  }

  it("puts the whole sky behind aria-hidden and keeps the copy in a main landmark", async () => {
    await render(<FamilyScreen ribbon="Private · Self-hosted · Yours"><h1>Sign in to Orbit.</h1></FamilyScreen>);

    expect(container.querySelector(".family-sky")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("main.family-stage h1")?.textContent).toBe("Sign in to Orbit.");
    expect(container.querySelector(".family-ribbon")?.textContent).toBe("Private · Self-hosted · Yours");
    expect(container.querySelector(".starfield")).not.toBeNull();
  });

  it("draws no horizon when a screen asks for the bare starfield", async () => {
    await render(<FamilyScreen phase="none" ribbon="404 · Off the chart"><h1>Off the chart</h1></FamilyScreen>);

    expect(container.querySelector(".family-horizon")).toBeNull();
    expect(container.querySelector(".starfield")).not.toBeNull();
  });

  it("breaks first light in from dark, once", async () => {
    vi.useFakeTimers();
    try {
      await render(<FamilyScreen phase="rise" ribbon="Private"><h1>Sign in to Orbit.</h1></FamilyScreen>);
      expect(container.querySelector(".family-horizon")?.className).not.toContain("lit");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(container.querySelector(".family-horizon")?.className).toContain("lit");
      expect(container.querySelector(".family-horizon")?.className).not.toContain("still");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stills the horizon outright under reduced motion", async () => {
    stubMatchMedia(true);
    await render(<FamilyScreen phase="rise" ribbon="Private"><h1>Sign in to Orbit.</h1></FamilyScreen>);

    // `.still` holds the scene at full opacity from the first frame, so
    // there is no fade to sit through and nothing left animating.
    expect(container.querySelector(".family-horizon")?.className).toContain("still");
  });
});

describe("NotFoundScreen", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    stubMatchMedia(false);
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("says what happened, offers one way home, and keeps the artwork decorative", async () => {
    await act(async () => {
      root.render(<NotFoundScreen />);
    });

    expect(container.querySelector("h1")?.textContent).toBe("This page has drifted off the chart");
    const home = container.querySelector<HTMLAnchorElement>("a.family-link");
    expect(home?.getAttribute("href")).toBe("/");
    expect(home?.textContent).toContain("Return to your orbit");
    expect(container.querySelector(".family-adrift")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("tells a visitor nothing about the address they missed", async () => {
    await act(async () => {
      root.render(<NotFoundScreen />);
    });

    // Nothing here is derived from the request, so a mistyped household or
    // document id can never be echoed back — or confirmed to exist.
    expect(container.textContent).not.toMatch(/household|document|item|\/api\//i);
  });

  it("stills the drifting derelict under reduced motion", async () => {
    stubMatchMedia(true);
    await act(async () => {
      root.render(<NotFoundScreen />);
    });

    expect(container.querySelector(".family-adrift")?.className).toContain("still");
  });
});
