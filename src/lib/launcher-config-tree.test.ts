import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyHostOwnership } from "./host-ownership";
import { LAUNCHER_CONFIG_TREE_ASSETS, handOverLauncherConfigTree } from "./launcher-config-tree";

// Wraps the real function, so ownership is still applied; the spy only records
// which paths the tree writer handed over.
vi.mock("./host-ownership", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./host-ownership")>();
  return { ...actual, applyHostOwnership: vi.fn(actual.applyHostOwnership) };
});

// The launcher's configure tree, written by the install engine on a
// configuration-failure exit (#1225; #1212 amendment note 30988). These are
// the rules install.sh's launcher_tree_write held, now proven here.

const REFERENCE = `ghcr.io/tomlawesome/orbit@sha256:${"a".repeat(64)}`;
const scratch: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(applyHostOwnership).mockClear();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbit-launcher-tree-test-"));
  scratch.push(dir);
  return dir;
}

function assets(): string {
  const root = sandbox();
  for (const asset of LAUNCHER_CONFIG_TREE_ASSETS) {
    mkdirSync(dirname(join(root, asset)), { recursive: true });
    writeFileSync(join(root, asset), `bundled ${asset}\n`, { mode: 0o644 });
  }
  return root;
}

function emptyTree(): string {
  const tree = join(sandbox(), "tree");
  mkdirSync(tree, { mode: 0o700 });
  chmodSync(tree, 0o700);
  return tree;
}

function handOver(tree: string | undefined, extra: { unavailableReason?: string; assetsRoot?: string } = {}) {
  const notices: string[] = [];
  const result = handOverLauncherConfigTree({
    tree,
    unavailableReason: extra.unavailableReason,
    assetsRoot: extra.assetsRoot ?? assets(),
    imageReference: REFERENCE,
    notice: (line) => notices.push(line),
  });
  return { result, notices };
}

/** Every entry under root (not root itself), as paths relative to it, directories included; never follows a symlink. */
function walk(root: string, relative = ""): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(root, relative)).sort()) {
    const entry = join(relative, name);
    found.push(entry);
    if (lstatSync(join(root, entry)).isDirectory()) found.push(...walk(root, entry));
  }
  return found;
}

