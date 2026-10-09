import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q9: the desktop create form's submit handler built its
 * item.upsert payload by hand instead of calling entry.js's
 * createCommandOf/fieldsOf — the one place the kind→fields mapping, the
 * recurrence bound and the cost parsing live, already used by the pocket's
 * own form (pocket.svelte's save()). The hand-rolled copy's recurrence
 * guard (`kindRecurs(chosenType)`) differed from fieldsOf's own
 * (`scheduleKind !== "expiry"`), equivalent only because "document" is the
 * only expiry kind today, and it never capped recurrenceMonths at
 * RECURRENCE_MAX or used entry.js's own comma-aware cost parser.
 *
 * The fix adds one entryFromForm() read fresh off the DOM, used by both the
 * existing refusal check and the save payload via createCommandOf. Since
 * #1325 (ADR-0034) the refusal check is the engine's dry run of that same
 * command (commandFromForm), so the form asks about exactly what it sends.
 */

const BEHAVIOUR = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/create/create.behaviour.js"),
  "utf8",
);

describe("#1151 W1-Q9: the desktop create form reuses entry.js's own mapping", () => {
  it("imports createCommandOf instead of scheduleOf", () => {
    expect(BEHAVIOUR).toMatch(/import \{ createCommandOf, kindHasDate, kindRecurs, recurrenceOfChoice \} from "\.\/entry\.js";/u);
    expect(BEHAVIOUR).not.toContain("scheduleOf(chosenType)");
  });

  it("entryFromForm() builds the full Entry shape, used by both the dry run and the save", () => {
    const fn = BEHAVIOUR.slice(BEHAVIOUR.indexOf("function entryFromForm()"), BEHAVIOUR.indexOf("function commandFromForm()"));
    expect(fn).toMatch(/kind: chosenType,/u);
    expect(fn).toMatch(/sectionId: chosenSection,/u);
    expect(fn).toMatch(/reminderDays: \[Number\(value\("f-reminder"\)\)\],/u);
    const commandFn = BEHAVIOUR.slice(BEHAVIOUR.indexOf("function commandFromForm()"), BEHAVIOUR.indexOf("function commandFromForm()") + 200);
    expect(commandFn).toMatch(/return createCommandOf\(entryFromForm\(\), \{/u);
    expect(BEHAVIOUR).toMatch(/dryRun\.ask\(\(\) => household \? commandFromForm\(\) : null\)/u);
    expect(BEHAVIOUR).not.toMatch(/refusalOf/u);
  });

  it("the submit handler calls createCommandOf instead of hand-building the item", () => {
    const submitHandler = BEHAVIOUR.slice(BEHAVIOUR.indexOf('on(card, "submit"'));
    expect(submitHandler).toMatch(/await applyCommand\(commandFromForm\(\)\)/u);
    // the hand-rolled recurrence/cost logic this used to carry is gone
    expect(submitHandler).not.toMatch(/kindRecurs\(chosenType\)/u);
    expect(submitHandler).not.toMatch(/Math\.round\(Number\(cost\)/u);
  });
});
