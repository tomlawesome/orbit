// pnpm's own `preinstall` lifecycle hook (wired from package.json), run
// before pnpm links or writes anything else. This is the actual prevention
// for #784: an explicit `pnpm install` run with a git worktree as the
// working directory, whose `node_modules` a person or agent has symlinked to
// the main checkout's (the documented convenience so one install serves
// every worktree), rewrites `node_modules/.pnpm-workspace-state-v1.json` --
// physically the MAIN CHECKOUT's copy, reached through the symlink -- to
// record the WORKTREE's absolute paths as the workspace it belongs to. That
// happens even on a no-op install ("Already up to date"): pnpm always
// re-stamps that file with the cwd-derived project paths it just resolved.
// Nothing else changes yet, so the checkout still looks healthy -- but the
// next `pnpm install` run from the main checkout now finds its own
// node_modules recorded as belonging to a different workspace root and
// reconciles by relinking, which is what turns into the symlinks-into-
// worktree corruption #784 originally reported.
//
// `verifyDepsBeforeRun` (pnpm-workspace.yaml, #874) does not cover this: it
// only guards pnpm auto-installing before a *run*/*exec*, not an explicit
// `pnpm install`. This hook is the guard for the explicit command.
//
// Scope: only a worktree whose node_modules resolves OUTSIDE itself is
// dangerous. A worktree with no node_modules yet, or with its own real one,
// installs independently through pnpm's shared content-addressable store
// (already the default, already safe -- packages are hard-linked, not
// re-downloaded) and is left alone.
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// Pure so it can be unit-tested without real git worktrees or symlinks.
export function checkWorktreeInstall({ repoDir, gitDir, gitCommonDir, nodeModulesPath, realpath }) {
  const inWorktree = gitDir !== gitCommonDir;
  if (!inWorktree) {
    return { blocked: false, reason: "not a worktree" };
  }

  let target;
  try {
    target = realpath(nodeModulesPath);
  } catch {
    return { blocked: false, reason: "no node_modules yet -- a fresh install here is self-contained" };
  }

  const withinRepo = target === repoDir || target.startsWith(`${repoDir}/`);
  if (withinRepo) {
    return { blocked: false, reason: "node_modules belongs to this worktree" };
  }

  return {
    blocked: true,
    reason:
      `node_modules resolves to ${target}, outside this worktree (${repoDir}). ` +
      "Installing here would rewrite that shared node_modules's workspace-state " +
      "metadata to point at this worktree instead (AGENTS.md worktree-install " +
      "trap, #784) -- silently, until the next install from the main checkout " +
      "reconciles and breaks its own build. Run `pnpm install` from the main " +
      "checkout, not from this worktree.",
  };
}

function main() {
  let gitDir;
  let gitCommonDir;
  try {
    gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"], repositoryRoot);
    gitCommonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repositoryRoot);
  } catch {
    // Not a git checkout (the Dockerfile deps stage copies package.json and
    // this script without .git, and the image has no git): nothing to guard.
    return;
  }
  const nodeModulesPath = resolve(repositoryRoot, "node_modules");

  const realpath = (p) => {
    // realpathSync throws on a missing target; also treat a plain missing
    // path (no node_modules at all yet) the same way via lstatSync first,
    // so a dangling symlink is reported honestly rather than swallowed.
    lstatSync(p);
    return realpathSync(p);
  };

  const result = checkWorktreeInstall({
    repoDir: repositoryRoot.replace(/\/$/u, ""),
    gitDir,
    gitCommonDir,
    nodeModulesPath,
    realpath,
  });

  if (result.blocked) {
    process.stderr.write(`guard-worktree-install: refusing pnpm install: ${result.reason}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
