// The text of .gitlab-ci.yml as it would be without the #1720 batch-intake
// rule: the workflow rule that sets BATCH_INTAKE and every job-rule reference
// to the skip are removed. The batch-intake tests compare the real file with
// this, so "every other pipeline is unchanged" holds against whatever the file
// is today, not a frozen snapshot that any later CI change breaks.
//
// Pure text transform. It throws rather than strip nothing: a renamed anchor
// must not turn the comparison into the file against itself.
export const MIN_SKIP_REFERENCES = 30;

export function stripBatchIntake(text) {
  let removedReferences = 0;
  let out = text
    // Comments carry the words; the YAML does not need them.
    .replace(/^[ \t]*#.*\n/gmu, "")
    // The anchor's own definition.
    .replace(/^\.batch_intake_skip: &batch_intake_skip\n(?: {2}.*\n)+/mu, "")
    // The workflow rule that sets the variable (an `- if:` with a `variables:` map).
    .replace(/^ {4}- if: .*\n {6}variables:\n {8}BATCH_INTAKE: "true"\n/mu, "")
    // Every job's reference, as a list item in a `rules:` list.
    .replace(/^[ \t]*- \*batch_intake_skip[ \t]*\n/gmu, () => {
      removedReferences += 1;
      return "";
    });
  if (removedReferences < MIN_SKIP_REFERENCES) {
    throw new Error(`strip-batch-intake: removed ${removedReferences} skip references, expected at least ${MIN_SKIP_REFERENCES}; was the anchor renamed?`);
  }
  if (/BATCH_INTAKE|batch_intake/u.test(out)) {
    throw new Error("strip-batch-intake: the stripped text still mentions BATCH_INTAKE; the transform missed a place");
  }
  out = out.replace(/\n{3,}/gu, "\n\n");
  return out;
}
