import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/*
 * ADR-0028 slice 2 (#1060). The content ID is what every image job's reuse key
 * will be built on, so what is pinned here is the derivation itself: that the
 * stamp layer is excluded and nothing else is, that the encoding is stable
 * enough for two runs to agree, and that a misread `docker image inspect`
 * fails loudly instead of producing a plausible hash over nothing.
 *
 * Driven as a subprocess against a stub `docker` on PATH, because that is how
 * `build_image` calls it and because the real thing needs a built image.
 */
const script = new URL("./image-content-id.sh", import.meta.url).pathname;

const directories = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

function digest(seed) {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

/** The ID the script must produce: the retained digests, one per line, hashed. */
function expected(layers) {
  return createHash("sha256")
    .update(layers.map((layer) => `${layer}\n`).join(""))
    .digest("hex");
}

/** A workspace holding a stub `docker` that answers with `layers`. */
function workspace(layers) {
  const directory = mkdtempSync(join(tmpdir(), "orbit-content-id-"));
  directories.push(directory);
  const stub = join(directory, "docker");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > "${join(directory, "argv")}"`,
      `cat "${join(directory, "layers")}"`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(stub, 0o755);
  writeFileSync(join(directory, "layers"), layers.map((layer) => `${layer}\n`).join(""), "utf8");
  return directory;
}

function run(directory, environment = {}) {
  return execFileSync("bash", [script], {
    encoding: "utf8",
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      ORBIT_IMAGE_REF: "orbit:ci",
      ...environment,
    },
  }).trim();
}

describe("the image content ID", () => {
  it("hashes the ordered content layers and excludes the stamp", () => {
    const layers = [digest("base"), digest("app"), digest("stamp")];
    expect(run(workspace(layers))).toBe(expected(layers.slice(0, -1)));
  });

  it("asks the daemon for the named image's RootFS layers", () => {
    const directory = workspace([digest("base"), digest("stamp")]);
    run(directory, { ORBIT_IMAGE_REF: "registry.example/orbit:1" });
    const argv = readFileSync(join(directory, "argv"), "utf8").split("\n");
    expect(argv).toContain("image");
    expect(argv).toContain("inspect");
    expect(argv).toContain("registry.example/orbit:1");
    expect(argv.join(" ")).toContain("RootFS.Layers");
  });

  it("is the same for two builds that differ only in the stamp", () => {
    const content = [digest("base"), digest("app")];
    const first = run(workspace([...content, digest("stamp of commit one")]));
    const second = run(workspace([...content, digest("stamp of commit two")]));
    expect(second).toBe(first);
  });

  it("changes when any content layer changes", () => {
    const stamp = digest("stamp");
    const first = run(workspace([digest("base"), digest("app"), stamp]));
    const second = run(workspace([digest("base"), digest("app with one file changed"), stamp]));
    expect(second).not.toBe(first);
  });

  it("changes when two content layers swap order", () => {
    const [base, app, stamp] = [digest("base"), digest("app"), digest("stamp")];
    expect(run(workspace([app, base, stamp]))).not.toBe(run(workspace([base, app, stamp])));
  });

  it("hands the ID to $GITHUB_OUTPUT when the pipeline sets one", () => {
    const directory = workspace([digest("base"), digest("app"), digest("stamp")]);
    const output = join(directory, "step-outputs");
    writeFileSync(output, "", "utf8");
    const id = run(directory, { GITHUB_OUTPUT: output });
    expect(readFileSync(output, "utf8")).toBe(`content_id=${id}\n`);
  });

  it("refuses an image whose only layer is the stamp", () => {
    expect(() => run(workspace([digest("stamp")]))).toThrow(/layer\(s\)/);
  });

  it("refuses an answer that is not a layer digest", () => {
    expect(() => run(workspace([digest("base"), "<no value>"]))).toThrow(/not a layer digest/);
  });

  it("refuses to run without an image", () => {
    expect(() => run(workspace([digest("base"), digest("stamp")]), { ORBIT_IMAGE_REF: "" })).toThrow();
  });
});
