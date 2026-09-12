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

// Verdicts whose numbers are trusted, so a later run can be measured against
// them. A control and a regression are both real runs: only a run that failed
// or is not yet believed drops out of the chain.
const DELTA_VERDICTS = new Set(["kept", "baseline", "control", "regression"]);
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
    return `<span class="delta delta-zero">= 0.0</span>`;
  }
  // A glyph as well as a colour, so the direction never rests on hue alone.
  const glyph = rounded > 0 ? "▲" : "▼";
  const cls = rounded > 0 ? "delta-up" : "delta-down";
  return `<span class="delta ${cls}">${glyph} ${Math.abs(rounded).toFixed(1)}</span>`;
}

/**
 * The cell's background: a diverging tint around zero, blue as the score
 * climbs to 100, red as it falls below zero, and no tint at zero. One hue
 * each way with a neutral middle, so it reads for colour-blind readers too;
 * the text stays ink and the number is always printed.
 */
function scoreTint(pct) {
  const strength = Math.min(Math.abs(pct), 100) / 100;
  if (strength === 0) return "";
  const alpha = (0.08 + strength * 0.42).toFixed(2);
  return pct > 0 ? `background: rgba(59, 111, 214, ${alpha});` : `background: rgba(208, 59, 59, ${alpha});`;
}

function renderScoreCell(score, previousPct, extraClass = "") {
  if (!score) return `<td class="score ${extraClass}">–</td>`;
  const delta = previousPct == null ? "" : `<br>${renderDeltaLine(score.pct - previousPct)}`;
  return `<td class="score ${extraClass}" style="${scoreTint(score.pct)}">` +
    `<span class="pct">${formatPct(score.pct)}</span><br><span class="netof">${score.net}/${score.of}</span>${delta}</td>`;
}

function renderVerdict(verdict) {
  const slug = verdict.replaceAll(/[^a-z]+/gu, "-");
  return `<span class="badge badge-${slug}">${escapeHtml(verdict)}</span>`;
}

/**
 * What a model was asked to do, which matters more than its name: most runs
 * here are rules with a model choosing two fields from a short list, not a
 * model reading the page. A run with no model at all says so in words.
 */
function renderModelCell(experiment) {
  const role = experiment.role ?? "chooser";
  if (role === "no model") {
    return `<td class="model"><span class="tag tag-none">no model</span></td>`;
  }
  return `<td class="model"><span class="role">${escapeHtml(role)}</span>` +
    `<span class="tag">${escapeHtml(experiment.model)}</span></td>`;
}

/** Runs are only comparable when the same thing was asked of the same model. */
function chooserKey(experiment) {
  return `${experiment.role ?? "chooser"}|${experiment.model}`;
}

function renderCorpusTable(corpusKey, description, experiments, fields) {
  const rows = experiments.filter((experiment) => experiment.corpus === corpusKey);
  if (rows.length === 0) return "";

  // A change is measured against the last trusted run that asked the same
  // model: rules-only against rules-only, qwen against qwen. Comparing a
  // rules-only run with a model run would read as progress or loss where
  // only the chooser differs.
  const previousByModel = new Map(); // chooser key -> { overall: pct, fields: { name: pct } }
  const bodyRows = rows.map((experiment) => {
    const deltaEligible = DELTA_VERDICTS.has(experiment.verdict);
    const muted = MUTED_VERDICTS.has(experiment.verdict);
    const previous = previousByModel.get(chooserKey(experiment)) ?? null;
    const cells = [renderScoreCell(experiment.scores.overall, deltaEligible ? previous?.overall : null, "overall")];
    for (const field of fields) {
      const score = experiment.scores[field];
      cells.push(renderScoreCell(score, deltaEligible ? previous?.fields?.[field] : null));
    }
    if (deltaEligible) {
      previousByModel.set(chooserKey(experiment), {
        overall: experiment.scores.overall.pct,
        fields: Object.fromEntries(fields.map((field) => [field, experiment.scores[field]?.pct])),
      });
    }
    return `<tr${muted ? ' class="muted"' : ""}>
      <td class="id">${escapeHtml(experiment.id)}</td>
      <td class="date">${escapeHtml(experiment.date)}</td>
      <td class="label">${escapeHtml(experiment.label)}</td>
      ${renderModelCell(experiment)}
      <td class="verdict">${renderVerdict(experiment.verdict)}</td>
      ${cells.join("\n      ")}
    </tr>`;
  });

  const fieldHeaders = fields.map((field) => `<th>${escapeHtml(field)}</th>`).join("");
  const trusted = rows.filter((experiment) => DELTA_VERDICTS.has(experiment.verdict));
  const best = trusted.reduce((held, experiment) =>
    (held === null || experiment.scores.overall.pct > held.scores.overall.pct ? experiment : held), null);
  const bestLine = best === null
    ? ""
    : `<p class="best">Best trusted run so far: <strong>${escapeHtml(best.id)}</strong> ${escapeHtml(best.label)} — ` +
      `<strong>${formatPct(best.scores.overall.pct)}</strong> ` +
      `(${escapeHtml(best.role === "no model" ? "no model asked" : `${best.role}: ${best.model}`)})</p>`;
  return `<section class="corpus">
  <h2>${escapeHtml(description)}</h2>
  ${bestLine}
  <div class="tables">
  <table>
    <thead>
      <tr><th>ID</th><th>date</th><th>label</th><th>model</th><th>verdict</th><th class="overall">overall</th>${fieldHeaders}</tr>
    </thead>
    <tbody>
      ${bodyRows.join("\n      ")}
    </tbody>
  </table>
  </div>
</section>`;
}

