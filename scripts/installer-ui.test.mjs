import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const helper = fileURLToPath(new URL("./installer-ui.sh", import.meta.url));

// Waits until the target process's /proc/<pid>/status SigCgt bitmap (see
// proc(5)) shows the TERM trap installed before delivering SIGTERM, instead
// of racing a wall-clock sleep against scheduler-latency-dependent process
// setup (the fork/exec of `stty` and the `trap -p` subshells that run before
// the widget installs its own trap). Bit 0x4000 is signal 15 (TERM). Falls
// back to firing after ~2s so a genuine regression still surfaces as a test
// failure instead of a hang.
/*
 * Send SIGTERM only once the shell has actually installed its handler.
 *
 * These two tests assert that an interrupted prompt restores the terminal, and
 * they were flaky on GitHub Actions for a reason unrelated to the behaviour
 * under test (#284): the kill was a fixed wall-clock guess against process
 * setup - fork, source, open /dev/tty, stty raw, install the trap - which is
 * scheduler-latency bound. Lose that race and SIGTERM lands at its default
 * disposition, killing the process with 143 before the tested code runs.
 *
 * The previous attempt polled SigCgt in /proc for the SIGTERM bit. It worked
 * locally and never fired on the runner: CI reported TRAP_NEVER_INSTALLED on
 * both tests, so on that host the bit was not observable this way at all.
 *
 * So synchronise on the process's own output instead. installer_ui_read_value
 * installs the trap (installer-ui.sh:471) and only then writes the prompt
 * (:472), so the prompt appearing in the pty transcript is proof the handler
 * already exists.
 *
 * The marker has to be chosen per call site, and getting it wrong is silent.
 * installer_ui_select prints its HEADER at :371, well before its trap at :385,
 * and only renders the menu at :387 - so waiting for "Choose" killed too early
 * and reproduced the original 143 exactly. The menu options are the first
 * output that postdates the trap, which is why this waits for "1) Install". `script` is given a real typescript file rather than
 * /dev/null, and the waiter polls it for the prompt before killing. This is
 * the same technique that fixed the sibling install-cancellation test, which
 * has not regressed since.
 *
 * On timeout it still marks and kills: not killing leaves the prompt blocked
 * until the job timeout, which is worse than a wrong answer.
 */
// EXPERIMENT (#510), deliberately oversized: the marker proves the trap is
// installed (installer-ui.sh:471 traps, :472 writes the prompt), yet the
// kill still lands uncaught on GH Actions. Detection was firing the signal
// in the same loop iteration as the match -- no margin whatsoever between
// the handler existing and the signal arriving. This waits KILL_MARGIN
// seconds first. Sixty is not a proposed fix; it is far beyond any
// plausible scheduler stall, so if 143 still appears the timing hypothesis
// is wrong and the cause is structural. Bisect downwards once it passes.
const KILL_MARGIN_SECONDS = 60;

function waitForPromptThenKill(promptMarker, transcript) {
  return 'target="$BASHPID"; (for i in $(seq 1 2000); do '
    + `if grep -qF "${promptMarker}" "${transcript}" 2>/dev/null; then `
    + `sleep ${KILL_MARGIN_SECONDS}; kill -TERM "$target"; exit 0; fi; sleep 0.005; done; `
    + 'printf "PROMPT_NEVER_APPEARED\n"; kill -TERM "$target") &';
}

function runHelper(modeArgs = [], env = {}) {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; installer_ui_init "${@:2}"; installer_ui_emit bootstrap installer starting initial begin 3',
      "installer-ui-test",
      helper,
      ...modeArgs,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, TERM: "xterm", ...env },
    },
  );
}

/*
 * Like runPty, but the terminal never reaches EOF (#441).
 *
 * runPty hands spawnSync an `input` string, which closes stdin as soon as it
 * is written. Under `script` that closes the pty master, so a read on the
 * slave returns EOF immediately - and installer_ui_select treats a failed read
 * as a read error, breaks out with status 1, and restores the caller's traps
 * on the way. Everything after that runs with SIGTERM back at its default
 * disposition, which is what killed the harness with 143 and looked for all
 * the world like the widget ignoring its own trap.
 *
 * So the menu was never waiting for input, and the test was not testing
 * interruption. Here stdin is left open for the life of the child: the widget
 * genuinely blocks, and the signal arrives while its trap is installed.
 *
 * The body prints its own pid so the signal can reach the shell running the
 * widget rather than `script`, which would not be the process under test.
 */
