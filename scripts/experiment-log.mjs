#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REGISTER_PATH = resolve(REPO_ROOT, "docs/experiments/extraction.json");
const DEFAULT_OUT_DIR = "tmp/experiment-log";
const HOLDOUT_PREFIX = "hold-out: ";

// Fixed reading order for the results tables, independent of the order the
// register happens to list corpora in.
const CORPUS_ORDER = ["tuning-24", "holdout-12", "fullpage-6", "old-36"];

const DELTA_VERDICTS = new Set(["kept", "baseline"]);
const MUTED_VERDICTS = new Set(["broken run", "unexplained", "set aside"]);

const SCORE_LINE = /^([^:]+):\s*(-?\d+(?:\.\d+)?)%\s*\((-?\d+)\/(\d+)\)\s*\[(.*)\]\s*$/u;
const FIELD_SCORE = /([A-Za-z]+)\s+(-?\d+(?:\.\d+)?)%\s*\((-?\d+)\/(\d+)\)/gu;

/**
 * Parses one line of eval-script output, e.g.:
 *   sieve+tag+choose+model: 80.8% (156/193) [provider 75.0% (18/24), ...]
 * into `{ route, scores: { overall, <field>: {...}, ... } }`. Percentages and
 * nets may be negative.
 */
export function parseScoreLine(line) {
  const match = SCORE_LINE.exec(line.trim());
  if (!match) {
    throw new Error(`Could not parse a score line from: ${line}`);
  }
  const [, route, pct, net, of, fieldsPart] = match;
  const scores = { overall: toScore(pct, net, of) };

  FIELD_SCORE.lastIndex = 0;
  let fieldMatch;
  while ((fieldMatch = FIELD_SCORE.exec(fieldsPart)) !== null) {
    const [, name, fieldPct, fieldNet, fieldOf] = fieldMatch;
    scores[name] = toScore(fieldPct, fieldNet, fieldOf);
  }

  return { route: route.trim(), scores };
}

function toScore(pct, net, of) {
  return { pct: Number(pct), net: Number(net), of: Number(of) };
}

/** Finds the first line starting with `prefix`, stripping a leading "hold-out: " if present. */
export function findScoreLine(content, prefix) {
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.startsWith(HOLDOUT_PREFIX) ? rawLine.slice(HOLDOUT_PREFIX.length) : rawLine;
    if (line.startsWith(prefix)) return line;
  }
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPct(pct) {
  return `${pct.toFixed(1)}%`;
}

function renderDeltaLine(delta) {
  const rounded = Math.round(delta * 10) / 10 || 0; // normalises -0 to 0
  if (rounded === 0) {
    return `<span class="delta delta-zero">0.0</span>`;
  }
  const sign = rounded > 0 ? "+" : "−";
  const cls = rounded > 0 ? "delta-up" : "delta-down";
  return `<span class="delta ${cls}">${sign}${Math.abs(rounded).toFixed(1)}</span>`;
}

function renderScoreCell(score, previousPct) {
  if (!score) return `<td class="score">–</td>`;
  const delta = previousPct == null ? "" : `<br>${renderDeltaLine(score.pct - previousPct)}`;
  return `<td class="score"><span class="pct">${formatPct(score.pct)}</span><br><span class="netof">${score.net}/${score.of}</span>${delta}</td>`;
}

