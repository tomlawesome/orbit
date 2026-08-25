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

import { PTY_DEADLINE_MS, PTY_ASYNC_DEADLINE_MS, PTY_TEST_TIMEOUT_MS, failOnPtyDeadline, ptyDeadlineError } from "./pty-deadline.mjs";

const helper = fileURLToPath(new URL("./installer-ui.sh", import.meta.url));

/*
 * Interrupting a prompt: why both these tests use runPtyInterrupted.
 *
 * Both assert that a prompt interrupted by SIGTERM restores the terminal,
 * and both spent a long time failing on GH Actions with 143 - killed by an
 * uncaught TERM. Every fix attempted (#284) treated that as a timing race
 * against trap installation: a wall-clock sleep, then polling SigCgt in
 * /proc (never observable on the runner), then waiting for the prompt to
 * appear in a pty transcript.
 *
 * Timing was never the cause. Proved by experiment (#510): a sixty-second
 * gap between the prompt appearing and the kill still produced 143, and did
 * so every time rather than intermittently. A timing bug gets better with
 * slack; this got worse, which is the tell.
 *
 * The cause is stdin. runPty passes an `input` string to spawnSync, which
 * closes stdin as soon as it is written; under `script` that closes the pty
 * master, the widget's read returns EOF immediately, and it leaves through
 * its read-error path - restoring the caller's traps on the way out. TERM is
 * back at its default disposition before the signal ever arrives. The widget
 * was never waiting, so the test was never testing interruption.
 *
 * runPtyInterrupted leaves stdin open for the life of the child, so the
 * widget genuinely blocks with its trap still installed when the signal
 * lands, and it signals the inner shell's own pid rather than `script`.
 *
 * The marker still has to postdate the trap, and getting it wrong is silent.
 * installer_ui_read_value traps at installer-ui.sh:471 and writes the prompt
 * at :472, so "Value: " is safe. installer_ui_select prints its HEADER at
 * :371, well before its trap at :385, and only renders the menu at :387 - so
 * waiting for "Choose" killed too early and reproduced the original 143
 * exactly. Its menu options are the first output that postdates the trap,
 * which is why that one waits for "1) Install".
 */

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
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, PTY_ASYNC_DEADLINE_MS);
    child.on("close", (status) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(ptyDeadlineError({ label: "runPtyInterrupted", deadlineMs: PTY_ASYNC_DEADLINE_MS, stdout }));
        return;
      }
      resolve({ status, stdout, signalled });
    });
  });
}

/*
 * Like runPty, but stdin is written once and then left open (#611).
 *
 * runPty hands spawnSync an `input` string, which closes stdin as soon as it
 * has been written; under `script` that tears down the pty master. Wherever
 * the *end* of the input carries meaning, that is a race rather than a
 * setup detail: installer_ui_read_key reads the first byte of an Escape and
 * then does a short second read to tell a lone Escape from an arrow
 * sequence, so whether the teardown beats that second read decides which
 * branch the widget takes. On a loaded CI runner it went the other way, the
 * widget waited for a key that was never coming, and the run hung until the
 * deadline killed it (#611, seen on a pull request that could not touch
 * these tests).
 *
 * Holding stdin open makes silence read as idleness, which is what a real
 * terminal does, so the widget leaves through its own logic instead. This is
 * the same shape scripts/installer-simulation.test.mjs was moved onto for
 * the identical fault (#512); this file's driver was never brought across.
 *
 * Only the tests whose input ends without a terminator need it. A test that
 * sends a trailing carriage return terminates on its own and keeps the
 * simpler spawnSync driver.
 */
function runPtyOpenStdin(body, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "script",
      ["-qefE", "never", "-c", `bash -c '${body}' _ '${helper}'`, "/dev/null"],
      { env: { ...process.env, TERM: "xterm", ...env } },
    );
    let stdout = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    // Written once, then left open: never child.stdin.end().
    child.stdin.on("error", () => { /* child exited first; nothing to write to */ });
    child.stdin.write(input);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, PTY_ASYNC_DEADLINE_MS);
    child.on("close", (status) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(ptyDeadlineError({ label: "runPtyOpenStdin", deadlineMs: PTY_ASYNC_DEADLINE_MS, stdout }));
        return;
      }
      resolve({ status, stdout });
    });
  });
}

