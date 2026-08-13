// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountPanel, type AccountPanelProps } from "./account-panel";

// v19 deletes the sidebar and the topbar. Everything they carried has to
// arrive here or it is simply gone, so these tests are mostly a capability
// inventory: the section list with live counts, the household switcher,
// notifications, archive, inbox, settings, administration, theme and sign
// out. The ratified mockup shows none of the first four; that was a gap in
// the mockup, and this file is what stops it becoming a gap in the product.

function props(overrides: Partial<AccountPanelProps> = {}): AccountPanelProps {
  return {
    displayName: "Tom Lawson",
    initials: "TL",
    isInstanceAdmin: false,
    households: [
      { id: "h1", name: "Lawson Home", itemCount: 7 },
      { id: "h2", name: "Seaside Cottage", itemCount: 2 },
    ],
    activeHouseholdId: "h1",
    householdName: "Lawson Home",
    householdRole: "owner",
    sections: [
      { id: "s1", name: "Home", icon: "home", itemCount: 4 },
      { id: "s2", name: "Vehicles", icon: "vehicle", itemCount: 3 },
    ],
    activeSection: "all",
    dueNextCount: 2,
    archiveCount: 5,
    unreadNotificationCount: 0,
    theme: "starchart",
    signOutBusy: false,
    onSelectHousehold: vi.fn(),
    onAddHousehold: vi.fn(),
    onSelectSection: vi.fn(),
    onSelectDueNext: vi.fn(),
    onSelectArchive: vi.fn(),
    onNotifications: vi.fn(),
    onInbox: vi.fn(),
    onSettings: vi.fn(),
    onAdministration: vi.fn(),
    onThemeChange: vi.fn(),
    onSignOut: vi.fn(),
    ...overrides,
  };
}

describe("AccountPanel (the v19 shell's only persistent chrome, issue #307)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  function orb() {
    return container.querySelector<HTMLButtonElement>("button.orb")!;
  }

  function panel() {
    return container.querySelector<HTMLElement>("#account-panel");
  }

  function labelled(name: string) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>("#account-panel button"))
      .find((button) => (button.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(name));
  }

  function householdButton(name: string) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>(".account-household"))
      .find((button) => button.querySelector("strong")?.textContent === name);
  }

  async function render(overrides: Partial<AccountPanelProps> = {}) {
    const resolved = props(overrides);
    await act(async () => { root.render(<AccountPanel {...resolved} />); });
    return resolved;
  }

  async function open() {
    await act(async () => { orb().click(); });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("presents the orb as a closed disclosure for the account panel", async () => {
    await render();
    expect(orb().getAttribute("aria-label")).toBe("Open account menu");
    expect(orb().getAttribute("aria-haspopup")).toBe("dialog");
    expect(orb().getAttribute("aria-expanded")).toBe("false");
    expect(orb().getAttribute("aria-controls")).toBe("account-panel");
    expect(orb().textContent).toContain("TL");
    expect(panel()).toBeNull();
  });

  it("opens a modal panel and marks the orb expanded", async () => {
    await render();
    await open();
    expect(orb().getAttribute("aria-expanded")).toBe("true");
    expect(panel()?.getAttribute("role")).toBe("dialog");
    expect(panel()?.getAttribute("aria-modal")).toBe("true");
    expect(panel()?.getAttribute("aria-label")).toBe("Account and menu");
    expect(container.querySelector(".shell-scrim-account")).not.toBeNull();
  });

  it("announces unread notifications without changing the orb's name", async () => {
    await render({ unreadNotificationCount: 3 });
    expect(orb().getAttribute("aria-label")).toBe("Open account menu");
    expect(orb().getAttribute("aria-describedby")).toBe("orb-unread-hint");
    expect(container.querySelector("#orb-unread-hint")?.textContent).toBe("3 unread notifications");
    expect(orb().querySelector(".orb-unread")).not.toBeNull();
  });

  it("keeps the sidebar's section list, with live counts, under Your things", async () => {
    await render();
    await open();
    const things = container.querySelector<HTMLElement>('nav[aria-label="Your things"]')!;
    const rows = Array.from(things.querySelectorAll("button"))
      .map((button) => (button.textContent ?? "").replace(/\s+/g, " ").trim());
    expect(rows).toEqual(["Home4", "Vehicles3", "Archive5"]);
  });

  it("keeps every action the old sidebar and topbar offered", async () => {
    await render({ isInstanceAdmin: true });
    await open();
    for (const action of ["Due next", "Notifications", "Inbox", "Settings", "Administration", "Archive", "Add a household", "Sign out"]) {
      expect(labelled(action), `${action} is unreachable from the account panel`).toBeDefined();
    }
    expect(householdButton("Lawson Home")).toBeDefined();
    expect(householdButton("Seaside Cottage")).toBeDefined();
  });

  it("hides Administration from members who are not instance administrators", async () => {
    await render({ isInstanceAdmin: false });
    await open();
    expect(labelled("Administration")).toBeUndefined();
  });

  it("marks the current list and the current household", async () => {
    await render({ activeSection: "s2" });
    await open();
    expect(labelled("Vehicles")?.getAttribute("aria-current")).toBe("page");
    expect(labelled("Due next")?.getAttribute("aria-current")).toBeNull();
    expect(householdButton("Lawson Home")?.getAttribute("aria-current")).toBe("true");
    expect(householdButton("Seaside Cottage")?.getAttribute("aria-current")).toBeNull();
  });

  it("runs a navigation action and shuts the panel behind it", async () => {
    const resolved = await render();
    await open();
    const vehicles = labelled("Vehicles")!;
    await act(async () => { vehicles.click(); });
    expect(resolved.onSelectSection).toHaveBeenCalledWith("s2");
    expect(panel()).toBeNull();
    expect(orb().getAttribute("aria-expanded")).toBe("false");
  });

  it("switches household from the panel, replacing the old sidebar picker", async () => {
    const resolved = await render();
    await open();
    const seaside = householdButton("Seaside Cottage")!;
    await act(async () => { seaside.click(); });
    expect(resolved.onSelectHousehold).toHaveBeenCalledWith("h2");
    expect(panel()).toBeNull();
  });

  it("changes theme in place, so the choice can be seen before committing to it", async () => {
    const resolved = await render();
    await open();
    const swatches = Array.from(container.querySelectorAll<HTMLButtonElement>(".account-swatch"));
    expect(swatches).toHaveLength(4);
    expect(swatches[0].getAttribute("aria-pressed")).toBe("true");
    expect(swatches[1].getAttribute("aria-pressed")).toBe("false");
    expect(swatches[1].getAttribute("aria-label")).toBe("After Dark");

    await act(async () => { swatches[1].click(); });
    expect(resolved.onThemeChange).toHaveBeenCalledWith("afterdark");
    expect(panel(), "changing theme must not close the panel").not.toBeNull();
  });

  it("disables sign out while it is in flight", async () => {
    await render({ signOutBusy: true });
    await open();
    const signOut = container.querySelector<HTMLButtonElement>(".account-signout")!;
    expect(signOut.disabled).toBe(true);
    expect(signOut.textContent).toBe("Signing out…");
  });

  it("closes from the panel's own close control", async () => {
    await render();
    await open();
    const close = container.querySelector<HTMLButtonElement>(".account-close")!;
    await act(async () => { close.click(); });
    expect(panel()).toBeNull();
  });
});
