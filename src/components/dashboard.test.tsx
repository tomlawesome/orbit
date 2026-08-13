// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { SectionNameField } from "./dashboard";

// Regression coverage for the #383 deep-review finding at dashboard.tsx:691
// (now ~742): the section-rename `<input>` used to dispatch a full
// `sections.replace` workspace command on every keystroke via a controlled
// `onChange`. `SectionNameField` now holds the in-progress name as local
// draft state and only calls `onCommit` on blur or Enter — see the fix's
// commit message and dashboard.tsx for the full mechanism this replaces.

describe("SectionNameField (issue #383 rename batching)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let onCommit: Mock<(name: string) => void>;

  function renderField(overrides: Partial<{ name: string; ariaLabel: string }> = {}) {
    return act(async () => {
      root.render(
        <SectionNameField
          name={overrides.name ?? "Home"}
          ariaLabel={overrides.ariaLabel ?? "Name for Home"}
          onCommit={onCommit}
        />,
      );
    });
  }

  function typeInto(input: HTMLInputElement, value: string) {
    const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    return act(async () => {
      nativeValueSetter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onCommit = vi.fn<(name: string) => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("does not commit while typing — only local draft state updates per keystroke", async () => {
    await renderField();
    const input = container.querySelector<HTMLInputElement>("input")!;

    for (const value of ["G", "Ga", "Gar", "Gara", "Garag", "Garage"]) {
      await typeInto(input, value);
    }

    expect(input.value).toBe("Garage");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits exactly once, with the final value, on blur", async () => {
    await renderField();
    const input = container.querySelector<HTMLInputElement>("input")!;

    await typeInto(input, "Garage");
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Garage");
  });

  it("commits on Enter without waiting for a separate blur", async () => {
    await renderField();
    const input = container.querySelector<HTMLInputElement>("input")!;

    input.focus();
    await typeInto(input, "Utilities");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Utilities");
  });

  it("does not commit on blur when the draft is unchanged from the committed name", async () => {
    await renderField({ name: "Home" });
    const input = container.querySelector<HTMLInputElement>("input")!;

    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("falls back to 'Untitled section' rather than committing an empty name", async () => {
    await renderField({ name: "Home" });
    const input = container.querySelector<HTMLInputElement>("input")!;

    await typeInto(input, "");
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Untitled section");
  });

  it("resyncs the draft when the committed name changes externally while untouched", async () => {
    await renderField({ name: "Home" });
    await act(async () => {
      root.render(<SectionNameField name="House" ariaLabel="Name for House" onCommit={onCommit} />);
    });
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("House");
  });
});
