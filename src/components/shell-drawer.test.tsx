// @vitest-environment happy-dom
import { useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShellDrawer } from "./shell-drawer";

// The v19 shell replaced the sidebar and topbar with edge drawers, so the
// drawer primitive is now load-bearing for navigation-adjacent chrome. The
// contract it has to keep (issue #307, CON-7/CON-12): the handle is the
// trigger and says so; a shut drawer is inert, not merely off-screen;
// opening moves focus in and closing puts it back on the handle; Escape
// closes; a modal drawer scrims the page and traps Tab.

function Harness({ modal = false, initialOpen = false }: { modal?: boolean; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <ShellDrawer
      id="test-drawer"
      side="left"
      modal={modal}
      label="System status"
      handleLabel="System status — Synced"
      handleClassName="sync-state"
      open={open}
      onOpenChange={setOpen}
      handle={<span>Synced</span>}
    >
      <button type="button">First action</button>
      <button type="button">Second action</button>
    </ShellDrawer>
  );
}

describe("ShellDrawer (v19 shell chrome, issue #307)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  function handleButton() {
    return container.querySelector<HTMLButtonElement>("button.handle")!;
  }

  function panel() {
    return container.querySelector<HTMLElement>("#test-drawer")!;
  }

  function nextFrame() {
    return act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    });
  }

  async function render(props: { modal?: boolean; initialOpen?: boolean } = {}) {
    await act(async () => { root.render(<Harness {...props} />); });
    await nextFrame();
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

  it("wires the handle to the panel it controls", async () => {
    await render();
    expect(handleButton().getAttribute("aria-expanded")).toBe("false");
    expect(handleButton().getAttribute("aria-controls")).toBe("test-drawer");
    expect(handleButton().getAttribute("aria-label")).toBe("System status — Synced");
  });

  it("keeps a shut drawer inert, so it is neither tabbable nor announced", async () => {
    await render();
    expect(panel().hasAttribute("inert")).toBe(true);

    await act(async () => { handleButton().click(); });
    expect(panel().hasAttribute("inert")).toBe(false);
    expect(handleButton().getAttribute("aria-expanded")).toBe("true");
  });

  it("moves focus into the drawer when it opens", async () => {
    await render();
    await act(async () => { handleButton().click(); });
    await nextFrame();
    expect(document.activeElement?.textContent).toBe("First action");
  });

  it("closes on Escape and returns focus to the handle", async () => {
    await render({ initialOpen: true });
    await nextFrame();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await nextFrame();

    expect(panel().hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(handleButton());
  });

  it("closes when the handle is pressed a second time", async () => {
    await render({ initialOpen: true });
    await act(async () => { handleButton().click(); });
    expect(handleButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("parks focus on the handle when something else shuts the drawer", async () => {
    // The create drawer hands over to the item editor: the parent closes it
    // while focus is still inside. Without this, focus is orphaned on
    // document.body and the editor has nothing live to return to.
    const drawer = (open: boolean) => (
      <ShellDrawer
        id="test-drawer"
        side="top"
        modal
        label="Add to your orbit"
        handleLabel="Add to your orbit"
        handleClassName="nstar"
        open={open}
        onOpenChange={() => {}}
        handle={<span>create</span>}
      >
        <button type="button">First action</button>
      </ShellDrawer>
    );

    await act(async () => { root.render(drawer(true)); });
    await nextFrame();
    expect(document.activeElement?.textContent).toBe("First action");

    await act(async () => { root.render(drawer(false)); });
    await nextFrame();
    expect(document.activeElement).toBe(handleButton());
  });

  it("only a modal drawer dims the page behind a scrim", async () => {
    await render({ initialOpen: true });
    expect(container.querySelector(".shell-scrim")).toBeNull();

    await act(async () => { root.render(<Harness modal initialOpen />); });
    const scrim = container.querySelector<HTMLButtonElement>(".shell-scrim")!;
    expect(scrim.getAttribute("aria-label")).toBe("Close System status");

    await act(async () => { scrim.click(); });
    expect(panel().hasAttribute("inert")).toBe(true);
  });

  it("traps Tab inside a modal drawer", async () => {
    await render({ modal: true, initialOpen: true });
    await nextFrame();

    const actions = Array.from(panel().querySelectorAll("button"));
    const last = handleButton();

    // Forward from the final control in the rail wraps to the first.
    await act(async () => {
      last.focus();
      last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(actions[0]);

    // And backwards from the first wraps to the handle at the end.
    await act(async () => {
      actions[0].focus();
      actions[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it("does not trap Tab in a non-modal drawer", async () => {
    await render({ initialOpen: true });
    await nextFrame();

    const actions = Array.from(panel().querySelectorAll("button"));
    await act(async () => {
      actions[0].focus();
      actions[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    });
    // The browser, not the drawer, decides where an untrapped Tab goes.
    expect(document.activeElement).toBe(actions[0]);
  });
});
