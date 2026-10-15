import { describe, expect, it } from "vitest";

import { WorkspaceError, refusesFile } from "../../web/src/lib/data/workspace.js";

/*
 * #1316: refusesFile says the FILE itself is refused (its type, size,
 * structure, or malware), so the card offers "Replace it, or remove it to
 * save without it". The server also answers 413 when the household or the
 * whole instance is out of document storage (document-repository.ts,
 * reserveDocumentMetadata). That is not the file's fault and no replacement
 * helps, so it must not read as a refused file.
 */

/** @param {number} status @param {string} code */
const failure = (status, code) => new WorkspaceError("server words", { status, code });

describe("refusesFile tells a refused file from a full store (#1316)", () => {
  it("is false for a household at its storage limit (413 document_household_quota)", () => {
    expect(refusesFile(failure(413, "document_household_quota"))).toBe(false);
  });

  it("is false for an instance at its storage limit (413 document_instance_quota)", () => {
    expect(refusesFile(failure(413, "document_instance_quota"))).toBe(false);
  });

  it("is true for a file over the size limit (413 document_too_large)", () => {
    expect(refusesFile(failure(413, "document_too_large"))).toBe(true);
  });

  it("is true for a file of an unsupported type (415 document_type_unsupported)", () => {
    expect(refusesFile(failure(415, "document_type_unsupported"))).toBe(true);
  });

  it("is true for a file with malware found (422 document_malware_detected)", () => {
    expect(refusesFile(failure(422, "document_malware_detected"))).toBe(true);
  });
});
