import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { composeUpCalls, makeFixture, repoDir, runRepair, runRepairBetweenPlanAndExecute, scratchDir, treeSnapshot } from "./repair-test-harness.mjs";

// #1848 O-F2 (restore start hint defers to restore.sh --finish), O-F6 (the
// "never lists it" sentence is wrong) and O-F10 (--execute --dangerous says
// on stderr that it did not run retire-smtp-lines). Written from the specs alone.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const STOPPED = { db: "stopped", app: "stopped" };
const RUNNING = { db: "running", app: "running" };
const IMPORTED = { ...RUNNING, mailStatus: "mail-sending source=imported imported-from-environment=true" };
const MACHINE = { env: { ORBIT_REPAIR_PROMPTS: "machine" }, input: "y\n" };
const JOURNAL_TAIL = join(".orbit-restore", "restore.journal");
const journalOf = (targetDir) => join(targetDir, "backups", ".orbit-restore", "restore.journal");
const read = (path) => readFileSync(join(repoDir, path), "utf8");
const flat = (text) => text.replace(/\s+/gu, " ");

function plantJournal(targetDir) {
  mkdirSync(join(targetDir, "backups", ".orbit-restore"), { recursive: true });
  writeFileSync(journalOf(targetDir), '{"step":"half-done"}\n');
}

// The second manual-step line (print_restore_start_hint): it names the journal; the guidance line does not.
const hintLines = (stderr) => stderr.split("\n").filter((line) => line.startsWith("manual step:") && line.includes("restore.journal") && !line.includes("a restore has not been finished"));

describe("#1848 O-F2: the restore start hint defers to restore.sh --finish", () => {
  // --check prints no manual steps; the hint is printed once per manual item (restore-unfinished, services-not-running).
  it("--plan prints the hint for both callers: --finish first, start Orbit only if --finish asks, journal path, resolves unchanged", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    const result = runRepair(targetDir, ["--plan"], STOPPED);
    const hints = hintLines(result.stderr);
    expect(hints).toHaveLength(2);
    expect(hints.map((line) => /\(resolves=([a-z-]+)\)$/u.exec(line)?.[1]).sort()).toEqual(["restore-unfinished", "services-not-running"]);
    for (const hint of hints) {
      expect(hint).toContain("restore.sh --finish");
      expect(hint).toContain(journalOf(targetDir));
      expect(hint).toMatch(/only if|if (the )?(`|')?(bash scripts\/restore\.sh )?--finish (asks|says|tells)/iu);
      const up = hint.indexOf("docker compose up -d");
      if (up >= 0) expect(hint.indexOf("restore.sh --finish")).toBeLessThan(up);
      expect(hint).not.toContain("to start Orbit for restore.sh --finish");
    }
  });

  it("no output of an unfinished-restore run has an unconditional instruction to start Orbit", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    for (const args of [["--plan"]]) {
      const result = runRepair(targetDir, args, STOPPED);
      const startLines = `${result.stdout}\n${result.stderr}`.split("\n").filter((line) => line.includes("up -d"));
      expect(startLines.length).toBeGreaterThan(0);
      for (const line of startLines) expect(line, line).toMatch(/only if|if (the )?(`|')?(bash scripts\/restore\.sh )?--finish/iu);
    }
  });

  it("the restore-unfinished guidance puts --finish and --recover first and drops 'once Orbit is healthy'", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    const result = runRepair(targetDir, ["--plan"], STOPPED);
    const guidance = result.stderr.split("\n").filter((line) => line.includes("a restore has not been finished and keeps Orbit stopped"));
    expect(guidance.length).toBeGreaterThan(0);
    for (const line of guidance) {
      expect(line).toContain("restore.sh --finish");
      expect(line).toContain("--recover");
      expect(line).not.toContain("once Orbit is healthy");
    }
    expect(result.stderr).not.toContain("once Orbit is healthy");
  });

  it("the start-services refusal for an unfinished restore names --finish and --recover and drops 'once Orbit is healthy'", async () => {
    const targetDir = makeFixture();
    const result = await runRepairBetweenPlanAndExecute(targetDir, ["--execute", "--safe-only"], STOPPED, () => plantJournal(targetDir));
    expect(result.status).toBe(4);
    const refusal = result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair: start-services refused, nothing was changed: a restore has not been finished"));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain("--finish");
    expect(refusal[0]).toContain("--recover");
    expect(refusal[0]).toContain(JOURNAL_TAIL);
    expect(refusal[0]).not.toContain("once Orbit is healthy");
    expect(composeUpCalls(result)).toEqual([]);
  });

  it("the recreate-services refusal says the same", async () => {
    const targetDir = makeFixture();
    const scratch = scratchDir();
    writeFileSync(join(scratch, "labels"), `${join(scratch, "old-orbit-folder")}\n`);
    const result = await runRepairBetweenPlanAndExecute(targetDir, ["--execute", "--safe-only"], { ...RUNNING, docker: { workingDirLabelsPath: join(scratch, "labels") } }, () => plantJournal(targetDir));
    expect(result.status).toBe(4);
    const refusal = result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair: recreate-services refused, nothing was changed: a restore has not been finished"));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain("--finish");
    expect(refusal[0]).toContain("--recover");
    expect(refusal[0]).not.toContain("once Orbit is healthy");
  });

  it("an unreadable journal (mode 000) gives the same hint and findings as a readable one: repair does not read it", () => {
    const run = (unreadable) => {
      const targetDir = makeFixture();
      plantJournal(targetDir);
      if (unreadable) chmodSync(journalOf(targetDir), 0o000);
      try {
        const result = runRepair(targetDir, ["--plan"], STOPPED);
        const normalise = (text) => text.split(targetDir).join("<T>");
        return { hints: hintLines(normalise(result.stderr)), stdout: normalise(result.stdout), status: result.status };
      } finally {
        chmodSync(journalOf(targetDir), 0o600);
      }
    };
    const readable = run(false);
    const locked = run(true);
    expect(readable.hints).toHaveLength(2);
    expect(locked).toEqual(readable);
  });

  it.skipIf(process.getuid?.() === 0)("with an unsearchable backups folder the start hint is still absent", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    chmodSync(join(targetDir, "backups"), 0o000);
    try {
      const result = runRepair(targetDir, ["--plan"], STOPPED);
      expect(hintLines(result.stderr)).toEqual([]);
      expect(result.stderr).not.toContain("to start Orbit");
      expect(result.stderr).not.toContain("docker compose up -d");
    } finally {
      chmodSync(join(targetDir, "backups"), 0o700);
    }
  });

  it("the finding class, exit code and no-start behaviour are unchanged", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    const before = treeSnapshot(targetDir);
    expect(runRepair(targetDir, ["--check"], STOPPED).stdout).toContain("finding class=restore-unfinished target=restore severity=warn");
    const plan = runRepair(targetDir, ["--plan"], STOPPED);
    expect(plan.stdout).toContain("plan action=manual resolves=services-not-running");
    expect(composeUpCalls(plan)).toEqual([]);
    expect(treeSnapshot(targetDir)).toBe(before);
    const executed = runRepair(targetDir, ["--execute", "--safe-only"], STOPPED);
    expect(composeUpCalls(executed)).toEqual([]);
  });
});

