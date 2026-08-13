// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import * as dashboardUtils from "@/components/dashboard-utils";
import * as dialGeometry from "@/lib/dial-geometry";
import { HeroSky } from "./hero-sky";
import type { HomeItem, HouseholdSection } from "@/lib/domain";

const TODAY = "2026-08-13";

const sections: HouseholdSection[] = [
  { id: "home", name: "Home", icon: "home", accent: "sage", visible: true },
  { id: "vehicle", name: "Vehicles", icon: "vehicle", accent: "blue", visible: true },
];

function homeItem(overrides: Partial<HomeItem> & Pick<HomeItem, "id" | "title">): HomeItem {
  return {
    sectionId: "home",
    currency: "GBP",
    status: "active",
    ...overrides,
  };
}

// Real, workspace-shaped items spanning every manifest group: overdue,
// due-soon (both "needs attention"), a mid-year renewal and a wide-orbit
// service (both "later this year"), and one with no due date at all
// ("unscheduled").
const WORKSPACE_ITEMS: HomeItem[] = [
  homeItem({ id: "gutter", title: "Gutter clearing", dueDate: "2026-07-28", costMinor: 15_000, scheduleKind: "service" }),
  homeItem({ id: "mot", title: "Car MOT", dueDate: "2026-08-18", costMinor: 5_485, scheduleKind: "renewal", provider: "DVSA" }),
  homeItem({ id: "chimney", title: "Chimney sweep", dueDate: "2026-10-13", costMinor: 9_000, sectionId: "home" }),
  homeItem({ id: "smoke", title: "Smoke alarm batteries", dueDate: "2026-12-13", costMinor: 1_200 }),
  homeItem({ id: "someday", title: "Repaint the shed" }),
];

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