/**
 * The measurements that are not scored runs: how good the short list handed
 * to a chooser is. A shortlist that does not carry the answer is a ceiling on
 * everything downstream, so it is tracked in its own right.
 */
function renderMeasurements(measurements, corpora) {
  if (!measurements || measurements.length === 0) return "";
  const blocks = measurements.map((measurement) => {
    const rows = measurement.results
      .map(([name, value]) => `<tr><td class="label">${escapeHtml(name)}</td><td class="result">${escapeHtml(value)}</td></tr>`)
      .join("\n        ");
    return `<article class="measurement">
      <h3><span class="id-badge">${escapeHtml(measurement.id)}</span> ${escapeHtml(measurement.label)}</h3>
      <p class="meta">${escapeHtml(measurement.date)} · ${escapeHtml(corpora[measurement.corpus] ?? measurement.corpus)}</p>
      <p>${escapeHtml(measurement.what)}</p>
      <table class="results">
        <tbody>
        ${rows}
        </tbody>
      </table>
      <p class="meta">How: ${escapeHtml(measurement.how)} · Written down in: ${escapeHtml(measurement.source)}</p>
    </article>`;
  });
  return `<section class="corpus">
  <h2>How good is the list we hand over? (no model asked)</h2>
  <p class="key">These are not scores. They ask a different question: when a chooser is handed a short list,
  is the right answer even on it, and how far up? A list that does not carry the answer is a ceiling no model
  can beat. This is where the provider word-run bins were measured.</p>
  ${blocks.join("\n  ")}
</section>`;
}

function renderLegend(verdicts) {
  const items = Object.entries(verdicts)
    .map(([name, description]) => `<li>${renderVerdict(name)} ${escapeHtml(description)}</li>`)
    .join("");
  return `<ul class="legend">${items}</ul>`;
}

