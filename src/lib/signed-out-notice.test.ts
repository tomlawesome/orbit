// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "orbit:signed-out:v1";

type Notice = typeof import("./signed-out-notice");

/** A fresh module instance stands in for a fresh document: after a
 *  navigation the browser re-evaluates the bundle and the document token
 *  changes, which is the whole mechanism under test. */
async function nextDocument(): Promise<Notice> {
  vi.resetModules();
  return import("./signed-out-notice");
}

describe("signed-out notice (the sign-out → goodbye-screen hand-off)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("does not hand the notice back to the document that wrote it", async () => {
    // The gate mounts briefly in the signing-out document, between
    // setSession(null) and location.assign(). If it consumed the notice
    // there, the goodbye screen would never be seen.
    const outgoing = await nextDocument();
    outgoing.markSignedOut();

    expect(outgoing.consumeSignedOutNotice()).toBe(false);
    expect(outgoing.signedOutNoticeSnapshot()).toBe(false);
    expect(window.sessionStorage.getItem(KEY)).not.toBeNull();
  });

  it("delivers the notice to the next document exactly once", async () => {
    const outgoing = await nextDocument();
    outgoing.markSignedOut();

    const landing = await nextDocument();
    expect(landing.consumeSignedOutNotice()).toBe(true);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();

    const reload = await nextDocument();
    expect(reload.consumeSignedOutNotice()).toBe(false);
  });

  it("keeps the snapshot stable once read, so repeated renders agree", async () => {
    const outgoing = await nextDocument();
    outgoing.markSignedOut();

    const landing = await nextDocument();
    expect(landing.signedOutNoticeSnapshot()).toBe(true);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    // Read again as React does on every render — including its development
    // double render — after the stored notice is gone.
    expect(landing.signedOutNoticeSnapshot()).toBe(true);
    expect(landing.signedOutNoticeSnapshot()).toBe(true);
  });

  it("renders no notice on the server, so hydration is stable", async () => {
    const notice = await nextDocument();
    expect(notice.noSignedOutNotice()).toBe(false);
  });

  it("stores an opaque token and nothing about the person or household", async () => {
    const notice = await nextDocument();
    notice.markSignedOut();

    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.getItem(KEY)).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });

  it("survives session storage being unavailable", async () => {
    const notice = await nextDocument();
    const unavailable = vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("Storage is blocked by policy");
    });

    expect(() => notice.markSignedOut()).not.toThrow();
    expect(notice.consumeSignedOutNotice()).toBe(false);

    unavailable.mockRestore();
  });

  it("unsubscribing is a no-op — the notice never changes within a document", async () => {
    const notice = await nextDocument();
    expect(() => notice.subscribeToSignedOutNotice()()).not.toThrow();
  });
});