describe("HeroSky", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let onOpenItem: Mock<(item: HomeItem) => void>;
  let onQueryChange: Mock<(value: string) => void>;
  let onItemFilterChange: Mock<(filter: "all" | "attention" | "unscheduled") => void>;
  let onAddItem: Mock<() => void>;
  let scrollIntoView: Mock<(arg?: boolean | ScrollIntoViewOptions) => void>;

  function renderHeroSky(overrides: Partial<Parameters<typeof HeroSky>[0]> = {}) {
    return act(async () => {
      root.render(
        <HeroSky
          items={WORKSPACE_ITEMS}
          listedItemsLength={WORKSPACE_ITEMS.length}
          sections={sections}
          today={TODAY}
          householdName="Lawson Home"
          query=""
          onQueryChange={onQueryChange}
          itemFilter="all"
          onItemFilterChange={onItemFilterChange}
          onOpenItem={onOpenItem}
          onAddItem={onAddItem}
          {...overrides}
        />,
      );
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onOpenItem = vi.fn<(item: HomeItem) => void>();
    onQueryChange = vi.fn<(value: string) => void>();
    onItemFilterChange = vi.fn<(filter: "all" | "attention" | "unscheduled") => void>();
    onAddItem = vi.fn<() => void>();
    scrollIntoView = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
    Element.prototype.scrollIntoView = scrollIntoView;
    stubMatchMedia(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders the dial from real workspace-shaped data, one body per scheduled item", async () => {
    await renderHeroSky();
    // 4 of the 5 fixture items carry a dueDate; "Repaint the shed" has none
    // and can't be plotted (dial-adapter.test.ts covers that mapping directly).
    const bodies = container.querySelectorAll(".gravity-dial [role='button']");
    expect(bodies.length).toBe(4);
    const svg = container.querySelector("svg.dial")!;
    expect(svg.getAttribute("aria-describedby")).toBe("hero-sky-manifest-heading");
    expect(container.querySelector("#hero-sky-manifest-heading")).not.toBeNull();
    // The sky itself stays wordless (CON-4), but the page still carries a
    // real (visually-hidden) h1 for the document outline / screen readers.
    expect(container.querySelector("h1")?.textContent).toContain("due next");
  });

  it("groups the manifest into needs attention / later this year / unscheduled, dropping no item", async () => {
    await renderHeroSky();
    const groups = [...container.querySelectorAll(".group")];
    const labels = groups.map((group) => group.querySelector("h3")?.textContent);
    expect(labels[0]).toContain("Needs attention");
    expect(labels[0]).toContain("closest approach");
    // "Closest approach" is the group's most urgent item by the product's
    // own existing ranking (ties with sortByDueDate: overdue always outranks
    // due-soon) — here, the overdue gutter clearing.
    expect(labels[0]).toContain("Gutter clearing");
    expect(labels[1]).toBe("Later this year");
    expect(labels[2]).toBe("Unscheduled");

    // Every fixture item is represented exactly once — the manifest stays
    // the complete, accessible source of truth even for items the dial
    // can't plot.
    for (const item of WORKSPACE_ITEMS) {
      expect(container.querySelector(`#manifest-item-${item.id}`)).not.toBeNull();
    }
    expect(container.querySelectorAll(".item-card").length).toBe(WORKSPACE_ITEMS.length);
  });

  it("scrolls to and highlights the matching manifest row on body click", async () => {
    await renderHeroSky();
    const body = container.querySelector('[data-body="mot"] [role="button"]')!;
    await act(async () => {
      body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth", block: "center" }));
    const row = container.querySelector("#manifest-item-mot");
    expect(row?.classList.contains("dial-target")).toBe(true);
  });

  it("shows hover callout content — title, T-minus, and printed cost", async () => {
    await renderHeroSky();
    const body = container.querySelector('[data-body="mot"] [role="button"]')!;
    await act(async () => {
      body.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const callout = container.querySelector(".callout.show")!;
    expect(callout).not.toBeNull();
    expect(callout.querySelector("b")?.textContent).toBe("Car MOT");
    expect(callout.querySelector("small")?.textContent).toContain("T−5d");
    expect(callout.querySelector("small")?.textContent).toContain("£54.85");

    await act(async () => {
      body.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(container.querySelector(".callout.show")).toBeNull();
  });

  it("wires the explore-your-world field to the shared search query", async () => {
    await renderHeroSky({ query: "gutter" });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search items and documents"]')!;
    expect(input.value).toBe("gutter");
    // React tracks <input> value through its own property descriptor, so a
    // plain `input.value = ...` assignment is invisible to it — set through
    // the native setter, as React's own test utilities do.
    const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      nativeValueSetter.call(input, "boiler");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onQueryChange).toHaveBeenCalledWith("boiler");
  });

  it("falls back to an instant scroll under prefers-reduced-motion", async () => {
    stubMatchMedia(true);
    await renderHeroSky();
    const body = container.querySelector('[data-body="mot"] [role="button"]')!;
    await act(async () => {
      body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
    // Reduced-motion CSS keeps every group visible without waiting on the
    // reveal-on-scroll observer, and stills the starfield drift (POL-11).
    expect(container.innerHTML).toContain("prefers-reduced-motion: reduce");
  });

  it("renders manifest groups already visible when IntersectionObserver is unavailable — never permanently hidden", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    await renderHeroSky();
    const groups = [...container.querySelectorAll(".group")];
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) expect(group.classList.contains("seen")).toBe(true);
  });

  // Regression coverage for the #383 deep-review finding at hero-sky.tsx:191:
  // hovering a dial body used to re-render every orbiting body (GravityDial's
  // Body children recompute computeBodyGeometry) and every manifest row
  // (ItemRow recomputes formatCost/formatLongDate/dueCopy) for a callout that
  // only needs to move one absolutely-positioned div. GravityDial and ItemRow
  // are now React.memo'd and hero-sky.tsx's hover handlers are useCallback'd,
  // so with a stable `items` prop (also now memoized in dashboard.tsx) a
  // hover event should do none of that per-item work again.
  describe("hover memoization (issue #383)", () => {
    it("does not recompute orbital geometry for any body on hover", async () => {
      await renderHeroSky();
      const geometrySpy = vi.spyOn(dialGeometry, "computeBodyGeometry");
      geometrySpy.mockClear();

      const body = container.querySelector('[data-body="mot"] [role="button"]')!;
      await act(async () => {
        body.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      await act(async () => {
        body.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      });

      // The hover callout genuinely changed (see the "shows hover callout
      // content" test above) — this asserts specifically that no Body
      // recomputed its geometry to produce that, i.e. GravityDial bailed out
      // via React.memo rather than re-rendering its full item set.
      expect(geometrySpy).not.toHaveBeenCalled();
      geometrySpy.mockRestore();
    });

    it("does not re-render manifest rows on hover", async () => {
      await renderHeroSky();
      // `dueCopy` is only ever called from inside ItemRow (the hover
      // callout separately calls `formatCost` on the hovered item itself,
      // which is legitimately expected to run on every hover), so it is an
      // ItemRow-exclusive render signal.
      const dueCopySpy = vi.spyOn(dashboardUtils, "dueCopy");
      dueCopySpy.mockClear();

      const body = container.querySelector('[data-body="mot"] [role="button"]')!;
      await act(async () => {
        body.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });

      // Zero calls means every ItemRow bailed out via React.memo instead of
      // re-rendering for a state change (hovered/placement) that none of
      // their props reflect.
      expect(dueCopySpy).not.toHaveBeenCalled();
      dueCopySpy.mockRestore();
    });
  });
});
