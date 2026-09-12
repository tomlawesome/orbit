import assert from "node:assert/strict";
import { test } from "node:test";

import { findScoreLine, parseScoreLine, renderHtml } from "./experiment-log.mjs";

const SAMPLE_LINE =
  "sieve+tag+choose+model: 80.8% (156/193) [provider 75.0% (18/24), reference 79.2% (19/24), " +
  "dates 88.6% (31/35), dateRoles 88.6% (31/35), subtype 91.7% (22/24), cost 63.2% (12/19), " +
  "scheduleKind 100.0% (18/18), recurrence 35.7% (5/14)]";

const NEGATIVE_LINE =
  "sieve+tag+choose+model: -17.6% (-34/193) [provider -66.7% (-16/24), reference 16.7% (4/24), " +
  "dates -57.1% (-20/35), dateRoles -85.7% (-30/35), subtype 87.5% (21/24), cost -57.9% (-11/19), " +
  "scheduleKind 77.8% (14/18), recurrence 28.6% (4/14)]";

test("parseScoreLine parses a positive score line", () => {
  const { route, scores } = parseScoreLine(SAMPLE_LINE);
  assert.equal(route, "sieve+tag+choose+model");
  assert.deepEqual(scores.overall, { pct: 80.8, net: 156, of: 193 });
  assert.deepEqual(scores.provider, { pct: 75.0, net: 18, of: 24 });
  assert.deepEqual(scores.recurrence, { pct: 35.7, net: 5, of: 14 });
});

test("parseScoreLine parses negative percentages and nets", () => {
  const { route, scores } = parseScoreLine(NEGATIVE_LINE);
  assert.equal(route, "sieve+tag+choose+model");
  assert.deepEqual(scores.overall, { pct: -17.6, net: -34, of: 193 });
  assert.deepEqual(scores.provider, { pct: -66.7, net: -16, of: 24 });
  assert.deepEqual(scores.dateRoles, { pct: -85.7, net: -30, of: 35 });
});

test("parseScoreLine rejects a line it cannot parse", () => {
  assert.throws(() => parseScoreLine("not a score line at all"), /Could not parse/);
});

test("findScoreLine strips an optional leading hold-out label", () => {
  const content = [
    "some other line",
    "hold-out: sieve+tag+choose+model: 40.4% (44/109) [provider -41.7% (-5/12)]",
    "another line",
  ].join("\n");
  const line = findScoreLine(content, "sieve+tag+choose+model");
  assert.equal(line, "sieve+tag+choose+model: 40.4% (44/109) [provider -41.7% (-5/12)]");
});

test("findScoreLine returns null when no line matches", () => {
  assert.equal(findScoreLine("nothing here\n", "sieve+tag+choose+model"), null);
});

function tinyRegister() {
  return {
    title: "Tiny test register",
    scoring: "Points scored, briefly.",
    fields: ["provider", "dates"],
    corpora: {
      "tuning-24": "The tuning pages",
    },
    verdicts: {
      baseline: "A point of reference",
      kept: "The change stayed",
    },
    experiments: [
      {
        id: "T01",
        date: "2026-01-01",
        label: "First run",
        corpus: "tuning-24",
        model: "test-model",
        route: "test-route",
        what: "Did a thing.",
        how: "Ran a script.",
        commit: "abc1234",
        output: "tmp/t01.out",
        scores: {
          overall: { pct: 50.0, net: 10, of: 20 },
          provider: { pct: 40.0, net: 4, of: 10 },
          dates: { pct: 60.0, net: 6, of: 10 },
        },
        verdict: "baseline",
        notes: "",
      },
      {
        id: "T02",
        date: "2026-01-02",
        label: "Second run",
        corpus: "tuning-24",
        model: "test-model",
        route: "test-route-2",
        what: "Did another thing.",
        how: "Ran a different script.",
        commit: "def5678",
        output: "tmp/t02.out",
        scores: {
          overall: { pct: 70.0, net: 14, of: 20 },
          provider: { pct: 60.0, net: 6, of: 10 },
          dates: { pct: 80.0, net: 8, of: 10 },
        },
        verdict: "kept",
        notes: "Improved things.",
      },
    ],
  };
}

test("renderHtml includes every experiment id and a delta against the previous kept/baseline row", () => {
  const html = renderHtml(tinyRegister());
  assert.match(html, /T01/);
  assert.match(html, /T02/);
  assert.match(html, /Tiny test register/);
  // T02's overall pct (70.0) is 20.0 points above T01's (50.0).
  assert.match(html, /delta-up">\+20\.0</);
});

test("renderHtml mutes rows whose verdict is not kept or baseline", () => {
  const register = tinyRegister();
  register.experiments.push({
    id: "T03",
    date: "2026-01-03",
    label: "Broken run",
    corpus: "tuning-24",
    model: "test-model",
    route: "test-route-3",
    what: "Something went wrong.",
    how: "Ran it anyway.",
    commit: "9999999",
    output: "tmp/t03.out",
    scores: {
      overall: { pct: 0.0, net: 0, of: 20 },
      provider: { pct: 0.0, net: 0, of: 10 },
      dates: { pct: 0.0, net: 0, of: 10 },
    },
    verdict: "broken run",
    notes: "",
  });
  const html = renderHtml(register);
  assert.match(html, /class="muted"[\s\S]*T03/);
});
