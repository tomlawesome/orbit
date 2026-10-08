import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * #1253: the page decides once, from one context, whether it may use the GPU
 * at all -- before the door does any other WebGL work.
 */
const UNMASKED = 0x9246;
const PLAIN = 0x1f01;
/** @param {{ renderer?: string, plain?: string, context?: boolean }} how
    plain: what RENDERER answers ("WebKit WebGL" is Chromium's and WebKit's mask) */
function stubPage({ renderer = "ANGLE (NVIDIA)", plain = "WebKit WebGL", context = true } = {}) {
  const lost = vi.fn();
  const asked = [];
  const getContext = vi.fn((_kind, attrs) => (context ? {
    attrs,
    RENDERER: PLAIN,
    getExtension: (name) => (asked.push(name), name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: UNMASKED }
      : name === "WEBGL_lose_context" ? { loseContext: lost }
      : name === "KHR_parallel_shader_compile" ? {} : null),
    getParameter: (p) => (p === UNMASKED ? renderer : p === PLAIN ? plain : null),
  } : null));
  vi.stubGlobal("document", { createElement: () => ({ getContext }) });
  return { getContext, lost, asked };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("whether the page may use the GPU (#1253)", () => {
  it("asks for its one context with failIfMajorPerformanceCaveat, and refuses when the browser declines", async () => {
    const { getContext } = stubPage({ context: false });
    const { gpu } = await import("$lib/flight/fitness.js");
    expect(gpu()).toBeNull();
    expect(getContext.mock.calls[0][1]).toMatchObject({ failIfMajorPerformanceCaveat: true });
  });

  it.each(["llvmpipe (LLVM 19.1.7, 256 bits)", "softpipe", "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))", "Microsoft Basic Render Driver"])(
    "refuses a software renderer and lets its context go: %s", async (renderer) => {
      const { lost } = stubPage({ renderer });
      const { gpu } = await import("$lib/flight/fitness.js");
      expect(gpu()).toBeNull();
      expect(lost).toHaveBeenCalledOnce();
    });

  it("reads the name from RENDERER where it is not masked (Firefox), so the deprecated extension is never asked for (#1299)", async () => {
    const { asked } = stubPage({ plain: "ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0)", renderer: "unused" });
    const { gpu } = await import("$lib/flight/fitness.js");
    expect(gpu()).not.toBeNull();
    expect(asked).not.toContain("WEBGL_debug_renderer_info");
  });

  it("refuses a software renderer named by plain RENDERER (#1299)", async () => {
    const { lost } = stubPage({ plain: "llvmpipe (LLVM 19.1.7, 256 bits)", renderer: "unused" });
    const { gpu } = await import("$lib/flight/fitness.js");
    expect(gpu()).toBeNull();
    expect(lost).toHaveBeenCalledOnce();
  });

  it("accepts a hardware renderer, decides once, and keeps the one context", async () => {
    const { getContext } = stubPage();
    const { gpu } = await import("$lib/flight/fitness.js");
    const first = gpu();
    expect(first?.parallel).toBe(true);
    expect(gpu()).toBe(first);
    expect(getContext).toHaveBeenCalledOnce();
  });
});
