import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * #1608: shorter artifact expiry for the jobs that hold most of the CI
 * artifact storage. Written from the specification alone.
 *
 *   - `fast`, `fast_docker` and the smoke jobs keep their artifacts for exactly
 *     7 days (scripts/ci/reuse-lookup.mjs reuses evidence up to 7 days old, so
 *     not shorter).
 *   - `build_launcher`'s archives expire after 14 days, except on `main`,
 *     `preview` and `hotfix/*`, which keep them 90 days. Hotfix was added at
 *     build time: a hotfix tag is released from its hotfix pipeline exactly as
 *     a preview tag is (.github/workflows/release-on-tag.yml), so 14 days there
 *     could leave a late hotfix tag with nothing to publish.
 *
 * A job declares one `expire_in`, so the launcher change may be two variants of
 * the job chosen by `rules`, or a second job that keeps the archives on the
 * protected refs. The test does not care which: it finds every job that
 * publishes the launcher archives (following `extends:` and `<<:` merges),
 * works out which of them a pipeline on a given ref would run, and checks the
 * longest expiry among them. The pipeline is read as text, the way
 * scripts/ci/job-inputs.test.mjs and scripts/gitlab-ci-lanes.test.mjs read it,
 * because no YAML parser is a dependency of this repository.
 */

