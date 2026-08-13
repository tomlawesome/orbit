// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Starfield } from "./starfield";

describe("Starfield", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

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

  it("renders two tiled, decorative depth layers plus a vignette", async () => {
    await act(async () => {
      root.render(<Starfield />);
    });
    const field = container.querySelector(".starfield")!;
    expect(field.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll(".sf-far > g").length).toBe(2); // base tile + one duplicate, one tile-width apart
    expect(container.querySelectorAll(".sf-near > g").length).toBe(2);
    expect(container.querySelector(".vignette")).not.toBeNull();
  });

  it("renders the same star positions on every mount (deterministic, hydration-safe)", async () => {
    await act(async () => {
      root.render(<Starfield />);
    });
    const first = container.querySelector(".sf-far")!.innerHTML;
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<Starfield />);
    });
    const second = container.querySelector(".sf-far")!.innerHTML;
    expect(second).toBe(first);
  });

  it("stills the drift under prefers-reduced-motion (POL-11), via the component's own CSS", async () => {
    await act(async () => {
      root.render(<Starfield />);
    });
    expect(container.innerHTML).toContain("prefers-reduced-motion: reduce");
    expect(container.innerHTML).toContain("animation:none!important");
  });
});
