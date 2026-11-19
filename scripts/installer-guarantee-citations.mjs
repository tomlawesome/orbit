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
 * in its parentheses is not checked here; main-script ranges and cited
 * content (both #1880) have their own checks below.
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

/**
 * #1846: the `install.sh:<lines> (main script, ...)` citations name top-level
 * code, not a function, so the check above cannot see them. A segment counts
 * as a main-script citation when its parenthetical starts "main script", or it
 * is a bare range (no parenthetical) followed by one that does
 * (`2943-2947, 2971-2987 (main script, ...)`). Returns every one as
 * `{ guarantee, index, citation, first, last }`, `index` being the segment's
 * position among the guarantee's `install.sh` citations.
 */
export function mainScriptCitations(docText) {
  const found = [];
  for (const { guarantee, text } of numberedGuarantees(docText)) {
    const segments = installShSegments(text);
    let pending = [];
    segments.forEach((segment, index) => {
      const entry = { guarantee, index, citation: segment.citation, first: segment.first, last: segment.last };
      if (segment.parenthetical === "") {
        pending.push(entry);
        return;
      }
      if (/^main script/u.test(segment.parenthetical.trim())) found.push(...pending, entry);
      pending = [];
    });
  }
  return found;
}

/**
 * Main-script citations that sit inside a function body, run past the end of
 * the script, or start or end on a blank line.
 */
export function mainScriptCitationProblems(docText, installShText) {
  const lines = installShText.split("\n");
  const spans = [...functionSpans(installShText).entries()];
  const problems = [];
  for (const { guarantee, citation, first, last } of mainScriptCitations(docText)) {
    const report = (problem) => problems.push({ guarantee, citation, problem });
    if (first > last || last > lines.length) {
      report("range is outside the script");
      continue;
    }
    const inside = spans.find(([, span]) => first <= span.end && last >= span.start);
    if (inside) report(`lines overlap function ${inside[0]}`);
    if ((lines[first - 1] ?? "").trim() === "") report("first line is blank");
    if ((lines[last - 1] ?? "").trim() === "") report("last line is blank");
  }
  return problems;
}

/**
 * `expectations` is a list of `{ guarantee, index, contains: [substring] }`;
 * `guarantee` is "install.sh #17" or "Summary #4" and `index` picks the
 * guarantee's n-th `install.sh` citation segment (from 0). Returns one
 * `{ guarantee, citation, problem }` for each substring the cited lines lack
 * and for each expectation whose citation is missing.
 */
export function citationContentProblems(docText, installShText, expectations) {
  const lines = installShText.split("\n");
  const byGuarantee = new Map();
  for (const { guarantee, text } of numberedGuarantees(docText)) {
    const segments = installShSegments(text);
    if (segments.length > 0 && !byGuarantee.has(guarantee)) byGuarantee.set(guarantee, segments);
  }
  const problems = [];
  for (const { guarantee, index, contains } of expectations) {
    const segment = byGuarantee.get(guarantee)?.[index];
    if (!segment) {
      problems.push({ guarantee, citation: `segment ${index}`, problem: "citation not found" });
      continue;
    }
    const cited = lines.slice(segment.first - 1, segment.last).join("\n");
    for (const needle of contains) {
      if (!cited.includes(needle)) {
        problems.push({ guarantee, citation: segment.citation, problem: `lines lack ${needle}` });
      }
    }
  }
  return problems;
}

/**
 * #1852: the lines of `fileName` (e.g. "docker-compose.yml") that a guarantee
 * cites as `<fileName>:<first>[-<last>]`, joined by newlines; null when the
 * guarantee has no such citation. `guarantee` is "install.sh #39".
 */
export function citedFileLines(docText, fileText, guarantee, fileName) {
  const escaped = fileName.replaceAll(".", "\\.");
  const pattern = new RegExp(`(?<![\\w./-])${escaped}:(\\d+)(?:-(\\d+))?`, "u");
  const entry = numberedGuarantees(docText).find((item) => item.guarantee === guarantee);
  const match = entry && pattern.exec(entry.text);
  if (!match) return null;
  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);
  return fileText.split("\n").slice(first - 1, last).join("\n");
}

/**
 * #1880: citations into a shell script other than install.sh, such as
 * `installer-ui.sh:86-110`, name no function in their parentheses, so they are
 * checked by content. `expectations` is a list of `{ guarantee, index,
 * contains: [substring] }`, as for citationContentProblems, but `index` picks
 * the n-th `<fileName>:` segment of the guarantee (from 0).
 */
