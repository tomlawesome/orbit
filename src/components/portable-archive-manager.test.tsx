// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortableArchiveManager } from "./portable-archive-manager";

// Regression test for the dead "Import reviewed items" button found by the
// #308 feature review: the commit handler was referenced but never invoked,
// so a previewed import could never actually be committed.

const previewPayload = {
  preview: {
    householdName: "Fixture Home",
    sections: 2,
    items: 5,
    documents: 0,
    conflicts: [],
    documentsExcluded: true,
  },
};

describe("PortableArchiveManager import flow", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/preview")) {
        return new Response(JSON.stringify(previewPayload), { status: 200 });
      }
      if (url.endsWith("/import")) {
        return new Response(JSON.stringify({ importedItems: 5 }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("commits a previewed import when the import button is pressed", async () => {
    await act(async () => {
      root.render(
        <PortableArchiveManager householdId="household-1" csrfToken="token-1" />,
      );
    });

    const importForm = container.querySelector<HTMLFormElement>(
      "form.portable-archive-import",
    );
    expect(importForm).not.toBeNull();

    const archiveFile = new File([JSON.stringify({ format: "fixture" })], "export.json", {
      type: "application/json",
    });
    // happy-dom's FormData(form) does not surface programmatically-set file
    // inputs; stub it so the real handler receives the fixture file.
    vi.stubGlobal(
      "FormData",
      class {
        get(name: string) {
          return name === "archive" ? archiveFile : null;
        }
      },
    );

    await act(async () => {
      importForm!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/preview");

    const importButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Import reviewed items"),
    );
    expect(importButton, "import button appears after a successful preview").toBeDefined();

    await act(async () => {
      importButton!.click();
    });

    const importCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/api/portable-archives/import"),
    );
    expect(importCall, "pressing the button must call the import endpoint").toBeDefined();
    expect(container.textContent).toContain("Imported 5 items");
  });
});