/** A healthy fixture with the old SMTP lines, the overlay entry and the secret. */
function withMail() {
  const targetDir = makeFixture();
  appendFileSync(join(targetDir, ".env-orbit"), "COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml\nSMTP_HOST=smtp.example.test\nSMTP_PORT=587\nSMTP_SECURITY=starttls\nSMTP_USER=orbit@example.test\nSMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password\nSMTP_FROM=Orbit <orbit@example.test>\n");
  chmodSync(join(targetDir, ".env-orbit"), 0o600);
  writeFileSync(join(targetDir, "docker-compose.mail.yml"), "services:\n  orbit-app:\n    secrets:\n      - orbit-smtp-password\n");
  writeFileSync(join(targetDir, ".orbit-secrets", "smtp-password"), "TEST-NOT-A-REAL-PASSWORD");
  chmodSync(join(targetDir, ".orbit-secrets", "smtp-password"), 0o600);
  return targetDir;
}

const PLANNED_LINE = "Orbit repair: retire-smtp-lines was planned but runs only in the safe batch; this run did not run it. Run repair.sh --execute --safe-only to retire the SMTP lines.";
const planLines = (stdout) => stdout.split("\n").filter((line) => line.startsWith("plan action=retire-smtp-lines resolves=smtp-lines-retirable"));
const countOf = (stderr, line) => stderr.split("\n").filter((entry) => entry === line).length;