export function fileCitationContentProblems(docText, fileText, fileName, expectations) {
  const lines = fileText.split("\n");
  const escaped = fileName.replaceAll(".", "\\.");
  const pattern = new RegExp(`(?<![\\w./-])${escaped}:`, "gu");
  const byGuarantee = new Map();
  for (const { guarantee, text } of numberedGuarantees(docText)) {
    if (!guarantee.startsWith(`${fileName} #`)) continue;
    const segments = [];
    for (const start of text.matchAll(pattern)) {
      let position = start.index + start[0].length;
      for (;;) {
        SEGMENT.lastIndex = position;
        const match = SEGMENT.exec(text);
        if (!match) break;
        const first = Number(match[1]);
        const last = match[2] === undefined ? first : Number(match[2]);
        segments.push({ citation: `${fileName}:${match[0].trim()}`, first, last });
        position = SEGMENT.lastIndex;
        SEPARATOR.lastIndex = position;
        if (!SEPARATOR.exec(text)) break;
        position = SEPARATOR.lastIndex;
      }
    }
    byGuarantee.set(guarantee, segments);
  }
  const problems = [];
  for (const { guarantee, index, contains } of expectations) {
    const segment = byGuarantee.get(guarantee)?.[index];
    if (!segment) {
      problems.push({ guarantee, citation: `segment ${index}`, problem: "citation not found" });
      continue;
    }
    const cited = lines.slice(segment.first - 1, segment.last).join("\n");
    for (const needle of contains) {
      if (!cited.includes(needle)) {
        problems.push({ guarantee, citation: segment.citation, problem: `lines lack ${needle}` });
      }
    }
  }
  return problems;
}

/**
 * #1880: in a guarantee of `<fileName>`'s own section, every backticked name
 * that the script defines as a function must have its first line inside one of the
 * guarantee's `<fileName>:` citation segments. Returns `{ guarantee, citation,
 * problem }` for each one that overlaps none.
 */
export function fileNamedFunctionProblems(docText, fileText, fileName) {
  const spans = functionSpans(fileText);
  const escaped = fileName.replaceAll(".", "\\.");
  const pattern = new RegExp(`(?<![\\w./-])${escaped}:(\\d+(?:-\\d+)?(?:\\s*\\([^)]*\\))?(?:\\s*,\\s*\\d+(?:-\\d+)?(?:\\s*\\([^)]*\\))?)*)`, "gu");
  const problems = [];
  for (const { guarantee, text } of numberedGuarantees(docText)) {
    if (!guarantee.startsWith(`${fileName} #`)) continue;
    const ranges = [];
    for (const match of text.matchAll(pattern)) {
      for (const range of match[1].replace(/\([^)]*\)/gu, "").matchAll(/(\d+)(?:-(\d+))?/gu)) {
        ranges.push([Number(range[1]), Number(range[2] ?? range[1])]);
      }
    }
    if (ranges.length === 0) continue;
    const names = new Set([...text.matchAll(/`([A-Za-z_]\w*)`/gu)].map((m) => m[1]));
    for (const name of names) {
      const span = spans.get(name);
      if (span && !ranges.some(([first, last]) => span.start >= first && span.start <= last)) {
        problems.push({
          guarantee,
          citation: `${fileName}:${ranges.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(",")} [${name}]`,
          problem: `no cited range holds the function's first line (at ${span.start}-${span.end})`,
        });
      }
    }
  }
  return problems;
}

/**
 * #1880: "about N-M" citations, as in repair.sh `name` (about 6478-6499). The
 * script is the last `<script>.sh` named earlier in the same guarantee. Each
 * named function must be defined in the script and start inside the range.
 * `scriptTexts` maps a script name to its text. Returns `{ guarantee,
 * citation, problem }`.
 */
/** Lines past an "about" range within which the function's closing line may fall. */
const ABOUT_END_SLACK = 3;

export function aboutCitationProblems(docText, scriptTexts) {
  const spansByScript = new Map(
    Object.entries(scriptTexts).map(([name, text]) => [name, functionSpans(text)]),
  );
  const token = /([A-Za-z0-9_-]+\.sh)\b|`([A-Za-z_]\w*)`[^`;(]{0,3}\(about (\d+)(?:-(\d+))?\)/gu;
  const problems = [];
  for (const { guarantee, text } of numberedGuarantees(docText)) {
    let script = null;
    for (const match of text.matchAll(token)) {
      if (match[1]) {
        script = match[1];
        continue;
      }
      const first = Number(match[3]);
      const last = match[4] === undefined ? first : Number(match[4]);
      const citation = `${script ?? "?"} \`${match[2]}\` (about ${first}-${last})`;
      const spans = spansByScript.get(script);
      if (!spans) {
        problems.push({ guarantee, citation, problem: "script not available to check" });
        continue;
      }
      const span = spans.get(match[2]);
      if (!span) problems.push({ guarantee, citation, problem: "function not defined" });
      else if (span.start < first || span.start > last) {
        problems.push({ guarantee, citation, problem: `function starts at line ${span.start}, outside the range` });
      }
      else if (span.end < first || span.end > last + ABOUT_END_SLACK) {
        problems.push({ guarantee, citation, problem: `function ends at line ${span.end}, outside the range` });
      }
    }
  }
  return problems;
}
