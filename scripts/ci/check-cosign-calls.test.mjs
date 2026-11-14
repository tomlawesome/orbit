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
    fails({ "scripts/ci/x.sh": "#!/usr/bin/env bash\nexport OTEL_TRACES_EXPORTER=otlp\n" }, "scripts/ci/x.sh", 2);
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