const pipeline = readFileSync(new URL("../../.gitlab-ci.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");

// ---------------------------------------------------------------------------
// Reading the pipeline file: top-level blocks, anchors, extends, rules.
// ---------------------------------------------------------------------------

const indentOf = (line) => line.length - line.trimStart().length;

// Top-level blocks by name: a `name:` at column zero (optionally `&anchor`),
// up to the next one. Blank and comment-only lines are dropped.
const blocks = new Map();
const byAnchor = new Map();
{
  const headers = [...pipeline.matchAll(/^([A-Za-z_.][A-Za-z0-9_.-]*):[ \t]*(?:&(\S+)[ \t]*\|?[ \t]*)?(?:#.*)?$/gmu)];
  headers.forEach((match, index) => {
    const end = index + 1 < headers.length ? headers[index + 1].index : pipeline.length;
    const lines = pipeline
      .slice(match.index, end)
      .split("\n")
      .slice(1)
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    blocks.set(match[1], { name: match[1], anchor: match[2], lines });
    if (match[2]) byAnchor.set(match[2], match[1]);
  });
}

const stripComment = (value) => value.replace(/\s+#.*$/u, "").trim();

/* The lines under a job's own `  key:`, and whatever follows the colon. */
function section(lines, key) {
  const start = lines.findIndex((line) => new RegExp(`^ {2}${key}:(\\s|$)`, "u").test(line));
  if (start < 0) return null;
  const inline = stripComment(lines[start].slice(lines[start].indexOf(":") + 1));
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = indentOf(line);
    if (indent > 2 || (indent === 2 && line.trim().startsWith("- "))) body.push(line);
    else break;
  }
  return { inline, body };
}

/* The blocks a job inherits from: `extends:` and `<<: *anchor` merges. */
function parentsOf(name) {
  const { lines } = blocks.get(name);
  const found = [];
  const extended = section(lines, "extends");
  if (extended) {
    const inline = extended.inline.replace(/^\[|\]$/gu, "");
    const names = [...inline.split(","), ...extended.body.map((line) => line.trim().replace(/^-\s*/u, ""))];
    for (const entry of names.map((value) => value.trim()).filter(Boolean)) found.push(entry);
  }
  for (const line of lines) {
    const merge = /^ {2}<<:\s*\*(\S+)\s*$/u.exec(line);
    if (merge && byAnchor.has(merge[1])) found.push(byAnchor.get(merge[1]));
  }
  return found.filter((entry) => blocks.has(entry));
}

/* A key's section on the job itself, else on the nearest block it inherits from. */
function resolveSection(name, key, visited = new Set()) {
  if (visited.has(name) || !blocks.has(name)) return null;
  visited.add(name);
  const own = section(blocks.get(name).lines, key);
  if (own) return own;
  for (const parent of [...parentsOf(name)].reverse()) {
    const inherited = resolveSection(parent, key, visited);
    if (inherited) return inherited;
  }
  return null;
}

/* A section whose value is `*anchor` stands for that anchored block's body. */
function expand(sectionValue) {
  if (!sectionValue) return null;
  const alias = /^\*(\S+)$/u.exec(sectionValue.inline);
  if (alias) {
    expect(byAnchor.has(alias[1]), `*${alias[1]} has no anchor in .gitlab-ci.yml`).toBe(true);
    return blocks.get(byAnchor.get(alias[1])).lines;
  }
  return sectionValue.body;
}

/* One field of `artifacts:`, the job's own value first, then inherited (GitLab merges the hashes). */
function artifactField(name, read, visited = new Set()) {
  if (visited.has(name) || !blocks.has(name)) return undefined;
  visited.add(name);
  const own = expand(section(blocks.get(name).lines, "artifacts"));
  const value = own ? read(own) : undefined;
  if (value !== undefined) return value;
  for (const parent of [...parentsOf(name)].reverse()) {
    const inherited = artifactField(parent, read, visited);
    if (inherited !== undefined) return inherited;
  }
  return undefined;
}

const readExpireIn = (lines) => {
  const found = lines.map((line) => /^\s*expire_in:\s*(.+)$/u.exec(line)).find(Boolean);
  return found ? stripComment(found[1]).replace(/^["']|["']$/gu, "") : undefined;
};

const readPaths = (lines) => {
  const start = lines.findIndex((line) => /^\s*paths:\s*$/u.test(line));
  if (start < 0) return undefined;
  const paths = [];
  for (const line of lines.slice(start + 1)) {
    if (indentOf(line) <= indentOf(lines[start]) && !line.trim().startsWith("- ")) break;
    const item = /^\s*-\s+(\S+)/u.exec(line);
    if (item) paths.push(item[1]);
  }
  return paths;
};

const DAYS = { second: 1 / 86_400, minute: 1 / 1_440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 };

/* "14 days", "1 week", "4 hours" as a number of days. */
function expiryDays(text) {
  if (text === undefined) return Number.NaN;
  if (/^never$/iu.test(text)) return Number.POSITIVE_INFINITY;
  const match = /^(\d+)\s*(second|minute|hour|day|week|month|year)s?$/iu.exec(text.trim());
  if (!match) return Number.NaN;
  return Number(match[1]) * DAYS[match[2].toLowerCase()];
}

// ---------------------------------------------------------------------------
// Which jobs a pipeline on a given ref runs: `rules:` with a small `if:` evaluator.
// ---------------------------------------------------------------------------

function tokenise(expression) {
  const tokens = [];
  let index = 0;
  while (index < expression.length) {
    const rest = expression.slice(index);
    let match;
    if (/^\s/u.test(rest)) index += 1;
    else if ((match = /^(&&|\|\||==|!=|=~|!~|\(|\))/u.exec(rest))) {
      tokens.push({ type: "op", value: match[1] });
      index += match[1].length;
      if (match[1] === "=~" || match[1] === "!~") {
        while (expression[index] === " ") index += 1;
        let end = index + 1;
        while (end < expression.length && expression[end] !== "/") end += expression[end] === "\\" ? 2 : 1;
        const flags = /^[a-z]*/u.exec(expression.slice(end + 1))[0];
        tokens.push({ type: "regex", value: new RegExp(expression.slice(index + 1, end), flags) });
        index = end + 1 + flags.length;
      }
    } else if ((match = /^\$([A-Za-z_][A-Za-z0-9_]*)/u.exec(rest))) {
      tokens.push({ type: "var", value: match[1] });
      index += match[0].length;
    } else if ((match = /^"([^"]*)"|^'([^']*)'/u.exec(rest))) {
      tokens.push({ type: "string", value: match[1] ?? match[2] });
      index += match[0].length;
    } else if ((match = /^null\b/u.exec(rest))) {
      tokens.push({ type: "null" });
      index += match[0].length;
    } else {
      throw new Error(`cannot read the rule expression at "${rest}" in: ${expression}`);
    }
  }
  return tokens;
}

/* GitLab's `rules:if` subset the pipeline uses; an unset variable is null. */
function evaluate(expression, variables) {
  const tokens = tokenise(expression);
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const valueOf = (token) => (token.type === "var" ? (variables[token.value] ?? null) : token.type === "null" ? null : token.value);

  function primary() {
    const token = take();
    if (token.type === "op" && token.value === "(") {
      const inner = or();
      take();
      return inner;
    }
    return token;
  }
  function comparison() {
    const left = primary();
    const next = peek();
    if (next?.type === "op" && ["==", "!=", "=~", "!~"].includes(next.value)) {
      take();
      const right = primary();
      if (next.value === "=~" || next.value === "!~") {
        const subject = valueOf(left);
        const hit = subject !== null && right.value.test(subject);
        return next.value === "=~" ? hit : !hit;
      }
      const equal = valueOf(left) === valueOf(right);
      return next.value === "==" ? equal : !equal;
    }
    if (typeof left === "boolean") return left;
    const value = valueOf(left);
    return value !== null && value !== "";
  }
  function and() {
    let result = comparison();
    while (peek()?.type === "op" && peek().value === "&&") {
      take();
      const right = comparison();
      result = result && right;
    }
    return result;
  }
  function or() {
    let result = and();
    while (peek()?.type === "op" && peek().value === "||") {
      take();
      const right = and();
      result = result || right;
    }
    return result;
  }
  return Boolean(or());
}

/* A mapping's lines as one rule: its `if:` and `when:`; `changes:` is taken to match. */
function mappingToRule(lines) {
  const base = Math.min(...lines.map(indentOf));
  const rule = {};
  for (const line of lines) {
    if (indentOf(line) !== base) continue;
    const key = /^\s*(if|when):\s*(.*)$/u.exec(line);
    if (!key) continue;
    let value = stripComment(key[2]);
    if (/^(["']).*\1$/u.test(value)) value = value.slice(1, -1);
    rule[key[1]] = value;
  }
  return rule;
}

/* Rule items from a list's lines, with `- *alias` entries expanded. */
function parseRules(lines) {
  const itemIndent = Math.min(...lines.filter((line) => line.trim().startsWith("- ")).map(indentOf));
  const items = [];
  for (const line of lines) {
    if (indentOf(line) === itemIndent && line.trim().startsWith("- ")) items.push([line.replace("- ", "  ")]);
    else items.at(-1)?.push(line);
  }
  return items.flatMap((item) => {
    const alias = /^\s*\*(\S+)\s*$/u.exec(item[0]);
    if (!alias) return [mappingToRule(item)];
    expect(byAnchor.has(alias[1]), `*${alias[1]} has no anchor in .gitlab-ci.yml`).toBe(true);
    const target = blocks.get(byAnchor.get(alias[1])).lines;
    return target[0].trim().startsWith("- ") ? parseRules(target) : [mappingToRule(target)];
  });
}

function rulesOf(name) {
  const lines = expand(resolveSection(name, "rules"));
  return lines && lines.length > 0 ? parseRules(lines) : null;
}

/* Does a pipeline with these variables run the job (on success or by hand)? */
function runs(name, variables) {
  const rules = rulesOf(name);
  if (!rules) return true;
  for (const rule of rules) {
    if (rule.if === undefined || evaluate(rule.if, variables)) return rule.when !== "never";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pipelines on the refs that matter. `changes:` rules count as matching.
// ---------------------------------------------------------------------------

const push = (branch) => ({
  CI_PIPELINE_SOURCE: "push",
  CI_COMMIT_BRANCH: branch,
  CI_COMMIT_REF_NAME: branch,
  CI_COMMIT_REF_PROTECTED: ["dev", "preview", "main"].includes(branch) ? "true" : "false",
});

const contexts = {
  dev: push("dev"),
  preview: push("preview"),
  main: push("main"),
  hotfix: push("hotfix/launcher-crash"),
  "an unprotected branch pipeline started by hand": {
    CI_PIPELINE_SOURCE: "web",
    CI_COMMIT_BRANCH: "feature/launcher-tweak",
    CI_COMMIT_REF_NAME: "feature/launcher-tweak",
    CI_COMMIT_REF_PROTECTED: "false",
  },
  "a merge request from a working branch into dev": {
    CI_PIPELINE_SOURCE: "merge_request_event",
    CI_COMMIT_REF_NAME: "feature/launcher-tweak",
    CI_COMMIT_REF_PROTECTED: "false",
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature/launcher-tweak",
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev",
  },
};

// ---------------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------------

describe("#1608 fast and smoke artifacts", () => {
  const sevenDayJobs = ["fast", "fast_docker", "smoke", "smoke_firefox", "smoke_webkit", "smoke_webkit_mobile", "smoke_local_only"];

  it.each(sevenDayJobs)("%s keeps its artifacts for exactly 7 days", (job) => {
    expect(blocks.has(job), `${job} is not defined in .gitlab-ci.yml`).toBe(true);
    const expireIn = artifactField(job, readExpireIn);
    expect(expireIn, `${job} declares no artifacts expire_in`).toBeDefined();
    expect(expiryDays(expireIn), `${job} has expire_in: ${expireIn}`).toBe(7);
  });
});

describe("#1608 build_launcher artifacts", () => {
  // Every job that publishes the launcher archives: build_launcher itself, any
  // variant of it, and any job that re-publishes them for the protected refs.
  const carriers = [...blocks.keys()].filter(
    (name) => !name.startsWith(".") && (artifactField(name, readPaths) ?? []).some((path) => path.startsWith(".orbit-launcher-artifacts")),
  );

  /* The longest expiry among the carriers a pipeline on this ref would run. */
  const effective = (variables) => {
    const running = carriers.filter((name) => runs(name, variables));
    return {
      running,
      days: Math.max(...running.map((name) => expiryDays(artifactField(name, readExpireIn)))),
    };
  };

  it("is published by a job that exists", () => {
    expect(carriers).toContain("build_launcher");
  });

  it("gives every job that publishes the archives a plain expiry of 14 or 90 days", () => {
    for (const name of carriers) {
      const days = expiryDays(artifactField(name, readExpireIn));
      expect([14, 90], `${name} has expire_in: ${artifactField(name, readExpireIn)}`).toContain(days);
    }
  });

  it.each(["dev", "an unprotected branch pipeline started by hand", "a merge request from a working branch into dev"])(
    "expires the archives after 14 days on %s",
    (context) => {
      const { running, days } = effective(contexts[context]);
      expect(running.length, `no job publishes the archives on ${context}`).toBeGreaterThan(0);
      expect(days).toBe(14);
    },
  );

  // Two publishers on one ref would hide a 14-day copy behind a 90-day one.
  it.each(Object.keys(contexts))("runs at most one job that publishes the archives on %s", (context) => {
    expect(effective(contexts[context]).running.length).toBeLessThanOrEqual(1);
  });

  it.each(["preview", "hotfix"])("keeps the archives 90 days on %s", (context) => {
    const { running, days } = effective(contexts[context]);
    expect(running.length, `no job publishes the archives on ${context}`).toBeGreaterThan(0);
    expect(days).toBe(90);
  });

  // A push to `main` runs `promote_stable` and nothing else (#1546), so today no
  // job publishes the archives there. If one ever does, it must keep them 90 days.
  it("keeps the archives 90 days on main, wherever a job publishes them there", () => {
    const { running, days } = effective(contexts.main);
    if (running.length > 0) expect(days).toBe(90);
  });
});