describe("handOverLauncherConfigTree (#1225)", () => {
  it("writes the image's three files and the image pin, owner-only, with an owner-only scripts directory", () => {
    const root = assets();
    const tree = emptyTree();
    const { result, notices } = handOver(tree, { assetsRoot: root });
    expect(result).toBe("written");
    expect(notices).toEqual([]);
    expect(readdirSync(tree).sort()).toEqual([".env-orbit.example", ".orbit-image", "scripts"]);
    expect(readdirSync(join(tree, "scripts")).sort()).toEqual(["configure.sh", "installer-ui.sh"]);
    for (const asset of LAUNCHER_CONFIG_TREE_ASSETS) {
      expect(readFileSync(join(tree, asset))).toEqual(readFileSync(join(root, asset)));
      expect(statSync(join(tree, asset)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(tree, ".orbit-image"), "utf8")).toBe(`${REFERENCE}\n`);
    expect(statSync(join(tree, ".orbit-image")).mode & 0o777).toBe(0o600);
    expect(statSync(join(tree, "scripts")).mode & 0o777).toBe(0o700);
  });

  // The pinned launcher (v0.4.0, internal/deploy/trusted.go) refuses the tree
  // unless every entry belongs to the uid that owns the tree root, none is
  // world-writable and none is a symlink; and .orbit-image is one exact line.
  it("hands every file and directory to the host user, with no symlink or world-write, and pins the image on one line", () => {
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    vi.stubEnv("ORBIT_HOST_UID", String(uid));
    vi.stubEnv("ORBIT_HOST_GID", String(gid));
    const tree = emptyTree();
    const { result, notices } = handOver(tree);
    expect(result).toBe("written");
    expect(notices).toEqual([]);

    const entries = walk(tree);
    expect(entries).toEqual([".env-orbit.example", ".orbit-image", "scripts", join("scripts", "configure.sh"), join("scripts", "installer-ui.sh")]);
    expect(entries.filter((entry) => !lstatSync(join(tree, entry)).isDirectory()).sort()).toEqual(
      [".env-orbit.example", ".orbit-image", "scripts/configure.sh", "scripts/installer-ui.sh"].sort(),
    );

    const rootOwner = lstatSync(tree).uid;
    expect(rootOwner).toBe(uid);
    for (const entry of entries) {
      const stat = lstatSync(join(tree, entry));
      expect(stat.isSymbolicLink(), entry).toBe(false);
      expect(stat.uid, `${entry} uid`).toBe(rootOwner);
      expect(stat.uid, `${entry} uid`).toBe(uid);
      expect(stat.gid, `${entry} gid`).toBe(gid);
      expect(stat.mode & 0o002, `${entry} world-write`).toBe(0);
      expect(stat.mode & 0o777, `${entry} mode`).toBe(stat.isDirectory() ? 0o700 : 0o600);
    }

    // The test cannot chown to anyone else, so also prove each written path,
    // directories included, was handed to the ownership function.
    const handed = vi.mocked(applyHostOwnership).mock.calls.map(([path]) => path).sort();
    expect(handed).toEqual(entries.map((entry) => join(tree, entry)).sort());

    expect(readFileSync(join(tree, ".orbit-image"), "utf8")).toBe(`${REFERENCE}\n`);
  });

  it("writes owner-only files even under umask 000", () => {
    const previous = process.umask(0);
    try {
      const tree = emptyTree();
      expect(handOver(tree).result).toBe("written");
      expect(statSync(join(tree, "scripts")).mode & 0o777).toBe(0o700);
      expect(statSync(join(tree, ".orbit-image")).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it("does nothing, silently, when the launcher set nothing", () => {
    expect(handOver(undefined)).toEqual({ result: "not-requested", notices: [] });
    expect(handOver("")).toEqual({ result: "not-requested", notices: [] });
  });

  it.each(["it is a symlink", "it does not exist", "it is not a directory", "it could not be entered"])(
    "says once why install.sh could not mount it: %s",
    (reason) => {
      expect(handOver(undefined, { unavailableReason: reason })).toEqual({
        result: "refused",
        notices: [`Orbit installer: ORBIT_LAUNCHER_CONFIG_TREE was not written because ${reason}.`],
      });
    },
  );

  it("never echoes a reason the shell has no business sending", () => {
    expect(handOver(undefined, { unavailableReason: "$(rm -rf /)" }).notices).toEqual([
      "Orbit installer: ORBIT_LAUNCHER_CONFIG_TREE was not written because it could not be entered.",
    ]);
  });

  it.each([
    {
      name: "not empty",
      reason: "it is not empty",
      arrange: (tree: string) => writeFileSync(join(tree, ".launcher-own"), "KEEP\n"),
      left: [".launcher-own"],
    },
    { name: "not mode 0700", reason: "it is not mode 0700", arrange: (tree: string) => chmodSync(tree, 0o755), left: [] },
    {
      name: "owned by another user",
      reason: "it is not owned by the current user",
      arrange: () => {
        vi.stubEnv("ORBIT_HOST_UID", String((process.getuid?.() ?? 0) + 1));
        vi.stubEnv("ORBIT_HOST_GID", "0");
      },
      left: [],
    },
  ])("refuses a directory that is $name, writing nothing", ({ reason, arrange, left }) => {
    const tree = emptyTree();
    arrange(tree);
    const { result, notices } = handOver(tree);
    expect(result).toBe("refused");
    expect(notices).toEqual([`Orbit installer: ORBIT_LAUNCHER_CONFIG_TREE was not written because ${reason}.`]);
    expect(readdirSync(tree)).toEqual(left);
  });

  it("refuses a symlinked directory without writing through it", () => {
    const real = emptyTree();
    const link = join(sandbox(), "link");
    symlinkSync(real, link);
    expect(handOver(link).notices).toEqual(["Orbit installer: ORBIT_LAUNCHER_CONFIG_TREE was not written because it is a symlink."]);
    expect(readdirSync(real)).toEqual([]);
  });

  it("refuses, writing nothing, when the image's copies cannot be read", () => {
    const root = assets();
    rmSync(join(root, "scripts", "installer-ui.sh"));
    const tree = emptyTree();
    expect(handOver(tree, { assetsRoot: root }).notices).toEqual([
      "Orbit installer: ORBIT_LAUNCHER_CONFIG_TREE was not written because the verified copies are unavailable.",
    ]);
    expect(readdirSync(tree)).toEqual([]);
  });

  function handOverWith(tree: string, beforeWrite: (asset: string) => void) {
    const notices: string[] = [];
    const result = handOverLauncherConfigTree({
      tree,
      assetsRoot: assets(),
      imageReference: REFERENCE,
      notice: (line) => notices.push(line),
      beforeWrite,
    });
    return { result, notices };
  }

  it("removes everything it wrote when one copy fails, and says so once", () => {
    const tree = emptyTree();
    const { result, notices } = handOverWith(tree, (asset) => {
      if (asset === "scripts/installer-ui.sh") throw new Error("copy failed");
    });
    expect(result).toBe("refused");
    expect(notices).toEqual(["Orbit installer: ORBIT_LAUNCHER_CONFIG_TREE was not written because scripts/installer-ui.sh could not be written."]);
    expect(readdirSync(tree)).toEqual([]);
  });

  it("refuses the whole hand-over when .orbit-image appears mid-copy, never writing over it, and says so once", () => {
    const tree = emptyTree();
    const { result, notices } = handOverWith(tree, (asset) => {
      if (asset === ".orbit-image") writeFileSync(join(tree, ".orbit-image"), "PLANTED\n");
    });
    expect(result).toBe("refused");
    expect(notices).toEqual(["Orbit installer: ORBIT_LAUNCHER_CONFIG_TREE was not written because .orbit-image could not be written."]);
    expect(readdirSync(tree)).toEqual([]);
  });
});