function renderCorpusTable(corpusKey, description, experiments, fields) {
  const rows = experiments.filter((experiment) => experiment.corpus === corpusKey);
  if (rows.length === 0) return "";

  // A change is measured against the last trusted run that asked the same
  // model: rules-only against rules-only, qwen against qwen. Comparing a
  // rules-only run with a model run would read as progress or loss where
  // only the chooser differs.
  const previousByModel = new Map(); // model -> { overall: pct, fields: { name: pct } }
  const bodyRows = rows.map((experiment) => {
    const deltaEligible = DELTA_VERDICTS.has(experiment.verdict);
    const muted = MUTED_VERDICTS.has(experiment.verdict);
    const previous = previousByModel.get(experiment.model) ?? null;
    const cells = [renderScoreCell(experiment.scores.overall, deltaEligible ? previous?.overall : null)];
    for (const field of fields) {
      const score = experiment.scores[field];
      cells.push(renderScoreCell(score, deltaEligible ? previous?.fields?.[field] : null));
    }
    if (deltaEligible) {
      previousByModel.set(experiment.model, {
        overall: experiment.scores.overall.pct,
        fields: Object.fromEntries(fields.map((field) => [field, experiment.scores[field]?.pct])),
      });
    }
    return `<tr${muted ? ' class="muted"' : ""}>
      <td class="id">${escapeHtml(experiment.id)}</td>
      <td class="date">${escapeHtml(experiment.date)}</td>
      <td class="label">${escapeHtml(experiment.label)}</td>
      <td class="model">${escapeHtml(experiment.model)}</td>
      <td class="verdict">${escapeHtml(experiment.verdict)}</td>
      ${cells.join("\n      ")}
    </tr>`;
  });

  const fieldHeaders = fields.map((field) => `<th>${escapeHtml(field)}</th>`).join("");
  return `<section class="corpus">
  <h2>${escapeHtml(description)}</h2>
  <table>
    <thead>
      <tr><th>ID</th><th>date</th><th>label</th><th>model</th><th>verdict</th><th>overall</th>${fieldHeaders}</tr>
    </thead>
    <tbody>
      ${bodyRows.join("\n      ")}
    </tbody>
  </table>
</section>`;
}

function renderLegend(verdicts) {
  const items = Object.entries(verdicts)
    .map(([name, description]) => `<li><strong>${escapeHtml(name)}</strong> — ${escapeHtml(description)}</li>`)
    .join("");
  return `<ul class="legend">${items}</ul>`;
}