describe("#1848 O-F10: --execute --dangerous says it did not run retire-smtp-lines", () => {
  it("with the finding: one exact stderr line; stdout, tree and compose unchanged", () => {
    const targetDir = withMail();
    const before = treeSnapshot(targetDir);
    const result = runRepair(targetDir, ["--execute", "--dangerous"], { ...IMPORTED, ...MACHINE });
    expect(countOf(result.stderr, PLANNED_LINE)).toBe(1);
    expect(result.stdout).not.toContain("retire-smtp-lines");
    expect(treeSnapshot(targetDir)).toBe(before);
    expect(composeUpCalls(result)).toEqual([]);
  });

  it("the new line comes after the execution lines and before the final re-diagnosis (one interleaved capture)", () => {
    const targetDir = withMail();
    const result = runRepair(targetDir, ["--execute", "--dangerous"], { ...IMPORTED, ...MACHINE, interleave: true });
    const lines = result.stdout.split("\n");
    const at = lines.indexOf(PLANNED_LINE);
    expect(at, "the planned line is in the output").toBeGreaterThan(-1);
    const lastIndexWhere = (test) => lines.reduce((found, line, index) => (test(line) ? index : found), -1);
    const lastDiagnosis = lastIndexWhere((line) => line.startsWith("diagnosis "));
    const execution = lastIndexWhere((line) => line.startsWith("execution ") || line.startsWith("dangerous "));
    expect(lastDiagnosis, "a final diagnosis line").toBeGreaterThan(-1);
    expect(execution, "an execution line").toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(execution);
    expect(at).toBeLessThan(lastDiagnosis);
  });

  it("the exit code is the one this run already gave (pinned)", () => {
    const targetDir = withMail();
    const result = runRepair(targetDir, ["--execute", "--dangerous"], { ...IMPORTED, ...MACHINE });
    expect(result.status).toBe(EXIT_DANGEROUS_WITH_FINDING);
  });

  it("without the finding (source=none, or nothing left to retire): no new line", () => {
    for (const [label, targetDir, options] of [
      ["source=none", withMail(), { ...RUNNING, mailStatus: "mail-sending source=none imported-from-environment=false" }],
      ["nothing to retire", makeFixture(), IMPORTED],
    ]) {
      const result = runRepair(targetDir, ["--execute", "--dangerous"], { ...options, ...MACHINE });
      expect(result.stderr, label).not.toContain("retire-smtp-lines was planned");
      expect(result.stdout, label).not.toContain("retire-smtp-lines");
    }
  });

  for (const args of [["--execute", "--safe-only"], ["--execute", "--safe-only", "--dangerous"]]) {
    it(`${args.join(" ")} with the finding: the line is absent and the action runs as today`, () => {
      const targetDir = withMail();
      const result = runRepair(targetDir, args, { ...IMPORTED, ...MACHINE });
      expect(result.stderr).not.toContain("retire-smtp-lines was planned");
      expect(result.stdout).toContain("execute action=retire-smtp-lines resolves=smtp-lines-retirable result=done");
    });
  }

  it("--plan and --check never print the new line", () => {
    const targetDir = withMail();
    for (const args of [["--plan"], ["--check"]]) {
      expect(runRepair(targetDir, args, IMPORTED).stderr).not.toContain("retire-smtp-lines was planned");
    }
  });

  it("the --plan stderr notice adds that it runs only with --execute --safe-only", () => {
    const targetDir = withMail();
    const result = runRepair(targetDir, ["--plan"], IMPORTED);
    const notice = result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair: retire-smtp-lines deletes the SMTP password file"));
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain("that secret cannot be rolled back");
    expect(notice[0]).toContain("; it runs only with `--execute --safe-only`");
  });
});

// Observed before the change; the spec leaves the exit code alone.
const EXIT_DANGEROUS_WITH_FINDING = 0;

describe("#1848 O-F6: --plan and the export list retire-smtp-lines; only --execute --safe-only runs it", () => {
  it("--plan prints exactly one plan line for the finding (unchanged)", () => {
    const targetDir = withMail();
    const result = runRepair(targetDir, ["--plan"], IMPORTED);
    expect(planLines(result.stdout)).toHaveLength(1);
    expect(result.status).toBe(3);
  });

  it("--export-diagnostics output contains the same plan line", () => {
    const targetDir = withMail();
    const plan = planLines(runRepair(targetDir, ["--plan"], IMPORTED).stdout);
    const exported = runRepair(targetDir, ["--export-diagnostics"], { ...IMPORTED, env: { ORBIT_REPAIR_PROMPTS: "machine" }, input: "n\n" });
    expect(planLines(exported.stdout)).toEqual(plan);
  });

  const wrong = [/without\s+`?--safe-only`?\s+(neither runs nor lists|never lists)/iu, /never lists it/iu, /neither runs nor lists/iu];
  const meaning = (text) => {
    const said = flat(text);
    expect(said).toContain("--plan");
    expect(said).toContain("--export-diagnostics");
    expect(said).toContain("--execute --safe-only");
    expect(said).toMatch(/only (a run|`?--execute --safe-only`?)|runs only/iu);
  };

  it("the repair.sh header no longer says a run without --safe-only never lists it, and says what the code does", () => {
    const script = read("scripts/repair.sh");
    const start = script.indexOf("retire-smtp-lines            <- smtp-lines-retirable");
    expect(start).toBeGreaterThan(0);
    const block = script.slice(start, start + 2500).replace(/^#\s?/gmu, "");
    for (const pattern of wrong) expect(flat(block)).not.toMatch(pattern);
    expect(flat(block)).toContain("owner decision 1");
    meaning(block);
  });

  it("docs/engine-events.md no longer says it, and says what the code does", () => {
    const doc = read("docs/engine-events.md");
    const start = doc.indexOf("`retire-smtp-lines` (#1817) resolves");
    expect(start).toBeGreaterThan(0);
    const paragraph = doc.slice(start, doc.indexOf("\n\n", start));
    for (const pattern of wrong) expect(flat(paragraph)).not.toMatch(pattern);
    meaning(paragraph);
  });

  it("installer guarantee 59 no longer says it, and says what the code does", () => {
    const doc = read("docs/installer-guarantees.md");
    const line = doc.split("\n").find((entry) => entry.startsWith("59. `smtp-lines-retirable`"));
    expect(line).toBeDefined();
    for (const pattern of wrong) expect(flat(line)).not.toMatch(pattern);
    meaning(line);
  });
});
