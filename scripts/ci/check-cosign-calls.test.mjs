/**
 * The cosign call checker, scripts/ci/check-cosign-calls.mjs (#1841, "cosign:
 * no telemetry, nothing published beyond what signing needs").
 *
 * The checker scans a repo root (--root <dir>, default cwd): .gitlab-ci.yml,
 * the *.yml it includes locally, .github/workflows/*.yml and scripts/**\/*.sh.
 * It prints `file:line: reason` per problem and exits 1, or exits 0. Problems:
 * an OTEL_ variable set or exported (comments don't count); a `cosign sign`,
 * `sign-blob`, `attest` or `attest-blob` command without `--tlog-upload=false`
 * (continued lines are joined; a `# cosign-public-upload: <reason>` comment on
 * the line directly above, with a non-empty reason, allows a keyless call).
 * Other cosign mentions (verify, version, login, save, prose) are fine.
 *
 * Written from the specification before the checker existed. Drives the real
 * script with spawnSync against fixture repos in a scratch directory.
 *
 * Uses node:test, like the other script-driving suites. Run standalone:
 * `node --test scripts/ci/check-cosign-calls.test.mjs`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-cosign-calls.mjs", import.meta.url));
const worktree = fileURLToPath(new URL("../../", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "check-cosign-calls-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
/** Build a fixture repo from { relPath: contents }; return its root. */
function fixture(files) {
  const root = join(scratch, `repo-${counter++}`);
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

function run(root) {
  return spawnSync("node", [checker, "--root", root], { encoding: "utf8" });
}

function passes(files) {
  const result = run(fixture(files));
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}${result.stderr}`);
}

/** Expect exit 1 and a `file:line: reason` line for `file` (and `line` if given). */
function fails(files, file, line) {
  const result = run(fixture(files));
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\n${result.stdout}${result.stderr}`);
  const out = result.stdout + result.stderr;
  const re = new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:${line ?? "\\d+"}: \\S`, "m");
  assert.match(out, re);
}

const wf = ".github/workflows/sign.yml";

describe("telemetry (OTEL_ variables)", () => {
  it("flags a YAML variables: key starting OTEL_", () => {
    fails({ ".gitlab-ci.yml": "job:\n  variables:\n    OTEL_SDK_DISABLED: \"false\"\n  script:\n    - true\n" }, ".gitlab-ci.yml", 3);
  });

  it("flags a workflow env: key starting OTEL_", () => {
    fails({ [wf]: "jobs:\n  a:\n    steps:\n      - run: true\n        env:\n          OTEL_EXPORTER_OTLP_ENDPOINT: x\n" }, wf, 6);
  });

  it("flags a shell export OTEL_ assignment", () => {
    fails({ "scripts/sub/x.sh": "#!/usr/bin/env bash\nexport OTEL_TRACES_EXPORTER=otlp\n" }, "scripts/sub/x.sh", 2);
  });

  it("flags a bare shell OTEL_ assignment", () => {
    fails({ "scripts/x.sh": "#!/usr/bin/env bash\nOTEL_SDK_DISABLED=false some-command\n" }, "scripts/x.sh", 2);
  });

  it("flags an OTEL_ assignment in a nested scripts/ directory", () => {
    fails({ "scripts/a/b/x.sh": "export OTEL_X=1\n" }, "scripts/a/b/x.sh", 1);
  });

  it("ignores OTEL_ in comment lines", () => {
    passes({
      ".gitlab-ci.yml": "# OTEL_SDK_DISABLED: true is not set here\njob:\n  script:\n    - true\n",
      "scripts/x.sh": "#!/usr/bin/env bash\n  # export OTEL_X=1 would be bad\ntrue\n",
    });
  });
});

describe("--tlog-upload=false on signing commands", () => {
  for (const sub of ["sign", "sign-blob", "attest", "attest-blob"]) {
    it(`flags cosign ${sub} without the flag`, () => {
      fails({ "scripts/s.sh": `#!/usr/bin/env bash\ncosign ${sub} --key k thing\n` }, "scripts/s.sh", 2);
    });

    it(`accepts cosign ${sub} with the flag`, () => {
      passes({ "scripts/s.sh": `#!/usr/bin/env bash\ncosign ${sub} --tlog-upload=false --key k thing\n` });
    });
  }

  it("joins a trailing-backslash continuation: flag on a later line passes", () => {
    passes({ "scripts/s.sh": "cosign sign \\\n  --key k \\\n  --tlog-upload=false \\\n  image\n" });
  });

  it("joins a trailing-backslash continuation: no flag anywhere fails at the command", () => {
    fails({ "scripts/s.sh": "echo hi\ncosign sign \\\n  --key k \\\n  image\n" }, "scripts/s.sh", 2);
  });

  it("does not take a flag from the next, separate command", () => {
    fails({ "scripts/s.sh": "cosign sign --key k image\ncosign sign --tlog-upload=false --key k other\n" }, "scripts/s.sh", 1);
  });

  it("handles a command inside a YAML block scalar: flag present passes", () => {
    passes({
      ".gitlab-ci.yml": "job:\n  script:\n    - |\n      cosign sign-blob \\\n        --tlog-upload=false \\\n        --key k f\n",
    });
  });

  it("handles a command inside a YAML block scalar: flag missing fails", () => {
    fails({
      ".gitlab-ci.yml": "job:\n  script:\n    - |\n      echo start\n      cosign sign-blob \\\n        --key k f\n",
    }, ".gitlab-ci.yml", 5);
  });

  it("checks a workflow run: step and a `- cosign ...` list item", () => {
    fails({ [wf]: "jobs:\n  a:\n    steps:\n      - run: cosign attest --key k img\n" }, wf, 4);
    fails({ ".gitlab-ci.yml": "job:\n  script:\n    - cosign sign --key k img\n" }, ".gitlab-ci.yml", 3);
  });

  it("checks cosign after && ; | and $(", () => {
    fails({ "scripts/a.sh": "true && cosign sign img\n" }, "scripts/a.sh", 1);
    fails({ "scripts/b.sh": "true; cosign sign img\n" }, "scripts/b.sh", 1);
    fails({ "scripts/c.sh": "echo x | cosign sign img\n" }, "scripts/c.sh", 1);
    fails({ "scripts/d.sh": "out=$(cosign sign img)\n" }, "scripts/d.sh", 1);
  });

  it("checks a file included locally from .gitlab-ci.yml", () => {
    fails({
      ".gitlab-ci.yml": "include:\n  - local: ci/more.yml\njob:\n  script:\n    - true\n",
      "ci/more.yml": "other:\n  script:\n    - cosign sign img\n",
    }, "ci/more.yml", 3);
  });
});