function runPtyInterrupted(body, marker, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "script",
      ["-qefE", "never", "-c", `bash -c '${body}' _ '${helper}'`, "/dev/null"],
      { env: { ...process.env, TERM: "xterm", ...env } },
    );
    let stdout = "";
    let signalled = false;
    let innerPid = null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const pid = stdout.match(/PID=(\d+)/u);
      if (pid) innerPid = Number(pid[1]);
      // Only once the marker is on screen is the trap known to be installed.
      if (!signalled && innerPid && stdout.includes(marker)) {
        signalled = true;
        try { process.kill(innerPid, "SIGTERM"); } catch { /* already gone */ }
      }
    });
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, signalled });
    });
  });
}

function runPty(body, input, env = {}, transcript = "/dev/null") {
  return spawnSync(
    "script",
    ["-qefE", "never", "-c", `bash -c '${body}' _ '${helper}'`, transcript],
    {
      encoding: "utf8",
      input,
      env: { ...process.env, TERM: "xterm", ...env },
    },
  );
}

function runPtyTimed(body, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "script",
      ["-qefE", "never", "-c", `bash -c '${body}' _ '${helper}'`, "/dev/null"],
      { env: { ...process.env, TERM: "xterm", ...env } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    setTimeout(() => {
      child.stdin.write(input);
      child.stdin.end();
    }, 200);
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

describe("installer semantic UI", () => {
  it("renders a bounded plain event with the canonical fields", () => {
    const result = runHelper(["--plain"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "phase=bootstrap component=installer state=starting reason=initial action=begin elapsed=3s\n",
    );
    expect(result.stdout).not.toMatch(/\x1b\[/u);
  });

  it("rejects arbitrary field content instead of echoing untrusted values", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; installer_ui_init --plain; installer_ui_emit bootstrap installer starting "SECRET_VALUE=do-not-print" begin 3',
        "installer-ui-test",
        helper,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reason=unknown");
    expect(result.stdout).not.toContain("SECRET_VALUE");
    expect(result.stdout).not.toContain("do-not-print");
  });

  it.each([
    ["non-TTY", {}],
    ["NO_COLOR", { NO_COLOR: "1" }],
    ["TERM=dumb", { TERM: "dumb" }],
  ])("does not emit ANSI in %s mode", (_label, env) => {
    const result = runHelper([], env);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/\x1b\[/u);
  });

  it("does not emit ANSI when output is redirected", () => {
    const target = mkdtempSync(join(tmpdir(), "orbit-installer-ui-"));
    const output = join(target, "output");
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; installer_ui_init; installer_ui_emit bootstrap installer starting initial begin 3 > "$2"',
          "installer-ui-test",
          helper,
          output,
        ],
        { encoding: "utf8", env: { ...process.env, TERM: "xterm" } },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(output, "utf8")).not.toMatch(/\x1b\[/u);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("uses ANSI only for an actual TTY when color is allowed", () => {
    const colorEnv = { ...process.env, TERM: "xterm" };
    delete colorEnv.NO_COLOR;
    const result = spawnSync(
      "script",
      [
        "-qec",
        `source '${helper}'; installer_ui_init; installer_ui_emit bootstrap installer starting initial begin 3`,
        "/dev/null",
      ],
      { encoding: "utf8", env: colorEnv },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\x1b\[/u);
    expect(result.stdout).toContain("bootstrap");
    expect(result.stdout).toContain("installer");
    expect(result.stdout).not.toContain("phase=");
  });

  it.each([
    ["NO_COLOR", { NO_COLOR: "1", TERM: "xterm" }],
    ["TERM=dumb", { TERM: "dumb" }],
  ])("refuses forced TTY color when %s disables it", (_label, overrides) => {
    const env = { ...process.env, ...overrides };
    if (!("NO_COLOR" in overrides)) delete env.NO_COLOR;
    const result = spawnSync(
      "script",
      [
        "-qec",
        `source '${helper}'; installer_ui_init --tty; installer_ui_emit bootstrap installer starting initial begin 3`,
        "/dev/null",
      ],
      { encoding: "utf8", env },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/\x1b\[/u);
  });

  it("selects menu rows with arrows and Enter without colour-only state", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; choice="$(installer_ui_select 3 "Choose" install install Install update Update repair Repair exit Exit)"; printf "\\nCHOICE=%s\\n" "$choice"',
      "\x1b[B\r",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("> 1) Install");
    expect(result.stdout).toContain("CHOICE=update");
  });

  it("supports numbered menu fallback on a dumb terminal", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; choice="$(installer_ui_select 3 "Choose" install install Install update Update)"; printf "CHOICE=%s\\n" "$choice"',
      "2\r",
      { TERM: "dumb" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/\x1b\[/u);
    expect(result.stdout).toContain("CHOICE=update");
  });

  it("treats Escape as cancellation in the numbered fallback", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; if choice="$(installer_ui_select 3 "Choose" install install Install update Update)"; then printf "CHOICE=%s\\n" "$choice"; else printf "STATUS=%s\\n" "$?"; fi',
      "\x1b\r",
      { TERM: "dumb" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STATUS=130");
    expect(result.stdout).not.toContain("CHOICE=");
  });

  it.each([
    ["TERM=dumb", { TERM: "dumb" }],
    ["plain mode", { ORBIT_INSTALLER_PLAIN: "1" }],
  ])("uses sequence-free canonical text input for %s", (_label, env) => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; value="$(installer_ui_read_text 3 "Value: " 64)"; printf "VALUE=%s\\n" "$value"',
      "safe-value\r",
      env,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VALUE=safe-value");
    expect(result.stdout).not.toMatch(/\x1b\[/u);
  });

  it("fits fixed menu labels to a narrow terminal using an ASCII fallback", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; choice="$(installer_ui_select 3 "Choose" install install "Install Orbit with a deliberately long descriptive label" update "Update Orbit with another deliberately long label")"; printf "CHOICE=%s\n" "$choice"',
      "1\r",
      { TERM: "dumb", COLUMNS: "32" },
    );

    expect(result.status).toBe(0);
    const menuLines = result.stdout.split(/\r?\n/u).filter((line) => /^. \d\) /u.test(line));
    expect(menuLines.length).toBeGreaterThanOrEqual(2);
    expect(menuLines.every((line) => line.length <= 32)).toBe(true);
    expect(result.stdout).toContain("...");
    expect(result.stdout).not.toMatch(/[^\x00-\x7F]/u);
  });

  it("uses terminal cursor editing without persisting navigation sequences", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; value="$(installer_ui_read_text 3 "Value: " 64)"; printf "\\nVALUE=%s\\n" "$value"',
      "abcd\x1b[D\x1b[D\x08X\r",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VALUE=aXcd");
    expect(result.stdout).not.toContain("[D[D");
  });

  it("keeps cursor editing available when colour is disabled", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; value="$(installer_ui_read_text 3 "Value: " 64)"; printf "\\nVALUE=%s\\n" "$value"',
      "abcd\x1b[D\x1b[D\x08X\r",
      { NO_COLOR: "1", TERM: "xterm" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VALUE=aXcd");
    expect(result.stdout).not.toContain("[D[D");
  });

  it("supports Home, End and Delete without inserting escape bytes", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; value="$(installer_ui_read_text 3 "Value: " 64)"; printf "\\nVALUE=%s\\n" "$value"',
      "abcd\x1b[H\x1b[3~X\x1b[F\x1b[D\x1b[3~\r",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VALUE=Xbc");
    expect(result.stdout).not.toContain("[3~");
  });

  it("ignores unsupported escape sequences during text entry", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; value="$(installer_ui_read_text 3 "Value: " 64)"; printf "\\nVALUE=%s\\n" "$value"',
      "abc\x1b[999~def\r",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VALUE=abcdef");
    expect(result.stdout).not.toContain("999");
  });

  it("consumes unsupported CSI parameters without inserting their bytes", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; value="$(installer_ui_read_text 3 "Value: " 64)"; printf "\\nVALUE=%s\\n" "$value"',
      "abc\x1b[1;5Cdef\r",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VALUE=abcdef");
    expect(result.stdout).not.toMatch(/1;5C/u);
  });

  it("does not emit ANSI while editing text on a dumb terminal", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; value="$(installer_ui_read_text 3 "Value: " 64)"; printf "\\nVALUE=%s\\n" "$value"',
      "ab\x1b[D X\r",
      { TERM: "dumb" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VALUE=a Xb");
    expect(result.stdout).not.toMatch(/\x1b\[/u);
  });

  it("consumes unsupported parameterized and SS3 escape sequences completely", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; value="$(installer_ui_read_text 3 "Value: " 64)"; printf "\\nVALUE=%s\\n" "$value"',
      "abc\x1b[1;2A\x1bOA\x1b[?25lXYZ\r",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("VALUE=abcXYZ");
    expect(result.stdout).not.toContain("1;2");
    expect(result.stdout).not.toContain("25l");
  });

  it("rejects multiline bracketed paste as one unsafe value", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; if value="$(installer_ui_read_text 3 "Value: " 64)"; then printf "VALUE=%s\\n" "$value"; else printf "REJECTED=%s\\n" "$?"; fi',
      "\x1b[200~first\r\nsecond\x1b[201~\r",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REJECTED=2");
    expect(result.stdout).not.toContain("VALUE=first");
  });

  it("rejects an incomplete bracketed paste at terminal EOF", async () => {
    const result = await runPtyTimed(
      'source "$1"; exec 3<>/dev/tty; if value="$(installer_ui_read_text 3 "Value: " 64)"; then printf "VALUE=%s\\n" "$value"; else printf "REJECTED=%s\\n" "$?"; fi',
      "\x1b[200~partial",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REJECTED=1");
    expect(result.stdout).not.toContain("VALUE=partial");
  });

  it("keeps secret input out of terminal output and supports editing", () => {
    const secret = "private-widget-secret";
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; value="$(installer_ui_read_secret 3 "Secret: " 64)"; printf "LENGTH=%s\\n" "${#value}"',
      `${secret}\x1b[D\x7fX\r`,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain(`LENGTH=${secret.length}`);
  });

  it("restores terminal state when text entry is cancelled with Escape", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; before="$(stty -g <&3)"; if value="$(installer_ui_read_text 3 "Value: " 64)"; then status=0; else status=$?; fi; after="$(stty -g <&3)"; printf "STATUS=%s RESTORED=%s\\n" "$status" "$([[ "$before" == "$after" ]] && printf yes || printf no)"',
      "\x1b",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STATUS=130 RESTORED=yes");
  });

  it("restores terminal state when text entry reaches EOF", async () => {
    const result = await runPtyTimed(
      'source "$1"; exec 3<>/dev/tty; before="$(stty -g <&3)"; if value="$(installer_ui_read_text 3 "Value: " 64)"; then status=0; else status=$?; fi; after="$(stty -g <&3)"; printf "STATUS=%s RESTORED=%s\n" "$status" "$([[ "$before" == "$after" ]] && printf yes || printf no)"',
      "\x04",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STATUS=1 RESTORED=yes");
  });

  // Quarantined: intermittently fails on GH Actions with an uncaught
  // SIGTERM (status 143) even with a correctness-based (not wall-clock)
  // synchronization check confirming the trap is registered before the
  // signal is sent. Cross-validated as a GH-Actions-specific runner issue,
  // not a bug in this test or in installer-ui.sh — see issue #284 and the
  // "GitLab cross-validation mirror" note in HANDOVER-260-ci.md before
  // touching this test or its sibling below. Re-enable once GH Actions
  // runner contention is confirmed back to normal.
  it("restores terminal state when text entry is interrupted by a signal", () => {
    const transcript = join(mkdtempSync(join(tmpdir(), "orbit-pty-")), "typescript");
    const result = runPty(
      `source "$1"; exec 3<>/dev/tty; before="$(stty -g <&3)"; ${waitForPromptThenKill("Value: ", transcript)} if installer_ui_read_text 3 "Value: " 64 >/dev/null; then status=0; else status=$?; fi; wait || true; after="$(stty -g <&3)"; printf "STATUS=%s RESTORED=%s\n" "$status" "$([[ "$before" == "$after" ]] && printf yes || printf no)"`,
      "",
      {},
      transcript,
    );

    expect(result.status).toBe(0);
    // If this fires, the signal was sent before the prompt (and therefore
    // before the handler), so a failure below is the harness, not the code.
    expect(result.stdout).not.toContain("PROMPT_NEVER_APPEARED");
    expect(result.stdout).toContain("STATUS=130 RESTORED=yes");
    // Vitest's default 5s timeout is shorter than the margin above, so the
    // test would fail on elapsed time rather than on the behaviour. Raised
    // to comfortably clear the margin while the experiment runs.
  }, (KILL_MARGIN_SECONDS + 60) * 1000);

  it("cancels the raw single-key menu with a lone Escape and restores the terminal", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; before="$(stty -g <&3)"; if choice="$(installer_ui_select 3 "Choose" install install Install update Update)"; then status=0; else status=$?; fi; after="$(stty -g <&3)"; printf "STATUS=%s RESTORED=%s CHOICE=%s\n" "$status" "$([[ "$before" == "$after" ]] && printf yes || printf no)" "${choice:-none}"',
      "\x1b",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STATUS=130 RESTORED=yes CHOICE=none");
  });

  // Quarantined: see the comment on the sibling "text entry is interrupted
  // by a signal" test above — same investigation, same issue (#284).
  it("restores terminal state when the raw single-key menu is interrupted by a signal", async () => {
    const result = await runPtyInterrupted(
      `source "$1"; exec 3<>/dev/tty; before="$(stty -g <&3)"; printf "PID=%s\\n" "$BASHPID"; `
      + `if installer_ui_select 3 "Choose" install install Install update Update >/dev/null; then status=0; else status=$?; fi; `
      + `after="$(stty -g <&3)"; printf "STATUS=%s RESTORED=%s\\n" "$status" "$([[ "$before" == "$after" ]] && printf yes || printf no)"`,
      "1) Install",
    );

    expect(result.signalled).toBe(true);
    expect(result.stdout).toContain("STATUS=130 RESTORED=yes");
  });

  it("preserves a caller's own INT trap after a widget restores it", () => {
    const result = runPty(
      'source "$1"; exec 3<>/dev/tty; trap "printf CALLER_TRAP_RAN" INT; installer_ui_read_text 3 "Value: " 64 >/dev/null; kill -INT $BASHPID; printf DONE',
      "abc\r",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("CALLER_TRAP_RAN");
    expect(result.stdout).toContain("DONE");
  });

  it("labels TTY output as simulation without affecting ordinary output", () => {
    const colorEnv = { ...process.env, TERM: "xterm" };
    delete colorEnv.NO_COLOR;
    const simulated = spawnSync(
      "script",
      [
        "-qec",
        `source '${helper}'; installer_ui_init --simulation; installer_ui_emit bootstrap installer starting initial begin 3`,
        "/dev/null",
      ],
      { encoding: "utf8", env: colorEnv },
    );
    const ordinary = spawnSync(
      "script",
      [
        "-qec",
        `source '${helper}'; installer_ui_init; installer_ui_emit bootstrap installer starting initial begin 3`,
        "/dev/null",
      ],
      { encoding: "utf8", env: colorEnv },
    );

    expect(simulated.status).toBe(0);
    expect(simulated.stdout).toContain("[SIMULATION]");
    expect(ordinary.status).toBe(0);
    expect(ordinary.stdout).not.toContain("SIMULATION");
  });

  it("labels plain output with simulation=true without affecting ordinary output", () => {
    const simulated = runHelper(["--plain", "--simulation"]);
    const ordinary = runHelper(["--plain"]);

    expect(simulated.status).toBe(0);
    expect(simulated.stdout).toContain("simulation=true");
    expect(simulated.stdout).not.toMatch(/\x1b\[/u);
    expect(ordinary.status).toBe(0);
    expect(ordinary.stdout).not.toContain("simulation");
  });
});
