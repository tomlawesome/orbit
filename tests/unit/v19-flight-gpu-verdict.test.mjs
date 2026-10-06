import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * #1253: the page decides once, from one context, whether it may use the GPU
 * at all -- before the door does any other WebGL work.
 */
const RENDERER = 0x9246;
/** @param {{ renderer?: string, context?: boolean }} how */
function stubPage({ renderer = "ANGLE (NVIDIA)", context = true } = {}) {
  const lost = vi.fn();
  const getContext = vi.fn((_kind, attrs) => (context ? {
    attrs,
    getExtension: (name) => (name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: RENDERER }
      : name === "WEBGL_lose_context" ? { loseContext: lost }
      : name === "KHR_parallel_shader_compile" ? {} : null),
    getParameter: (p) => (p === RENDERER ? renderer : null),
  } : null));
  vi.stubGlobal("document", { createElement: () => ({ getContext }) });
  return { getContext, lost };
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

  it("accepts a hardware renderer, decides once, and keeps the one context", async () => {
    const { getContext } = stubPage();
    const { gpu } = await import("$lib/flight/fitness.js");
    const first = gpu();
    expect(first?.parallel).toBe(true);
    expect(gpu()).toBe(first);
    expect(getContext).toHaveBeenCalledOnce();
  });
});