describe("cosign-public-upload marker", () => {
  const reasoned = "# cosign-public-upload: keyless release signature belongs in Rekor\n";

  it("allows a keyless call with the marker on the line directly above", () => {
    passes({ "scripts/s.sh": `#!/usr/bin/env bash\n${reasoned}cosign sign --yes image\n` });
  });

  it("allows a marked call in a workflow block scalar", () => {
    passes({
      [wf]: `jobs:\n  a:\n    steps:\n      - run: |\n          ${reasoned}          cosign sign --yes image\n`,
    });
  });

  it("rejects a marker with an empty reason", () => {
    fails({ "scripts/s.sh": "# cosign-public-upload:\ncosign sign --yes image\n" }, "scripts/s.sh", 2);
    fails({ "scripts/t.sh": "# cosign-public-upload:   \ncosign sign --yes image\n" }, "scripts/t.sh", 2);
  });

  it("rejects a marker that is not on the line directly above", () => {
    fails({ "scripts/s.sh": `${reasoned}echo between\ncosign sign --yes image\n` }, "scripts/s.sh", 3);
    fails({ "scripts/t.sh": `${reasoned}\ncosign sign --yes image\n` }, "scripts/t.sh", 3);
  });

  it("a marker covers only the one command below it", () => {
    fails({ "scripts/s.sh": `${reasoned}cosign sign --yes a\ncosign sign --yes b\n` }, "scripts/s.sh", 3);
  });
});

describe("other mentions of cosign are fine", () => {
  it("ignores verify, version, login and save", () => {
    passes({
      "scripts/s.sh": [
        "cosign verify image",
        "cosign verify-blob --bundle b f",
        "cosign version",
        "cosign login ghcr.io",
        "cosign save image --dir d",
        "",
      ].join("\n"),
    });
  });

  it("ignores prose in comments and echo strings", () => {
    passes({
      "scripts/s.sh": [
        "# run cosign sign later, with the flag",
        'echo "run cosign sign later"',
        "echo 'cosign attest comes after'",
        "",
      ].join("\n"),
      ".gitlab-ci.yml": "# cosign sign-blob is called from a script\njob:\n  script:\n    - echo \"run cosign sign later\"\n",
    });
  });

  it("ignores files outside the scanned set", () => {
    passes({ "docs/notes.md": "cosign sign img\nexport OTEL_X=1\n", "src/x.sh": "cosign sign img\n" });
  });

  it("exits 0 on an empty repo", () => {
    passes({ "README.md": "hello\n" });
  });
});

describe("variable command words", () => {
  const forms = ["$cosign", '"$cosign"', '"${cosign}"', '"$cosign_cmd"', "${COSIGN_BIN}", '"$COSIGN"'];
  for (const v of forms) {
    it(`flags ${v} sign without the flag`, () => {
      fails({ "scripts/s.sh": `#!/usr/bin/env bash\n${v} sign --key k img\n` }, "scripts/s.sh", 2);
    });

    it(`accepts ${v} attest-blob with the flag`, () => {
      passes({ "scripts/s.sh": `#!/usr/bin/env bash\n${v} attest-blob --tlog-upload=false --key k f\n` });
    });

    it(`joins a continuation for ${v}: flag on a later line passes, none fails`, () => {
      passes({ "scripts/s.sh": `${v} sign-blob \\\n  --key k \\\n  --tlog-upload=false \\\n  f\n` });
      fails({ "scripts/t.sh": `echo hi\n${v} sign-blob \\\n  --key k \\\n  f\n` }, "scripts/t.sh", 2);
    });

    it(`ignores ${v} verify`, () => {
      passes({ "scripts/s.sh": `${v} verify img\n` });
    });
  }

  it("flags a variable cosign after &&, ||, ; | and $(", () => {
    fails({ "scripts/a.sh": 'true && "$cosign" sign img\n' }, "scripts/a.sh", 1);
    fails({ "scripts/b.sh": 'false || "${cosign}" sign img\n' }, "scripts/b.sh", 1);
    fails({ "scripts/c.sh": 'true; "$cosign_cmd" attest img\n' }, "scripts/c.sh", 1);
    fails({ "scripts/d.sh": 'out=$("$COSIGN" sign img)\n' }, "scripts/d.sh", 1);
  });

  it("accepts a marked variable-form keyless call", () => {
    passes({ "scripts/s.sh": '# cosign-public-upload: keyless release signature\n"${cosign}" sign --yes img\n' });
  });

  it("does not treat a variable not named cosign as cosign", () => {
    passes({ "scripts/s.sh": '"$signer" sign img\n"${tool}" sign-blob f\n' });
  });

  it("ignores cosign text inside a string whose command word is something else", () => {
    passes({
      "scripts/s.sh":
        '  fail "the signature at ${signature_path} is not valid base64; cosign sign-blob output is always base64-encoded DER"\n',
    });
  });
});

describe("wrappers and tokens anywhere in the command (#1841 widened)", () => {
  const calls = [
    "env X=1 cosign sign img",
    "exec cosign sign img",
    "sudo cosign sign img",
    "nohup cosign sign img",
    "x=1 cosign sign img",
    "xargs cosign sign",
    "cosign --verbose sign img",
    "cosign -d sign img",
    'cosign "sign" img',
    "cosign 'sign-blob' f",
    "/usr/local/bin/cosign sign img",
    "env X=1 $COSIGN_BIN attest img",
  ];
  for (const c of calls) {
    it(`flags ${c}`, () => {
      fails({ "scripts/s.sh": `#!/usr/bin/env bash\n${c}\n` }, "scripts/s.sh", 2);
    });
    it(`accepts ${c} with the flag`, () => {
      passes({ "scripts/s.sh": `#!/usr/bin/env bash\n${c} --tlog-upload=false\n` });
    });
  }

  it("does not flag wrapped verify", () => {
    passes({ "scripts/s.sh": "env X=1 cosign verify img\nsudo cosign version\n" });
  });
});

