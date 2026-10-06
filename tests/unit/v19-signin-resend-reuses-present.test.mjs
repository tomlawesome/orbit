import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q5: resendApproval() hand-rolled its own copy of present()'s
 * busy/message/fetch/try-catch-finally scaffold instead of calling it, and
 * on a non-ok response always fell back to the generic
 * cardMessageFor(undefined) rather than present()'s own reading of the
 * error code. A future revision of present()'s refusal wording would
 * silently miss this one button.
 *
 * The fix calls present() directly and only interprets its answer.
 */

const SIGNIN = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/flight/SignIn.svelte"),
  "utf8",
);

describe("#1151 W1-Q5: resendApproval reuses present()", () => {
  it("calls present() rather than its own fetch", () => {
    const fn = SIGNIN.slice(SIGNIN.indexOf("async function resendApproval()"), SIGNIN.indexOf("async function resendApproval()") + 500);
    expect(fn).toMatch(/const answer = await present\("\/api\/auth\/local\/login\/resend", \{\}\);/u);
    expect(fn).not.toMatch(/fetch\(/u);
    expect(fn).not.toMatch(/busy = true/u);
    expect(fn).not.toMatch(/cardMessageFor/u);
  });

  it("still interprets limited/unknown/canResendAt the same way", () => {
    const fn = SIGNIN.slice(SIGNIN.indexOf("async function resendApproval()"), SIGNIN.indexOf("async function resendApproval()") + 500);
    expect(fn).toMatch(/if \(answer\.state === "limited"\) limited = true;/u);
    expect(fn).toMatch(/else if \(answer\.state === "unknown"\) pendingState = "lapsed";/u);
    expect(fn).toMatch(/else canResendAt = Date\.parse\(answer\.canResendAt\) \|\| 0;/u);
  });
});
