import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1316 (release-audit fix, owner decision 2026-10-12, option 3a): the note
 * under the Administration upload-limit field must tell the truth about mail.
 * Mail-in has its own fixed 25 MiB cap, per message and per set of
 * attachments; the upload limit only lowers what mail accepts. It does not
 * govern mail, so the note must not list mail among the places the limit
 * applies. (A separately configurable mail limit is a later feature, #1388,
 * and is not tested here.)
 *
 * Proved against the file that ships, the way the neighbouring administration
 * tests are: web/'s own tests are Playwright and this suite has no Svelte
 * runner.
 */

const ADMINISTRATION = readFileSync(
  new URL("../../web/src/routes/administration/+page.svelte", import.meta.url),
  "utf8",
);

/** The editor's note: the paragraph under the "limit in MB" field, flattened to plain text. */
function limitNote() {
  const card = ADMINISTRATION.slice(
    ADMINISTRATION.indexOf('id="upload-limit-card"'),
    ADMINISTRATION.indexOf("A reverse proxy in front of Orbit"),
  );
  const field = card.indexOf("limit in MB");
  expect(field).toBeGreaterThan(-1);
  const after = card.slice(field);
  const open = after.search(/<p\b[^>]*>/u);
  expect(open).toBeGreaterThan(-1);
  const body = after.slice(after.indexOf(">", open) + 1, after.indexOf("</p>", open));
  return body.replace(/\{[^}]*\}/gu, " ").replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
}

describe("the administration upload-limit editor's note", () => {
  it("does not claim the upload limit applies to mail", () => {
    const note = limitNote();
    expect(note).not.toMatch(/\bor mail\b/iu);
    expect(note).not.toMatch(/create form, an item, or mail/iu);
  });

  it("names mail's own fixed 25 MiB cap", () => {
    const note = limitNote();
    expect(note).toMatch(/\bmail\b/iu);
    expect(note).toMatch(/25\s*MiB/u);
    expect(note).toMatch(/\bfixed\b/iu);
  });
});