describe("unknown subcommand", () => {
  for (const c of ['cosign "$@"', "cosign $@", "cosign $*", "cosign $c img", 'cosign "$sub" img', 'run() { cosign "$@"; }']) {
    it(`flags ${c}`, () => {
      fails({ "scripts/s.sh": `#!/usr/bin/env bash\n${c}\n` }, "scripts/s.sh", 2);
    });
  }

  it("accepts an unknown-subcommand call with the flag or a marker", () => {
    passes({ "scripts/s.sh": 'cosign "$@" --tlog-upload=false\n' });
    passes({ "scripts/t.sh": '# cosign-public-upload: wrapper for keyless callers\ncosign "$@"\n' });
  });
});

describe("quoted text", () => {
  it("counts quoted text after bash, sh and eval", () => {
    fails({ "scripts/a.sh": 'bash -c "cosign sign img"\n' }, "scripts/a.sh", 1);
    fails({ "scripts/b.sh": "sh -c 'cosign sign-blob f'\n" }, "scripts/b.sh", 1);
    fails({ "scripts/c.sh": 'eval "cosign attest img"\n' }, "scripts/c.sh", 1);
  });

  it("accepts a bash -c call with the flag inside", () => {
    passes({ "scripts/a.sh": 'bash -c "cosign sign --tlog-upload=false img"\n' });
  });

  it("treats other quoted text as prose", () => {
    passes({
      "scripts/s.sh": [
        'echo "cosign sign later"',
        'fail "the signature is not valid base64; cosign sign-blob output is always base64"',
        "printf '%s\\n' 'cosign attest later'",
        "",
      ].join("\n"),
    });
  });
});

describe("the no-upload flag is a whole token outside comments", () => {
  it("rejects the flag in a trailing comment", () => {
    fails({ "scripts/s.sh": "cosign sign img # --tlog-upload=false\n" }, "scripts/s.sh", 1);
  });

  it("rejects a longer token that merely starts with the flag", () => {
    fails({ "scripts/s.sh": "cosign sign --tlog-upload=false=x img\n" }, "scripts/s.sh", 1);
    fails({ "scripts/t.sh": "cosign sign --tlog-upload=falsey img\n" }, "scripts/t.sh", 1);
  });

  it("the last --tlog-upload wins", () => {
    fails({ "scripts/s.sh": "cosign sign --tlog-upload=false --tlog-upload=true img\n" }, "scripts/s.sh", 1);
    passes({ "scripts/t.sh": "cosign sign --tlog-upload=true --tlog-upload=false img\n" });
  });

  it("accepts the two-token form", () => {
    passes({ "scripts/s.sh": "cosign sign --tlog-upload false img\n" });
  });

  it("strips a trailing comment from a continued command", () => {
    fails({ "scripts/s.sh": "cosign sign \\\n  img # --tlog-upload=false\n" }, "scripts/s.sh", 1);
  });
});

describe("OTEL_ in an assignment list", () => {
  it("flags every OTEL_ assignment in an export/declare/env/readonly list", () => {
    for (const [i, c] of ["export FOO=1 OTEL_X=1", "declare -x FOO=1 OTEL_X=1", "readonly FOO=1 OTEL_X=1", "env FOO=1 OTEL_X=1 cmd"].entries()) {
      fails({ [`scripts/o${i}.sh`]: `${c}\n` }, `scripts/o${i}.sh`, 1);
    }
  });

  it("reports each OTEL_ assignment", () => {
    const result = run(fixture({ "scripts/s.sh": "export OTEL_A=1 OTEL_B=2\n" }));
    assert.equal(result.status, 1);
    const out = result.stdout + result.stderr;
    assert.match(out, /OTEL_A/);
    assert.match(out, /OTEL_B/);
  });
});

describe("scanned files (#1841 widened)", () => {
  it("scans .github/workflows/*.yaml as well as .yml", () => {
    fails({ ".github/workflows/sign.yaml": "jobs:\n  a:\n    steps:\n      - run: cosign sign img\n" }, ".github/workflows/sign.yaml", 4);
  });

  it("follows local includes inside included files (nested)", () => {
    fails({
      ".gitlab-ci.yml": "include:\n  - local: ci/one.yml\njob:\n  script:\n    - true\n",
      "ci/one.yml": "include:\n  - local: ci/two.yml\n",
      "ci/two.yml": "other:\n  script:\n    - cosign sign img\n",
    }, "ci/two.yml", 3);
  });
});

describe("variable cosign only in command position (#1841)", () => {
  it("ignores a cosign variable used as an argument", () => {
    passes({
      "scripts/s.sh": [
        "printf '%s  %s\\n' \"$COSIGN_SHA256\" \"$1\" | sha256sum -c -",
        'echo "$cosign_path" "$x"',
        "",
      ].join("\n"),
    });
  });

  it("still flags a variable after env VAR=value, or leading VAR=value", () => {
    fails({ "scripts/a.sh": 'env A=1 "$cosign" sign img\n' }, "scripts/a.sh", 1);
    fails({ "scripts/b.sh": 'X=1 "$COSIGN_BIN" sign-blob f\n' }, "scripts/b.sh", 1);
  });

  it("flags a variable after exec, sudo, nohup, command, time and xargs", () => {
    for (const [i, w] of ["exec", "sudo", "nohup", "command", "time", "xargs"].entries()) {
      fails({ [`scripts/p${i}.sh`]: `${w} "$cosign" sign img\n` }, `scripts/p${i}.sh`, 1);
    }
  });

  it("still flags the literal word and a path after other words", () => {
    fails({ "scripts/a.sh": "foo cosign sign img\n" }, "scripts/a.sh", 1);
    fails({ "scripts/b.sh": "foo /usr/bin/cosign sign img\n" }, "scripts/b.sh", 1);
  });
});

describe("cosign-passthrough marker (#1841)", () => {
  const why = "# cosign-passthrough: test double forwards its arguments\n";

  it("allows an unknown-subcommand call with the marker directly above", () => {
    passes({ "scripts/s.sh": `${why}cosign "$@"\n` });
    passes({ "scripts/t.sh": `${why}"$REAL_COSIGN" $*\n` });
  });

  it("does not excuse an explicit signing subcommand without the flag", () => {
    for (const [i, sub] of ["sign", "sign-blob", "attest", "attest-blob"].entries()) {
      fails({ [`scripts/e${i}.sh`]: `${why}cosign ${sub} img\n` }, `scripts/e${i}.sh`, 2);
    }
  });

  it("rejects an empty reason", () => {
    fails({ "scripts/s.sh": '# cosign-passthrough:\ncosign "$@"\n' }, "scripts/s.sh", 2);
    fails({ "scripts/t.sh": '# cosign-passthrough:   \ncosign "$@"\n' }, "scripts/t.sh", 2);
  });

  it("must be on the line directly above", () => {
    fails({ "scripts/s.sh": `${why}echo between\ncosign "$@"\n` }, "scripts/s.sh", 3);
  });
});

