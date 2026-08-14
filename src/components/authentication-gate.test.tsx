// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { THEME_STORAGE_KEY } from "@/components/dashboard-utils";
import { markSignedOut } from "@/lib/signed-out-notice";

/**
 * The authentication gate is a security boundary, so these tests assert
 * both halves of it: the exact wording each of the four states shows (the
 * same strings tests/e2e/signed-out.spec.ts, online-workspace-policy.spec.ts
 * and authenticated-lifecycle.spec.ts drive the browser with), and that no
 * state ever offers a way past it or says anything about a household.
 */

type Gate = typeof import("./authentication-gate").AuthenticationGate;

function stubMatchMedia(reducedMotion = false) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

describe("AuthenticationGate", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let onRetry: Mock<() => void>;
  let AuthenticationGate: Gate;

  /** Each test starts from a fresh module graph so the one-shot signed-out
   *  notice (and its per-document token) behaves as it does in a browser
   *  that has just loaded the page. */
  async function loadGate() {
    vi.resetModules();
    ({ AuthenticationGate } = await import("./authentication-gate"));
  }

  async function render(props: Partial<Parameters<Gate>[0]> = {}) {
    await act(async () => {
      root.render(<AuthenticationGate loading={false} {...props} />);
    });
  }

  function text() {
    return container.textContent ?? "";
  }

  function heading() {
    return container.querySelector("h1")?.textContent;
  }

  function signInLink() {
    return container.querySelector<HTMLAnchorElement>('a[href="/api/auth/login"]');
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    stubMatchMedia();
    window.localStorage.clear();
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onRetry = vi.fn();
    await loadGate();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  describe("signed out", () => {
    it("offers exactly one way in, at the login route", async () => {
      await render();

      expect(heading()).toBe("Sign in to Orbit.");
      expect(text()).toContain("Your household information is private and is only available after authentication.");
      const link = signInLink();
      expect(link?.textContent).toContain("Sign in securely");
      expect(container.querySelectorAll("a, button")).toHaveLength(1);
    });

    it("has one h1 and one main landmark", async () => {
      await render();

      expect(container.querySelectorAll("h1")).toHaveLength(1);
      expect(container.querySelectorAll("main")).toHaveLength(1);
      expect(container.querySelectorAll("h2, h3, h4")).toHaveLength(0);
    });

    it("marks its decoration as decoration", async () => {
      await render();

      for (const decoration of container.querySelectorAll(".family-sky, .family-glyph")) {
        expect(decoration.closest("[aria-hidden='true']")).not.toBeNull();
      }
    });
  });

  describe("session loading", () => {
    it("shows the startup wording while the service becomes ready", async () => {
      await render({ loading: true, loadingMessage: "Orbit is starting. Please wait while the service becomes ready." });

      expect(heading()).toBe("Orbit is starting…");
      const status = container.querySelector("[role='status']");
      expect(status?.textContent).toBe("Orbit is starting. Please wait while the service becomes ready.");
      expect(signInLink()).toBeNull();
      expect(container.querySelector("[role='alert']")).toBeNull();
    });

    it("shows the plain check while a session is being confirmed", async () => {
      await render({ loading: true });

      expect(heading()).toBe("Checking access…");
      expect(text()).toContain("Orbit is confirming your session.");
      expect(signInLink()).toBeNull();
    });
  });

  describe("could not open safely", () => {
    it("announces the failure and offers a retry, with no way past the boundary", async () => {
      await render({ error: "Orbit sign-in is not configured. Ask your administrator to configure authentication, then try again.", onRetry });

      expect(heading()).toBe("Orbit could not open safely.");
      const alert = container.querySelector("[role='alert']");
      expect(alert?.textContent).toBe("Orbit sign-in is not configured. Ask your administrator to configure authentication, then try again.");
      expect(signInLink()).toBeNull();

      const retry = container.querySelector("button")!;
      expect(retry.textContent).toContain("Try again");
      await act(async () => {
        retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it("shows only the message it is given — never provider or host detail of its own", async () => {
      await render({ error: "Orbit could not connect safely. Check your connection and try again.", onRetry });

      expect(text()).not.toMatch(/https?:|\.invalid|localhost|127\.0\.0\.1/);
    });

    it("drops the retry when the caller cannot offer one", async () => {
      await render({ error: "Orbit could not connect safely. Check your connection and try again." });

      expect(container.querySelectorAll("a, button")).toHaveLength(0);
    });
  });

  describe("just signed out", () => {
    /** Mimics a browser that signed out on the previous page: the notice is
     *  written by one document, then a fresh module graph stands in for the
     *  document that lands afterwards. */
    async function arriveFromSignOut() {
      markSignedOut();
      await loadGate();
    }

    it("confirms the sign-out while keeping the way back in", async () => {
      await arriveFromSignOut();
      await render();

      // The heading is deliberately unchanged: sign-out is a security event
      // whose e2e coverage asserts the visitor lands on the authentication
      // boundary by this heading.
      expect(heading()).toBe("Sign in to Orbit.");
      expect(text()).toContain("Signed out");
      expect(text()).toContain("You are signed out on this device.");
      expect(signInLink()?.textContent).toContain("Sign back in");
    });

    it("takes the sun down instead of up", async () => {
      await arriveFromSignOut();
      await render();

      expect(container.querySelector(".family-screen")?.getAttribute("data-phase")).toBe("set");
    });

    it("does not claim a sign-out for a visitor who was never signed in", async () => {
      await render();

      expect(heading()).toBe("Sign in to Orbit.");
      expect(text()).not.toContain("You are signed out on this device.");
      expect(signInLink()?.textContent).toContain("Sign in securely");
    });

    it("shows the plain sign-in screen again on the next load", async () => {
      await arriveFromSignOut();
      await render();
      expect(text()).toContain("You are signed out on this device.");

      await loadGate();
      await render();
      expect(text()).not.toContain("You are signed out on this device.");
    });
  });

  describe("theme packs", () => {
    it("falls back to the default pack when nothing is stored", async () => {
      await render();

      expect(container.querySelector(".family-screen")?.getAttribute("data-theme")).toBe("starchart");
    });

    it("keeps a returning member on the pack they chose", async () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ theme: "dawn", textSize: "comfortable", emailNotifications: true, pushNotifications: true }));
      await loadGate();
      await render();

      expect(container.querySelector(".family-screen")?.getAttribute("data-theme")).toBe("dawn");
    });

    it("ignores unusable stored preferences rather than rendering unthemed", async () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "{not json");
      await loadGate();
      await render();

      expect(container.querySelector(".family-screen")?.getAttribute("data-theme")).toBe("starchart");
    });
  });
});