function runPty(body, input, env = {}, transcript = "/dev/null") {
  const result = spawnSync(
    "script",
    ["-qefE", "never", "-c", `bash -c '${body}' _ '${helper}'`, transcript],
    {
      encoding: "utf8",
      input,
      timeout: PTY_DEADLINE_MS,
      killSignal: "SIGKILL",
      env: { ...process.env, TERM: "xterm", ...env },
    },
  );
  return failOnPtyDeadline(result, { label: "runPty", deadlineMs: PTY_DEADLINE_MS });
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
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, PTY_ASYNC_DEADLINE_MS);
    setTimeout(() => {
      child.stdin.write(input);
      child.stdin.end();
    }, 200);
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(ptyDeadlineError({ label: "runPtyTimed", deadlineMs: PTY_ASYNC_DEADLINE_MS, stdout, stderr }));
        return;
      }
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
  }, PTY_TEST_TIMEOUT_MS);

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

  it("restores terminal state when text entry is cancelled with Escape", async () => {
    const result = await runPtyOpenStdin(
      'source "$1"; exec 3<>/dev/tty; before="$(stty -g <&3)"; if value="$(installer_ui_read_text 3 "Value: " 64)"; then status=0; else status=$?; fi; after="$(stty -g <&3)"; printf "STATUS=%s RESTORED=%s\\n" "$status" "$([[ "$before" == "$after" ]] && printf yes || printf no)"',
      "\x1b",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STATUS=130 RESTORED=yes");
  }, PTY_TEST_TIMEOUT_MS);

  it("restores terminal state when text entry reaches EOF", async () => {
    const result = await runPtyTimed(
      'source "$1"; exec 3<>/dev/tty; before="$(stty -g <&3)"; if value="$(installer_ui_read_text 3 "Value: " 64)"; then status=0; else status=$?; fi; after="$(stty -g <&3)"; printf "STATUS=%s RESTORED=%s\n" "$status" "$([[ "$before" == "$after" ]] && printf yes || printf no)"',
      "\x04",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STATUS=1 RESTORED=yes");
  }, PTY_TEST_TIMEOUT_MS);

  it("restores terminal state when text entry is interrupted by a signal", async () => {
    const result = await runPtyInterrupted(
      `source "$1"; exec 3<>/dev/tty; before="$(stty -g <&3)"; printf "PID=%s\\n" "$BASHPID"; `
      + `if installer_ui_read_text 3 "Value: " 64 >/dev/null; then status=0; else status=$?; fi; `
      + `after="$(stty -g <&3)"; printf "STATUS=%s RESTORED=%s\\n" "$status" "$([[ "$before" == "$after" ]] && printf yes || printf no)"`,
      "Value: ",
    );

    expect(result.signalled).toBe(true);
    expect(result.stdout).toContain("STATUS=130 RESTORED=yes");
  }, PTY_TEST_TIMEOUT_MS);

  it("cancels the raw single-key menu with a lone Escape and restores the terminal", async () => {
    const result = await runPtyOpenStdin(
      'source "$1"; exec 3<>/dev/tty; before="$(stty -g <&3)"; if choice="$(installer_ui_select 3 "Choose" install install Install update Update)"; then status=0; else status=$?; fi; after="$(stty -g <&3)"; printf "STATUS=%s RESTORED=%s CHOICE=%s\n" "$status" "$([[ "$before" == "$after" ]] && printf yes || printf no)" "${choice:-none}"',
      "\x1b",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("STATUS=130 RESTORED=yes CHOICE=none");
  }, PTY_TEST_TIMEOUT_MS);

  it("restores terminal state when the raw single-key menu is interrupted by a signal", async () => {
    const result = await runPtyInterrupted(
      `source "$1"; exec 3<>/dev/tty; before="$(stty -g <&3)"; printf "PID=%s\\n" "$BASHPID"; `
      + `if installer_ui_select 3 "Choose" install install Install update Update >/dev/null; then status=0; else status=$?; fi; `
      + `after="$(stty -g <&3)"; printf "STATUS=%s RESTORED=%s\\n" "$status" "$([[ "$before" == "$after" ]] && printf yes || printf no)"`,
      "1) Install",
    );

    expect(result.signalled).toBe(true);
    expect(result.stdout).toContain("STATUS=130 RESTORED=yes");
  }, PTY_TEST_TIMEOUT_MS);

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