describe("invocation", () => {
  it("defaults the root to the working directory", () => {
    const root = fixture({ "scripts/s.sh": "cosign sign img\n" });
    const result = spawnSync("node", [checker], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /^scripts\/s\.sh:1: \S/m);
  });

  it("prints one file:line: reason line for each problem", () => {
    const root = fixture({ "scripts/s.sh": "cosign sign a\nexport OTEL_X=1\ncosign attest b\n" });
    const result = run(root);
    assert.equal(result.status, 1);
    const lines = (result.stdout + result.stderr).split("\n").filter((l) => /^scripts\/s\.sh:\d+: \S/.test(l));
    assert.equal(lines.length, 3);
  });
});

describe("this repository", () => {
  it("passes the checker once countersign.yml's keyless calls carry the marker", () => {
    const result = spawnSync("node", [checker, "--root", worktree], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });

  it("flags both keyless calls when countersign.yml is copied without markers", () => {
    const src = readFileSync(join(worktree, ".github/workflows/countersign.yml"), "utf8");
    const lines = src.split("\n");
    const callLines = [];
    lines.forEach((l, i) => {
      if (/"\$\{cosign\}" sign(-blob)? --yes/.test(l)) callLines.push(i + 1);
    });
    assert.equal(callLines.length, 2);
    // Drop marker lines but keep line numbers stable by blanking them.
    const blanked = lines.map((l) => (/^\s*#\s*cosign-public-upload:/.test(l) ? "" : l)).join("\n");
    const root = fixture({ ".github/workflows/countersign.yml": blanked });
    const result = run(root);
    assert.equal(result.status, 1);
    const out = result.stdout + result.stderr;
    for (const n of callLines) {
      assert.match(out, new RegExp(`^\\.github/workflows/countersign\\.yml:${n}: \\S`, "m"));
    }
  });

  it("wires the checker into the fast_checks job of .gitlab-ci.yml", () => {
    const ci = readFileSync(join(worktree, ".gitlab-ci.yml"), "utf8");
    const start = ci.search(/^fast_checks:\s*$/m);
    assert.notEqual(start, -1, "fast_checks job not found");
    const rest = ci.slice(start + ci.slice(start).indexOf("\n") + 1);
    const next = rest.search(/^\S.*:\s*$/m);
    const job = next === -1 ? rest : rest.slice(0, next);
    assert.match(job, /node scripts\/ci\/check-cosign-calls\.mjs/);
  });
});

describe("a cosign variable behind a command wrapper (#1843)", () => {
  // The literal form is already caught behind any word; a variable named
  // *cosign* must count behind these wrappers too, including their own
  // flags and arguments.
  const wrappers = [
    "timeout 5",
    "timeout -k 2 5",
    "timeout --signal=KILL 5",
    "nice -n 5",
    "nice",
    "ionice -c3",
    "ionice -c 2 -n 7",
    "setsid",
    "setsid -w",
    "stdbuf -oL",
    "stdbuf -o0 -e0",
    "flock /tmp/l",
    "flock -w 5 /tmp/l",
  ];
  for (const [i, w] of wrappers.entries()) {
    it(`flags "\${cosign}" sign behind ${w}, like the literal word`, () => {
      fails({ [`scripts/lit${i}.sh`]: `#!/usr/bin/env bash\n${w} cosign sign img\n` }, `scripts/lit${i}.sh`, 2);
      fails({ [`scripts/w${i}.sh`]: `#!/usr/bin/env bash\n${w} "\${cosign}" sign img\n` }, `scripts/w${i}.sh`, 2);
      fails({ [`scripts/x${i}.sh`]: `#!/usr/bin/env bash\n${w} $COSIGN_BIN attest-blob f\n` }, `scripts/x${i}.sh`, 2);
    });

    it(`accepts the variable behind ${w} with the flag, and verify without it`, () => {
      passes({ [`scripts/s${i}.sh`]: `${w} "\${cosign}" sign --tlog-upload=false img\n${w} "\${cosign}" verify img\n` });
    });
  }

  it("flags the variable behind a wrapper after && and inside $( )", () => {
    fails({ "scripts/a.sh": 'true && timeout 5 "${cosign}" sign img\n' }, "scripts/a.sh", 1);
    fails({ "scripts/b.sh": 'out=$(flock /tmp/l "$COSIGN" sign img)\n' }, "scripts/b.sh", 1);
  });

  it("flags the variable behind stacked wrappers", () => {
    fails({ "scripts/s.sh": 'timeout 5 nice -n 5 "${cosign}" sign img\n' }, "scripts/s.sh", 1);
    fails({ "scripts/t.sh": 'sudo timeout 5 "${cosign}" sign img\n' }, "scripts/t.sh", 1);
  });

  it("a marker still excuses the wrapped variable call", () => {
    passes({ "scripts/s.sh": '# cosign-public-upload: keyless release signature\ntimeout 5 "${cosign}" sign --yes img\n' });
  });

  it("does not treat a cosign variable as the command when it is only an argument of a wrapper's own flag", () => {
    passes({ "scripts/s.sh": 'timeout 5 echo "$COSIGN_SHA256" sign\nflock /tmp/l printf "%s" "$cosign_path"\n' });
  });
});

describe("one marker excuses one call (#1843)", () => {
  const reasoned = "# cosign-public-upload: keyless release signature belongs in Rekor\n";

  it("a marked call alone still passes", () => {
    passes({ "scripts/s.sh": `${reasoned}cosign sign --yes i\n` });
  });

  for (const [name, joiner] of [["&&", " && "], [";", "; "], ["||", " || "], ["|", " | "]]) {
    it(`flags the second call of two joined by ${name} on the marked line`, () => {
      fails({ "scripts/s.sh": `${reasoned}cosign sign --yes i${joiner}cosign sign --yes j\n` }, "scripts/s.sh", 2);
    });
  }

  it("flags the second call whichever form it takes", () => {
    fails({ "scripts/a.sh": `${reasoned}cosign sign --yes i && "\${cosign}" sign-blob --yes f\n` }, "scripts/a.sh", 2);
    fails({ "scripts/b.sh": `${reasoned}cosign sign --yes i && out=$(cosign attest --yes j)\n` }, "scripts/b.sh", 2);
  });

  it("flags the second call of a continued command", () => {
    fails({ "scripts/s.sh": `${reasoned}cosign sign --yes i \\\n  && cosign sign --yes j\n` }, "scripts/s.sh", 3);
  });

  it("excuses the first call only: a flagless second call fails even if the first has the flag", () => {
    fails({ "scripts/s.sh": `${reasoned}cosign sign --tlog-upload=false i && cosign sign j\n` }, "scripts/s.sh", 2);
  });

  it("a second call with the flag needs no marker", () => {
    passes({ "scripts/s.sh": `${reasoned}cosign sign --yes i && cosign sign --tlog-upload=false j\n` });
  });

  it("a marker inside a block scalar excuses one call of two on its line", () => {
    fails({
      [wf]: `jobs:\n  a:\n    steps:\n      - run: |\n          ${reasoned}          cosign sign --yes i && cosign sign --yes j\n`,
    }, wf, 6);
  });
});

describe("cosign called from .mjs and .ts files (#1843)", () => {
  // How the checker finds these files is not fixed by the spec; the fixtures
  // use scripts/ (where the .mjs files are) and src/ (the .ts files).
  const places = ["scripts/tool.mjs", "scripts/ci/deep/tool.mjs", "src/lib/tool.ts"];

  for (const [i, p] of places.entries()) {
    const f = (body) => ({ [p]: `import { execFileSync } from "node:child_process";\n${body}\n` });

    it(`flags execFileSync("cosign", ["sign", ...]) in ${p}`, () => {
      fails(f('execFileSync("cosign", ["sign", image]);'), p, 2);
      fails(f("execFileSync('cosign', ['attest-blob', '--key', k, file]);"), p, 2);
    });

    it(`flags spawn, spawnSync, execFile and execFileSync forms in ${p}`, () => {
      for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
        fails(f(`${fn}("cosign", ["sign-blob", file], { stdio: "inherit" });`), p, 2);
      }
    });

    it(`flags a cosign command string run by exec in ${p}`, () => {
      fails(f("exec(`cosign sign ${image}`);"), p, 2);
      fails(f('execSync("cosign sign " + image);'), p, 2);
      fails(f('execSync(`/usr/local/bin/cosign attest ${image}`, { stdio: "inherit" });'), p, 2);
    });

    it(`accepts the same calls with --tlog-upload=false in ${p}`, () => {
      passes(f('execFileSync("cosign", ["sign", "--tlog-upload=false", image]);'));
      passes(f('spawn("cosign", ["sign-blob", "--tlog-upload", "false", file]);'));
      passes(f("exec(`cosign sign --tlog-upload=false ${image}`);"));
    });

    it(`ignores verify, version and other non-signing cosign calls in ${p}`, () => {
      passes(f('execFileSync("cosign", ["verify", image]);\nspawnSync("cosign", ["version"]);\nexec(`cosign verify-blob ${f}`);'));
    });

    it(`ignores cosign in comments, prose strings and identifiers in ${p}`, () => {
      passes(
        f(
          [
            "// Signing tools are downloaded release binaries (cosign, #661).",
            "/* run cosign sign later, with the flag */",
            'console.log("run cosign sign later");',
            'const message = "cosign attest comes after";',
            "const cosignUsable = true;",
            "const row = { cosignUsable: facts.cosignUsable };",
          ].join("\n"),
        ),
      );
    });

    it(`flags OTEL_ set in a cosign call's environment in ${p}`, () => {
      fails(f('execFileSync("cosign", ["verify", image], { env: { OTEL_TRACES_EXPORTER: "otlp" } });'), p, 2);
    });
    void i;
  }

  it("does not flag the checker-neutral file types: .md, .json and .txt mentioning a call", () => {
    passes({ "scripts/n.md": 'execFileSync("cosign", ["sign", i])\n', "src/n.json": '{"run":"cosign sign i"}\n' });
  });
});

describe("cosign called from a Dockerfile (#1843)", () => {
  const places = ["Dockerfile", "tests/sub/Dockerfile", "Dockerfile.release"];
  for (const p of places) {
    it(`flags a RUN cosign sign line in ${p}`, () => {
      fails({ [p]: "FROM alpine\nRUN cosign sign img\n" }, p, 2);
      fails({ [p]: "FROM alpine\nRUN cosign attest-blob --key k f\n" }, p, 2);
    });

    it(`flags a cosign call after && and in a continued RUN in ${p}`, () => {
      fails({ [p]: "FROM alpine\nRUN apk add cosign && cosign sign img\n" }, p, 2);
      fails({ [p]: "FROM alpine\nRUN set -eu \\\n  && cosign sign-blob \\\n     --key k f\n" }, p, 3);
    });

    it(`accepts a RUN cosign sign with --tlog-upload=false in ${p}`, () => {
      passes({ [p]: "FROM alpine\nRUN cosign sign --tlog-upload=false img\n" });
    });

    it(`ignores verify, comments and ENV text mentioning cosign in ${p}`, () => {
      passes({ [p]: "FROM alpine\n# RUN cosign sign img\nRUN cosign verify img\nENV NOTE=\"cosign sign later\"\nCOPY cosign.pub /etc/\n" });
    });

    it(`flags an OTEL_ variable set by ENV in ${p}`, () => {
      fails({ [p]: "FROM alpine\nENV OTEL_SDK_DISABLED=false\n" }, p, 2);
    });
  }
});

describe("the new code-file scan on this repository (#1843)", () => {
  // scripts/supply-chain-policy.mjs only mentions cosign in a comment, and
  // src/lib/host-facts.ts only has a cosignUsable field: neither is a call.
  it("passes when the two real files that merely mention cosign are scanned", () => {
    const rel = ["scripts/supply-chain-policy.mjs", "src/lib/host-facts.ts"];
    const files = Object.fromEntries(rel.map((r) => [r, readFileSync(join(worktree, r), "utf8")]));
    assert.match(files[rel[0]], /cosign/);
    assert.match(files[rel[1]], /cosignUsable/);
    passes(files);
  });

  it("passes on the whole repository tree, whatever other .mjs, .ts and Dockerfile files mention cosign", () => {
    const result = spawnSync("node", [checker, "--root", worktree], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});

describe("includes from other projects are never fetched or scanned (#1843, owner decision 37b)", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const ci = ".gitlab-ci.yml";
  const notScanned = /not scanned/i;

  describe("remote includes fail", () => {
    it("fails on a list-form remote: include", () => {
      fails({ [ci]: "include:\n  - remote: https://example.com/ci/x.yml\n" }, ci, 2);
    });

    it("fails on a remote: include after a local one", () => {
      fails({ [ci]: "include:\n  - local: a.yml\n  - remote: https://example.com/ci/x.yml\n", "a.yml": "job:\n  script:\n    - true\n" }, ci, 3);
    });

    it("fails on the string shorthand include: 'https://...'", () => {
      fails({ [ci]: "include: 'https://example.com/ci/x.yml'\n" }, ci, 1);
    });

    it("fails on a list item that is a bare https:// string", () => {
      fails({ [ci]: "include:\n  - 'https://example.com/ci/x.yml'\n" }, ci, 2);
    });

    it("fails on a remote: include in a nested local include, naming that file", () => {
      fails({ [ci]: "include:\n  - local: sub/a.yml\n", "sub/a.yml": "include:\n  - remote: https://example.com/x.yml\n" }, "sub/a.yml", 2);
    });
  });

  describe("project includes need a full commit sha", () => {
    const proj = (ref, extra = "") => `include:\n  - project: ai/other\n${ref === null ? "" : `    ref: ${ref}\n`}    file: ci/t.yml\n${extra}`;

    it("fails on a project: include with no ref", () => {
      fails({ [ci]: proj(null) }, ci, 2);
    });

    it("fails on a tag ref", () => {
      fails({ [ci]: proj("v1.2.3") }, ci, 2);
    });

    it("fails on a branch ref", () => {
      fails({ [ci]: proj("main") }, ci, 2);
    });

    it("fails on a short sha", () => {
      fails({ [ci]: proj("0123456") }, ci, 2);
    });

    it("fails on a 39-hex and a 41-hex ref", () => {
      fails({ [ci]: proj(sha.slice(1)) }, ci, 2);
      fails({ [ci]: proj(`${sha}a`) }, ci, 2);
    });

    it("fails on a 40-character ref that is not all hex", () => {
      fails({ [ci]: proj(`${sha.slice(0, 39)}g`) }, ci, 2);
    });

    it("fails on an unpinned project: include in a nested local include, naming that file", () => {
      fails({ [ci]: "include:\n  - local: sub/a.yml\n", "sub/a.yml": proj("main") }, "sub/a.yml", 2);
    });

    it("accepts a quoted 40-hex ref with a trailing comment, and prints the not-scanned line", () => {
      const result = run(fixture({ [ci]: `include:\n  - project: ai/other\n    ref: "${sha}"  # v1\n    file: ci/t.yml\n` }));
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, notScanned);
    });
  });

  describe("a pinned project include passes and is reported as not scanned", () => {
    function pinned(fileLine, expectFiles) {
      const result = run(fixture({ [ci]: `include:\n  - project: ai/other\n    ref: ${sha}\n${fileLine}\n` }));
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stdout}${result.stderr}`);
      const lines = (result.stdout + result.stderr).split("\n").filter((l) => notScanned.test(l));
      assert.equal(lines.length, 1, `expected one not-scanned line, got:\n${result.stdout}${result.stderr}`);
      assert.ok(lines[0].includes("ai/other"), lines[0]);
      assert.ok(lines[0].includes(sha), lines[0]);
      for (const f of expectFiles) assert.ok(lines[0].includes(f), `${f} missing from: ${lines[0]}`);
    }

    it("with file: as a string", () => pinned("    file: ci/t.yml", ["ci/t.yml"]));

    it("with file: as a list, naming every file on the one line", () => pinned("    file:\n      - ci/a.yml\n      - ci/b.yml", ["ci/a.yml", "ci/b.yml"]));

    it("prints one line per project include", () => {
      const other = "1111111111111111111111111111111111111111";
      const result = run(
        fixture({
          [ci]: `include:\n  - project: ai/one\n    ref: ${sha}\n    file: a.yml\n  - project: ai/two\n    ref: ${other}\n    file: b.yml\n`,
        }),
      );
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      const lines = (result.stdout + result.stderr).split("\n").filter((l) => notScanned.test(l));
      assert.equal(lines.length, 2, lines.join("\n"));
      assert.ok(lines.some((l) => l.includes("ai/one") && l.includes(sha) && l.includes("a.yml")));
      assert.ok(lines.some((l) => l.includes("ai/two") && l.includes(other) && l.includes("b.yml")));
    });

    it("still scans the repository's own files and fails on a bad call beside a pinned include", () => {
      const result = run(
        fixture({ [ci]: `include:\n  - project: ai/other\n    ref: ${sha}\n    file: a.yml\njob:\n  script:\n    - cosign sign img\n` }),
      );
      assert.equal(result.status, 1);
      assert.match(result.stdout, /^\.gitlab-ci\.yml:7: \S/m);
    });
  });

  describe("on this repository", () => {
    it("passes, and each of the three ai/agent-infra includes prints a not-scanned line with its pinned ref and file", () => {
      const result = spawnSync("node", [checker, "--root", worktree], { encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      const lines = (result.stdout + result.stderr).split("\n").filter((l) => notScanned.test(l));
      assert.equal(lines.length, 3, `expected 3 not-scanned lines, got:\n${result.stdout}${result.stderr}`);
      const expected = [
        ["c93bc8e78bf5807b8f2c2f5d7c13784f4a54746d", "scripts/private-details/ci-template.yml"],
        ["f950d7d9abc28838e6d1353da8c9663f9ecb27b7", "scripts/backmerge-skip/ci-template.yml"],
        ["1dca70057bd93f68ded22c6b159f315c987c1663", "scripts/dev-landing/ci-template.yml"],
      ];
      for (const [ref, file] of expected) {
        assert.ok(
          lines.some((l) => l.includes("ai/agent-infra") && l.includes(ref) && l.includes(file)),
          `no not-scanned line for ${ref} ${file} in:\n${lines.join("\n")}`,
        );
      }
    });
  });
});

describe("component: and template: includes (#1843, owner decision on note 37b follow-up)", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const ci = ".gitlab-ci.yml";
  const notScanned = /not scanned/i;
  const comp = (ref) => `include:\n  - component: gitlab.example.com/ai/other/build@${ref}\n`;

  it("accepts a component pinned to a 40-hex sha and prints a not-scanned line naming it", () => {
    const result = run(fixture({ [ci]: comp(sha) }));
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const lines = (result.stdout + result.stderr).split("\n").filter((l) => notScanned.test(l));
    assert.equal(lines.length, 1, `expected one not-scanned line, got:\n${result.stdout}${result.stderr}`);
    assert.ok(lines[0].includes("ai/other/build"), lines[0]);
    assert.ok(lines[0].includes(sha), lines[0]);
  });

  for (const [what, ref] of [["a version tag @1.0.0", "1.0.0"], ["a branch @main", "main"], ["@~latest", "~latest"], ["a short sha", "0123456"]]) {
    it(`fails on a component pinned to ${what}`, () => {
      fails({ [ci]: comp(ref) }, ci, 2);
    });
  }

  it("fails on a component with no @ref", () => {
    fails({ [ci]: "include:\n  - component: gitlab.example.com/ai/other/build\n" }, ci, 2);
  });

  it("fails on an unpinned component in a nested local include, naming that file", () => {
    fails({ [ci]: "include:\n  - local: sub/a.yml\n", "sub/a.yml": comp("main") }, "sub/a.yml", 2);
  });

  it("fails on a template: include", () => {
    fails({ [ci]: "include:\n  - template: Jobs/SAST.gitlab-ci.yml\n" }, ci, 2);
  });

  it("fails on a template: include as a single mapping", () => {
    fails({ [ci]: "include:\n  template: Jobs/SAST.gitlab-ci.yml\n" }, ci, 2);
  });

  it("fails on a template: include in a nested local include, naming that file", () => {
    fails({ [ci]: "include:\n  - local: sub/a.yml\n", "sub/a.yml": "include:\n  - template: Jobs/SAST.gitlab-ci.yml\n" }, "sub/a.yml", 2);
  });
});

describe("strict include subset (#1843 review fix round, note 59935)", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const ci = ".gitlab-ci.yml";
  const bad = (name, body, line, extra = {}) =>
    it(`fails on ${name}`, () => {
      fails({ [ci]: body, ...extra }, ci, line);
    });

  bad("a list dash at column 0", "include:\n- remote: https://x/y\n", 2);
  bad("a flow list of flow mappings", 'include: [{remote: "https://x"}]\n', 1);
  bad("a flow list of strings", 'include: [ "https://x" ]\n', 1);
  bad("a flow mapping value", 'include: {remote: "https://x"}\n', 1);
  bad("a flow-style template item", "include:\n  - {template: Jobs/x.yml}\n", 2);
  bad("a flow-style project item", "include: [{project: a/b, ref: main, file: x.yml}]\n", 1);
  bad("a quoted include key", '"include":\n  - remote: https://x\n', 2);
  bad("a quoted item key", 'include:\n  - "remote": "https://x"\n', 2);
  bad("an alias item through an anchor", "x: &a\n  remote: https://x\ninclude:\n  - *a\n", 4);
  bad("a !reference item", "include:\n  - !reference [x, y]\n", 2);
  bad("an unknown item key", "include:\n  - foo: bar\n", 2);
  bad("a ref only nested under rules", `include:\n  - project: a/b\n    file: x.yml\n    rules:\n      - if: $X\n        ref: ${sha}\n`, 2);
  bad("a ref only inside inputs", `include:\n  - project: a/b\n    file: x.yml\n    inputs: {ref: ${sha}}\n`, 2);
  bad("a local glob", "include:\n  - local: ci/*.yml\n", 2, { "ci/a.yml": "x: 1\n" });
  bad("a local with a $VAR", "include:\n  - local: $CI_DIR/a.yml\n", 2);
  bad("a local list", "include:\n  - local: [ci/a.yml]\n", 2, { "ci/a.yml": "x: 1\n" });
  bad("a flow-mapping local item", "include:\n  - {local: ci/a.yml}\n", 2, { "ci/a.yml": "x: 1\n" });
  bad("a local naming a missing file", "include:\n  - local: ci/missing.yml\n", 2);

  it("still follows a plain existing local include: cosign upload inside is caught", () => {
    fails({ [ci]: "include:\n  - local: ci/a.yml\n", "ci/a.yml": "job:\n  script:\n    - cosign sign img\n" }, "ci/a.yml", 3);
  });

  it("still follows a plain existing local include: a remote inside is caught", () => {
    fails({ [ci]: "include:\n  - local: ci/a.yml\n", "ci/a.yml": "include:\n  - remote: https://x/y\n" }, "ci/a.yml", 2);
  });

  it("passes a pinned project with file: as a block list", () => {
    passes({ [ci]: `include:\n  - project: a/b\n    ref: ${sha}\n    file:\n      - x.yml\n      - y.yml\n` });
  });

  it("passes a pinned project with rules:", () => {
    passes({ [ci]: `include:\n  - project: a/b\n    ref: ${sha}\n    file: x.yml\n    rules:\n      - if: $X\n` });
  });

  it("passes a plain existing local include", () => {
    passes({ [ci]: "include:\n  - local: ci/a.yml\n", "ci/a.yml": "job:\n  script:\n    - true\n" });
  });

  it("this repository still passes", () => {
    const result = spawnSync("node", [checker, "--root", worktree], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});

describe("backticks, flock -c and env -C in shell (#1843 review fix round)", () => {
  const sh = (body) => ({ "scripts/s.sh": `#!/usr/bin/env bash\n${body}\n` });

  it("flags cosign sign in an assignment's backticks", () => {
    fails(sh("x=`cosign sign a`"), "scripts/s.sh", 2);
  });

  it("flags a bare backtick line", () => {
    fails(sh("`cosign sign a`"), "scripts/s.sh", 2);
  });

  it("flags flock -c with a double-quoted script", () => {
    fails(sh('flock /l -c "cosign sign x"'), "scripts/s.sh", 2);
  });

  it("flags flock -c with a single-quoted script", () => {
    fails(sh("flock /l -c 'cosign sign x'"), "scripts/s.sh", 2);
  });

  it("flags env -C dir with a variable cosign", () => {
    fails(sh('env -C /tmp "$cosign" sign x'), "scripts/s.sh", 2);
  });

  it("passes each with --tlog-upload=false", () => {
    passes(sh("x=`cosign sign --tlog-upload=false a`"));
    passes(sh("`cosign sign --tlog-upload=false a`"));
    passes(sh('flock /l -c "cosign sign --tlog-upload=false x"'));
    passes(sh("flock /l -c 'cosign sign --tlog-upload=false x'"));
    passes(sh('env -C /tmp "$cosign" sign --tlog-upload=false x'));
  });
});

describe("code-file aliases, absolute paths and sh -c (#1843 review fix round)", () => {
  const f = (body, imp = 'import { execFile, spawn } from "node:child_process";') => ({ "scripts/tool.mjs": `${imp}\n${body}\n` });

  it("flags execFile of an absolute /usr/bin/cosign", () => {
    fails(f('execFile("/usr/bin/cosign", ["sign","x"]);'), "scripts/tool.mjs", 2);
  });

  it("flags execFile of sh -c with a cosign script", () => {
    fails(f('execFile("sh", ["-c", "cosign sign x"]);'), "scripts/tool.mjs", 2);
  });

  it("flags spawn of bash -c with a cosign script", () => {
    fails(f('spawn("bash", ["-c", "cosign sign x"]);'), "scripts/tool.mjs", 2);
  });

  it("flags an aliased import of execFile", () => {
    fails({ "scripts/tool.mjs": 'import { execFile as ef } from "node:child_process";\nef("cosign", ["sign","x"]);\n' }, "scripts/tool.mjs", 2);
  });

  it("passes each with --tlog-upload=false", () => {
    passes(f('execFile("/usr/bin/cosign", ["sign","--tlog-upload=false","x"]);'));
    passes(f('execFile("sh", ["-c", "cosign sign --tlog-upload=false x"]);'));
    passes(f('spawn("bash", ["-c", "cosign sign --tlog-upload=false x"]);'));
    passes({ "scripts/tool.mjs": 'import { execFile as ef } from "node:child_process";\nef("cosign", ["sign","--tlog-upload=false","x"]);\n' });
  });
});

describe("trigger includes (#1843, 37b applied to child pipelines)", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const ci = ".gitlab-ci.yml";
  const trig = (inc) => `job:\n  trigger:\n    include:${inc}\n`;
  const clean = { "ci/b.yml": "job:\n  script:\n    - true\n" };
  const bad = (name, body, line, file = ci, extra = {}) =>
    it(`fails on ${name}`, () => {
      fails({ [ci]: body, ...extra }, file, line);
    });

  bad("a project with ref: main", trig("\n      - project: a/b\n        ref: main\n        file: x.yml"), 4);
  bad("a template:", trig("\n      - template: Jobs/x.yml"), 4);
  bad("a remote:", trig("\n      - remote: https://x/y"), 4);
  bad("a scalar URL", trig(" https://x"), 3);
  bad("a flow mapping", trig(" {remote: https://x}"), 3);
  bad("a flow list", trig(" [ci/b.yml]"), 3, ci, clean);
  bad("an alias", trig(" *x"), 3);
  bad("an alias local item", trig("\n      - local: *x"), 4);
  bad("a scalar naming a missing file", trig(" ci/missing.yml"), 3);
  bad("trigger: {include: ...} flow style", "job:\n  trigger: {include: ci/b.yml}\n", 2, ci, clean);

  it("passes the scalar form naming a clean local file", () => {
    passes({ [ci]: "job:\n  trigger:\n    include: ci/b.yml\n", ...clean });
  });

  it("passes the block form - local: ci/b.yml", () => {
    passes({ [ci]: trig("\n      - local: ci/b.yml"), ...clean });
  });

  it("passes a pinned project under a trigger and prints a not-scanned line", () => {
    const result = run(fixture({ [ci]: trig(`\n      - project: a/b\n        ref: ${sha}\n        file: x.yml`) }));
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout + result.stderr, /not scanned/i);
  });

  it("scans the file reached through the scalar form: cosign sign is caught", () => {
    fails({ [ci]: "job:\n  trigger:\n    include: ci/b.yml\n", "ci/b.yml": "job:\n  script:\n    - cosign sign x\n" }, "ci/b.yml", 3);
  });
});

describe("flow values naming include or trigger (#1843, third review pass)", () => {
  const ci = ".gitlab-ci.yml";
  const clean = { "ci/b.yml": "job:\n  script:\n    - true\n" };
  const bad = (name, body, line, extra = {}) =>
    it(`fails on ${name}`, () => {
      fails({ [ci]: body, ...extra }, ci, line);
    });

  bad("a one-line job with a flow trigger include of a remote", 'job: {trigger: {include: [{remote: "https://x"}]}}\n', 1);
  bad("a one-line job with script and a scalar trigger include", "job: {script: x, trigger: {include: ci/b.yml}}\n", 1, clean);
  bad("an anchored flow job reused by an alias", ".p: &p {trigger: {include: ci/b.yml}}\njob: *p\n", 1, clean);
  bad("a flow variables mapping naming include", "job:\n  variables: {include: x}\n", 2);
  bad("a flow list containing the word include", "x: [include, y]\n", 1);
  bad("a double-quoted trigger scalar", 'trigger: "a/b"\n', 1);
  bad("a URL trigger scalar", "trigger: https://x\n", 1);
  bad("a single-quoted trigger scalar", "trigger: 'a/b'\n", 1);

  it("passes a one-line flow job without include or trigger", () => {
    passes({ [ci]: "job: {script: echo hi}\n" });
  });

  it("passes trigger: group/project", () => {
    passes({ [ci]: "trigger: group/project\n" });
  });

  it("passes a flow variables mapping without the words", () => {
    passes({ [ci]: 'variables: {A: "1"}\n' });
  });

  it("this repository still passes", () => {
    const result = spawnSync("node", [checker, "--root", worktree], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});

describe("escaped quotes and escaped keys in flow values (#1843, review of 5c2b11cf)", () => {
  const ci = ".gitlab-ci.yml";
  const raw = String.raw;

  it("fails when text after an escaped quote hides a trigger include", () => {
    fails({ [ci]: raw`job: {a: "x\"}", trigger: {include: [{remote: "https://x"}]}}` + "\n" }, ci, 1);
  });

  it("passes an escaped quote inside a flow string with nothing risky after it", () => {
    passes({ [ci]: raw`job: {a: "x\"}", b: c}` + "\n" });
  });

  it("fails on escaped-key trigger and include in a flow value", () => {
    fails({ [ci]: raw`job: {"\x74rigger": {"\x69nclude": [{remote: "https://x"}]}}` + "\n" }, ci, 1);
  });

  it("fails on an escaped include key", () => {
    fails({ [ci]: raw`job: {"\x69nclude": x}` + "\n" }, ci, 1);
  });

  it("fails on a key folded across lines with a backslash in a multi-line flow", () => {
    fails({ [ci]: 'job: {"inc\\\nlude": x,\n  b: c}\n' }, ci);
  });

  it("passes a double-quoted flow key with no backslash that does not name include or trigger", () => {
    passes({ [ci]: 'job: {"stage": test}\n' });
  });
});
