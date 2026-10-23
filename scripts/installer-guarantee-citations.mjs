/*
 * #1481: checks the `install.sh:<lines> (<names>)` citations in the numbered
 * guarantees of docs/installer-guarantees.md against the script itself.
 *
 * Which parenthetical items count as function citations (and so are checked):
 * the parenthetical is split on commas, and an item counts only if it is a
 * single identifier (backticks optional) that is lower-case snake_case with an
 * underscore (`load_installer_ui`), or that install.sh defines as a function
 * (`fail`), or if every item in the parenthetical is a single identifier (a
 * plain list of function names, as in `(alpha)`). Everything else is prose and
 * is ignored: descriptive items ("main script", "the `curl` check",
 * "readonly app_readiness_probe" for a variable), and command or setting names
 * such as `docker`, `timeout` or ORBIT_CHANNEL beside such prose.
 *
 * A function's span runs from its `name() {` line at column 0 to the next `}`
 * at column 0. A citation is stale when the function is not defined, or when
 * none of the cited lines fall inside the span. A range with no function name
 * in its parentheses is not checked.
 */

const FUNCTION_START = /^([A-Za-z_][A-Za-z0-9_]*)\(\) *\{/u;
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;
const CITATION_START = /(?<![\w./-])(?:scripts\/)?install\.sh:/gu;
const SEGMENT = /\s*(\d+)(?:-(\d+))?(?:\s*\(([^)]*)\))?/uy;
const SEPARATOR = /\s*,\s*/uy;

/** Map of function name to its { start, end } 1-based line span. */
function functionSpans(installShText) {
  const lines = installShText.split("\n");
  const spans = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = FUNCTION_START.exec(lines[index]);
    if (!match) continue;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next].startsWith("}")) {
        end = next + 1;
        break;
      }
    }
    spans.set(match[1], { start: index + 1, end });
  }
  return spans;
}

/** The numbered guarantees as { guarantee, text }, `guarantee` like "install.sh #5". */
function numberedGuarantees(docText) {
  const entries = [];
  let section = "";
  for (const line of docText.split("\n")) {
    const heading = /^## (\S+)/u.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    const item = /^(\d+)\. (.*)$/u.exec(line);
    if (item) entries.push({ guarantee: `${section} #${item[1]}`, text: item[2] });
  }
  return entries;
}

/** Function names a citation's parenthetical cites, per the rule above. */
function citedFunctionNames(parenthetical, spans) {
  const items = parenthetical.split(",").map((item) => item.trim().replaceAll("`", ""));
  const isIdentifier = (item) => /^[A-Za-z_]\w*$/u.test(item);
  const pureList = items.every(isIdentifier);
  return items.filter(
    (item) => isIdentifier(item) && (pureList || SNAKE_CASE.test(item) || spans.has(item)),
  );
}

/** Every install.sh citation segment in one guarantee: { citation, first, last, names }. */
function installShSegments(text) {
  const segments = [];
  for (const start of text.matchAll(CITATION_START)) {
    let position = start.index + start[0].length;
    let prefix = start[0];
    for (;;) {
      SEGMENT.lastIndex = position;
      const match = SEGMENT.exec(text);
      if (!match) break;
      const first = Number(match[1]);
      const last = match[2] === undefined ? first : Number(match[2]);
      segments.push({
        citation: `${prefix}${match[0].trim()}`,
        first,
        last,
        parenthetical: match[3] ?? "",
      });
      position = SEGMENT.lastIndex;
      SEPARATOR.lastIndex = position;
      if (!SEPARATOR.exec(text)) break;
      position = SEPARATOR.lastIndex;
      prefix = "install.sh:";
    }
  }
  return segments;
}

/**
 * Stale `install.sh` citations in the guarantee catalogue, as
 * `{ guarantee, citation, problem }`; empty when every cited function exists
 * and its cited lines overlap it.
 */
export function staleInstallShCitations(docText, installShText) {
  const spans = functionSpans(installShText);
  const problems = [];
  for (const { guarantee, text } of numberedGuarantees(docText)) {
    for (const segment of installShSegments(text)) {
      for (const name of citedFunctionNames(segment.parenthetical, spans)) {
        const span = spans.get(name);
        let problem = null;
        if (!span) problem = "function not defined";
        else if (segment.last < span.start || segment.first > span.end) {
          problem = "lines do not overlap the function";
        }
        if (problem) problems.push({ guarantee, citation: `${segment.citation} [${name}]`, problem });
      }
    }
  }
  return problems;
}
