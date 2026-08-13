// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GravityDial, type DialItem } from "./gravity-dial";

const TODAY = "2026-08-13";

function item(overrides: Partial<DialItem> & Pick<DialItem, "id" | "title" | "dueDate">): DialItem {
  return {
    costBand: 2,
    type: "service",
    status: "upcoming",
    ...overrides,
  };
}

function stubMatchMedia(reducedMotion: boolean) {
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    addEventListener: (_: string, handler: () => void) => listeners.add(handler),
    removeEventListener: (_: string, handler: () => void) => listeners.delete(handler),
    // legacy API some code paths may still probe for
    addListener: (handler: () => void) => listeners.add(handler),
    removeListener: (handler: () => void) => listeners.delete(handler),
  }));
}

describe("GravityDial", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    stubMatchMedia(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders one interactive body per item", async () => {
    const items: DialItem[] = [
      item({ id: "a", title: "Gutter clearing", dueDate: "2026-07-28", status: "overdue" }),
      item({ id: "b", title: "Car MOT", dueDate: "2026-08-29", status: "soon" }),
      item({ id: "c", title: "Chimney sweep", dueDate: "2026-10-13", status: "upcoming" }),
      item({ id: "d", title: "Smoke alarm batteries", dueDate: "2026-12-13", status: "ok" }),
    ];
    await act(async () => {
      root.render(<GravityDial items={items} today={TODAY} />);
    });
    const bodies = container.querySelectorAll('[role="button"]');
    expect(bodies.length).toBe(items.length);
  });

  it("renders the correct planet material per status (POL-14)", async () => {
    const items: DialItem[] = [
      item({ id: "overdue-item", title: "Overdue", dueDate: "2026-07-28", status: "overdue" }),
      item({ id: "soon-item", title: "Soon", dueDate: "2026-08-20", status: "soon" }),
      item({ id: "upcoming-item", title: "Upcoming", dueDate: "2026-10-13", status: "upcoming" }),
      item({ id: "ok-item", title: "OK", dueDate: "2026-12-13", status: "ok" }),
    ];
    await act(async () => {
      root.render(<GravityDial items={items} today={TODAY} />);
    });
    const expectMaterial = (id: string, gradient: string) => {
      const group = container.querySelector(`[data-body="${id}"] [role="button"]`)!;
      const circle = [...group.querySelectorAll("circle[fill]")].find((c) =>
        c.getAttribute("fill")?.startsWith("url("),
      );
      expect(circle?.getAttribute("fill")).toBe(gradient);
    };
    expectMaterial("overdue-item", "url(#p-ruby)");
    expectMaterial("soon-item", "url(#p-amber)");
    expectMaterial("upcoming-item", "url(#p-sky)");
    expectMaterial("ok-item", "url(#p-jade)");
  });

  it("renders suggestion bodies hollow with no material fill (CON-3)", async () => {
    const items: DialItem[] = [
      item({ id: "sug", title: "Home insurance renewal", dueDate: "2026-10-02", type: "suggestion", status: "upcoming" }),
    ];
    await act(async () => {
      root.render(<GravityDial items={items} today={TODAY} />);
    });
    const group = container.querySelector('[data-body="sug"] [role="button"]')!;
    const circles = [...group.querySelectorAll("circle")];
    expect(circles.length).toBeGreaterThan(0);
    for (const circle of circles) {
      const fill = circle.getAttribute("fill");
      expect(fill === "none" || fill === "var(--accent)").toBe(true);
      expect(fill?.startsWith("url(")).toBe(false);
    }
    const stroked = circles.find((c) => c.getAttribute("stroke") === "var(--accent)");
    expect(stroked).toBeDefined();
  });

  it("draws distinct shapes for each type in the circular type language (CON-3)", async () => {
    const items: DialItem[] = [
      item({ id: "svc", title: "Boiler service", dueDate: "2026-09-04", type: "service" }),
      item({ id: "ren", title: "Insurance", dueDate: "2026-10-02", type: "renewal" }),
      item({ id: "ins", title: "Car MOT", dueDate: "2026-08-29", type: "inspection" }),
    ];
    await act(async () => {
      root.render(<GravityDial items={items} today={TODAY} />);
    });
    // service: a single filled planet (plus its specular highlight dot) — no
    // concentric ring, no terminator path.
    const service = container.querySelector('[data-body="svc"] [role="button"]')!;
    expect(service.querySelectorAll("circle").length).toBe(2);
    expect(service.querySelectorAll("path").length).toBe(0);

    // renewal: concentric = three nested circles (colour/gap/colour).
    const renewal = container.querySelector('[data-body="ren"] [role="button"]')!;
    expect(renewal.querySelectorAll("circle").length).toBe(3);

    // inspection: terminator = one filled circle plus a half-dark path.
    const inspection = container.querySelector('[data-body="ins"] [role="button"]')!;
    expect(inspection.querySelectorAll("circle").length).toBe(1);
    expect(inspection.querySelectorAll("path").length).toBe(1);
  });

  it("renders a belt only on bodies carrying documents, passively (CON-1)", async () => {
    const items: DialItem[] = [
      item({ id: "with-docs", title: "Car full service", dueDate: "2026-12-01", documents: 2 }),
      item({ id: "without-docs", title: "Boiler service", dueDate: "2026-09-04" }),
    ];
    await act(async () => {
      root.render(<GravityDial items={items} today={TODAY} />);
    });
    const withBelt = container.querySelector('[data-body="with-docs"] .belt');
    const withoutBelt = container.querySelector('[data-body="without-docs"] .belt');
    expect(withBelt).not.toBeNull();
    expect(withoutBelt).toBeNull();
    // CON-1: belts are passive badges — no click handling of their own.
    expect(withBelt?.getAttribute("aria-hidden")).toBe("true");
    expect(withBelt?.getAttribute("role")).not.toBe("button");
  });

  it("fires onBodyClick exactly once per click, with exactly one clickable element per body (CON-5)", async () => {
    const onBodyClick = vi.fn();
    const items: DialItem[] = [item({ id: "only", title: "Boiler service", dueDate: "2026-09-04", documents: 3 })];
    await act(async () => {
      root.render(<GravityDial items={items} today={TODAY} onBodyClick={onBodyClick} />);
    });
    const group = container.querySelector('[data-body="only"]')!;
    const clickable = group.querySelectorAll('[role="button"]');
    expect(clickable.length).toBe(1);

    await act(async () => {
      clickable[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBodyClick).toHaveBeenCalledTimes(1);
    expect(onBodyClick).toHaveBeenCalledWith(items[0]);
  });

  it("also fires onBodyClick on Enter/Space for keyboard access, still exactly once", async () => {
    const onBodyClick = vi.fn();
    const items: DialItem[] = [item({ id: "kb", title: "Chimney sweep", dueDate: "2026-10-13" })];
    await act(async () => {
      root.render(<GravityDial items={items} today={TODAY} onBodyClick={onBodyClick} />);
    });
    const button = container.querySelector('[data-body="kb"] [role="button"]')!;
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onBodyClick).toHaveBeenCalledTimes(1);
  });

  it("reports hover in and out via onBodyHover for a host callout (#327)", async () => {
    const onBodyHover = vi.fn();
    const items: DialItem[] = [item({ id: "hover-me", title: "Car MOT", dueDate: "2026-08-29" })];
    await act(async () => {
      root.render(<GravityDial items={items} today={TODAY} onBodyHover={onBodyHover} />);
    });
    const button = container.querySelector('[data-body="hover-me"] [role="button"]')!;
    // React derives synthetic mouseenter/mouseleave from delegated, bubbling
    // mouseover/mouseout — happy-dom needs the real (bubbling) event types.
    await act(async () => {
      button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(onBodyHover).toHaveBeenLastCalledWith(items[0]);

    await act(async () => {
      button.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(onBodyHover).toHaveBeenLastCalledWith(null);
  });

  it("wires aria-describedby to the host's manifest list, the accessible source of truth", async () => {
    await act(async () => {
      root.render(<GravityDial items={[]} today={TODAY} ariaDescribedBy="manifest-list" />);
    });
    const svg = container.querySelector("svg.dial")!;
    expect(svg.getAttribute("aria-describedby")).toBe("manifest-list");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toMatch(/gravity well/i);
  });

  it("marks the current month with the POL-3 glow class", async () => {
    await act(async () => {
      root.render(<GravityDial items={[]} today="2026-08-13" />);
    });
    const nowMonth = container.querySelector(".now-month");
    expect(nowMonth?.textContent).toBe("AUG");
    expect(nowMonth?.getAttribute("data-polish")).toBe("POL-3");
  });

  it("drops rotor/breathe/ping animation classes under prefers-reduced-motion", async () => {
    stubMatchMedia(true);
    const items: DialItem[] = [
      item({ id: "overdue-item", title: "Overdue", dueDate: "2026-07-28", status: "overdue" }),
    ];
    await act(async () => {
      root.render(<GravityDial items={items} today={TODAY} />);
    });
    expect(container.querySelector(".rotor")).toBeNull();
    expect(container.querySelector(".breathe")).toBeNull();
    expect(container.querySelector(".ping")).toBeNull();
  });

  it("keeps rotor/breathe/ping animation classes when motion is not reduced", async () => {
    stubMatchMedia(false);
    const items: DialItem[] = [
      item({ id: "overdue-item", title: "Overdue", dueDate: "2026-07-28", status: "overdue" }),
    ];
    await act(async () => {
      root.render(<GravityDial items={items} today={TODAY} />);
    });
    expect(container.querySelector(".rotor")).not.toBeNull();
    expect(container.querySelector(".breathe")).not.toBeNull();
    expect(container.querySelector(".ping")).not.toBeNull();
  });
});