function renderWhatWeDid(experiments) {
  const blocks = experiments.map((experiment) => {
    const rows = [
      ["What", experiment.what],
      ["How", experiment.how],
      ["Model", experiment.role === "no model" ? "none asked" : `${experiment.role}: ${experiment.model}`],
      ["Commit", experiment.commit],
      ["Output", experiment.output],
      ["Verdict", experiment.verdict],
      ["Notes", experiment.notes],
    ].filter(([, value]) => value != null && String(value).trim() !== "");

    const rowsHtml = rows
      .map(([label, value]) => `<div class="row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
      .join("\n        ");

    return `<article class="experiment">
      <h3><span class="id-badge">${escapeHtml(experiment.id)}</span> ${escapeHtml(experiment.label)} ${renderVerdict(experiment.verdict)}</h3>
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
    padding: 1rem 1.25rem 3rem;
    line-height: 1.5;
    color: #1f2328;
    background: #fcfcfb;
  }
  h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
  h1, h2, h3 { line-height: 1.25; }
  h2 { margin-top: 2.5rem; padding-left: 0.75rem; border-left: 5px solid #3b6fd6; font-size: 1.3rem; }
  p.key { color: #57606a; font-size: 0.95rem; }
  p.best { margin: 0 0 0.5rem; color: #24292f; }
  .swatch { display: inline-block; width: 0.9em; height: 0.9em; border-radius: 3px; vertical-align: -0.1em; }
  .swatch-blue { background: rgba(59, 111, 214, 0.5); }
  .swatch-red { background: rgba(208, 59, 59, 0.5); }
  .tables { overflow-x: auto; }
  table {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
    margin: 0.5rem 0 1rem;
    font-size: 0.9rem;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 8px;
    overflow: hidden;
  }
  th, td {
    border-bottom: 1px solid #e3e6ea;
    border-right: 1px solid #eef0f2;
    padding: 0.45rem 0.55rem;
    text-align: left;
    vertical-align: top;
  }
  th { background: #f0f2f5; font-weight: 600; color: #444c56; font-size: 0.8rem; letter-spacing: 0.02em; position: sticky; top: 0; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { filter: brightness(0.97); }
  td.label { min-width: 15rem; white-space: normal; font-weight: 500; }
  td.date, td.id, td.verdict { white-space: nowrap; }
  td.id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #57606a; }
  td.model { min-width: 6rem; }
  td.score { white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
  td.overall, th.overall { border-left: 3px solid #3b6fd6; border-right: 3px solid #3b6fd6; }
  td.overall .pct { font-size: 1.05rem; }
  .pct { font-weight: 700; }
  .netof { font-size: 0.72rem; color: #57606a; }
  .delta { font-size: 0.75rem; font-weight: 600; }
  .delta-up { color: #1f4fb0; }
  .delta-down { color: #b12a2a; }
  .delta-zero { color: #6e7781; font-weight: 400; }
  tr.muted td { color: #8b949e; }
  tr.muted td.score { background: #f6f8fa !important; }
  tr.muted .pct, tr.muted .netof { color: #8b949e; }
  .role { display: block; font-size: 0.7rem; color: #57606a; text-transform: lowercase; }
  .tag-none { background: #fff; color: #6e7781; border: 1px dashed #b6bec8; font-style: italic; }
  .badge-control { background: #eef1f5; color: #444c56; border-color: #d0d7de; }
  .badge-regression { background: #ffe9d9; color: #8a3a12; border-color: #f3c3a3; }
  .measurement { margin: 1rem 0; padding: 0.75rem 1rem; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; }
  .measurement h3 { margin: 0 0 0.25rem; font-size: 1.05rem; }
  .measurement p { margin: 0.3rem 0; }
  .measurement .meta { font-size: 0.82rem; color: #57606a; }
  table.results { width: auto; min-width: 32rem; margin: 0.5rem 0; }
  table.results td.result { font-weight: 600; white-space: normal; }
  table.results td.label { font-weight: 400; }
  .tag { display: inline-block; padding: 0 0.4rem; border-radius: 4px; background: #eef1f5; color: #24292f; font-size: 0.8rem; white-space: nowrap; }
  .badge {
    display: inline-block; padding: 0.05rem 0.5rem; border-radius: 999px;
    font-size: 0.78rem; font-weight: 600; white-space: nowrap; border: 1px solid transparent;
  }
  .badge-kept { background: #dbe7fb; color: #1f4fb0; border-color: #b7cbf2; }
  .badge-baseline { background: #eef1f5; color: #444c56; border-color: #d0d7de; }
  .badge-set-aside { background: #fff; color: #57606a; border-color: #b6bec8; }
  .badge-broken-run { background: #fbe4e4; color: #9a1f1f; border-color: #f0b8b8; }
  .badge-unexplained { background: #fff2cf; color: #7a4d00; border-color: #f2d58a; }
  ul.legend { padding-left: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 0.4rem 1.5rem; margin: 0.5rem 0 1rem; }
  ul.legend li { font-size: 0.9rem; color: #57606a; }
  .experiment {
    margin: 1rem 0; padding: 0.75rem 1rem; background: #fff;
    border: 1px solid #d0d7de; border-radius: 8px;
  }
  .experiment h3 { margin: 0 0 0.5rem; font-size: 1.05rem; }
  .id-badge { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #24292f; color: #fff; padding: 0 0.4rem; border-radius: 4px; font-size: 0.85rem; }
  .experiment dl { margin: 0; }
  .experiment .row { display: flex; gap: 0.75rem; margin: 0.2rem 0; }
  .experiment dt { flex: 0 0 5rem; font-weight: 600; color: #57606a; font-size: 0.85rem; padding-top: 0.1rem; }
  .experiment dd { margin: 0; }
  @media (max-width: 40rem) {
    body { padding: 0.75rem; }
    table { font-size: 0.8rem; }
    .experiment .row { flex-direction: column; gap: 0; }
    .experiment dt { flex-basis: auto; }
  }
`;

/** Renders the full one-page microsite HTML for a register object. */
export function renderHtml(register) {
  const { title, scoring, fields, corpora, verdicts, experiments, measurements } = register;

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
  <p class="key">A cell's colour is its score: <span class="swatch swatch-blue"></span> deeper blue as it climbs towards 100%, <span class="swatch swatch-red"></span> red where wrong answers outnumber right ones, no colour at zero. The small ▲ and ▼ figures are the change in points since the last trusted run in the same table that asked the same thing of the same model. Greyed rows are runs whose numbers are not trusted; they carry no change.</p>
  <p class="key">The <strong>model</strong> column says what the model was asked to do, because in most runs it was not reading the page: <em>chooser</em> means the rules did the work and the model only picked one entry off a short list for a field or two; <em>whole page</em> means the model read the document and wrote every field itself; <em>no model</em> means nothing was asked of any model. Every run marked <em>control</em> is the same code with the chooser switched off, so the gap to the row above it is what the model itself was worth.</p>
  ${renderLegend(verdicts)}
  ${corpusSections}
  ${renderMeasurements(measurements, corpora)}
  <h2>What we did, run by run</h2>
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
  const role = flags.role ?? (model === "—" ? "no model" : "chooser");
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
    role,
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