function renderWhatWeDid(experiments) {
  const blocks = experiments.map((experiment) => {
    const rows = [
      ["What", experiment.what],
      ["How", experiment.how],
      ["Model", experiment.model],
      ["Commit", experiment.commit],
      ["Output", experiment.output],
      ["Verdict", experiment.verdict],
      ["Notes", experiment.notes],
    ].filter(([, value]) => value != null && String(value).trim() !== "");

    const rowsHtml = rows
      .map(([label, value]) => `<div class="row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
      .join("\n        ");

    return `<article class="experiment">
      <h3>${escapeHtml(experiment.id)} — ${escapeHtml(experiment.label)}</h3>
      <dl>
        ${rowsHtml}
      </dl>
    </article>`;
  });
  return blocks.join("\n    ");
}

const CSS = `
  :root { color-scheme: light; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    max-width: 100rem;
    margin: 0 auto;
    padding: 1rem 1rem 3rem;
    line-height: 1.5;
    color: #1f2328;
  }
  h1, h2, h3 { line-height: 1.25; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1rem 0;
    font-size: 0.9rem;
  }
  caption { text-align: left; }
  th, td {
    border: 1px solid #d0d7de;
    padding: 0.35rem 0.5rem;
    text-align: left;
    vertical-align: top;
  }
  th { background: #f6f8fa; }
  tbody tr:nth-child(even) { background: #fafbfc; }
  td.label { min-width: 14rem; white-space: normal; }
  td.date, td.id, td.verdict { white-space: nowrap; }
  td.model { min-width: 6rem; }
  .tables { overflow-x: auto; }
  td.score { white-space: nowrap; }
  .pct { font-weight: 600; }
  .netof { font-size: 0.75rem; color: #57606a; }
  .delta { font-size: 0.75rem; }
  .delta-up { color: #1a7f37; }
  .delta-down { color: #cf222e; }
  .delta-zero { color: #6e7781; }
  tr.muted { color: #6e7781; }
  ul.legend { padding-left: 1.25rem; }
  .experiment { margin: 1rem 0; padding-bottom: 0.5rem; border-bottom: 1px solid #d0d7de; }
  .experiment dl { margin: 0.25rem 0 0; }
  .experiment .row { display: flex; gap: 0.5rem; margin: 0.15rem 0; }
  .experiment dt { flex: 0 0 5.5rem; font-weight: 600; }
  .experiment dd { margin: 0; }
  @media (max-width: 30rem) {
    table { font-size: 0.8rem; }
    .experiment .row { flex-direction: column; gap: 0; }
    .experiment dt { flex-basis: auto; }
  }
`;

/** Renders the full one-page microsite HTML for a register object. */
export function renderHtml(register) {
  const { title, scoring, fields, corpora, verdicts, experiments } = register;

  const corpusSections = CORPUS_ORDER
    .filter((key) => corpora[key])
    .map((key) => renderCorpusTable(key, corpora[key], experiments, fields))
    .filter(Boolean)
    .join("\n  ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(scoring)}</p>
  <p>The small green and red numbers under a score are the change, in percentage points, since the last trusted run in the same table that asked the same model. Greyed rows are runs whose numbers are not trusted; they carry no change.</p>
  ${renderLegend(verdicts)}
  ${corpusSections}
  <h2>What we did</h2>
  ${renderWhatWeDid(experiments)}
</body>
</html>
`;
}

function loadRegister() {
  return JSON.parse(readFileSync(REGISTER_PATH, "utf8"));
}

function writeRendered(register, outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "index.html"), renderHtml(register));
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function cmdRender(flags) {
  const outDir = resolve(process.cwd(), flags.out ?? DEFAULT_OUT_DIR);
  writeRendered(loadRegister(), outDir);
  process.stdout.write(`Wrote ${resolve(outDir, "index.html")}\n`);
}

function cmdRecord(flags) {
  const id = requireFlag(flags, "id");
  const from = requireFlag(flags, "from");
  const linePrefix = requireFlag(flags, "line");
  const label = requireFlag(flags, "label");
  const corpus = requireFlag(flags, "corpus");
  const model = requireFlag(flags, "model");
  const what = requireFlag(flags, "what");
  const how = requireFlag(flags, "how");
  const commit = requireFlag(flags, "commit");
  const verdict = requireFlag(flags, "verdict");

  const register = loadRegister();
  if (register.experiments.some((experiment) => experiment.id === id)) {
    throw new Error(`Experiment ${id} already exists in the register; refusing to add a duplicate.`);
  }

  const fromPath = resolve(process.cwd(), from);
  const content = readFileSync(fromPath, "utf8");
  const line = findScoreLine(content, linePrefix);
  if (line === null) {
    throw new Error(`No line starting with "${linePrefix}" found in ${from}`);
  }
  const { route, scores } = parseScoreLine(line);

  register.experiments.push({
    id,
    date: flags.date ?? isoToday(),
    label,
    corpus,
    model,
    route,
    what,
    how,
    commit,
    output: from,
    scores,
    verdict,
    notes: flags.notes ?? "",
  });

  writeFileSync(REGISTER_PATH, `${JSON.stringify(register, null, 2)}\n`);
  const outDir = resolve(process.cwd(), flags.out ?? DEFAULT_OUT_DIR);
  writeRendered(register, outDir);
  process.stdout.write(`Recorded ${id} and wrote ${resolve(outDir, "index.html")}\n`);
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for --${name}`);
    }
    flags[name] = value;
    index += 1;
  }
  return flags;
}

function runCli() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (command === "render") {
    cmdRender(flags);
  } else if (command === "record") {
    cmdRecord(flags);
  } else {
    throw new Error(`Unknown command "${command ?? ""}". Use "render" or "record".`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "experiment-log failed."}\n`);
    process.exitCode = 1;
  }
}
