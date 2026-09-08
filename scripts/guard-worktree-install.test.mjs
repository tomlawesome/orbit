import { describe, expect, it } from "vitest";
import { checkWorktreeInstall } from "./guard-worktree-install.mjs";

const mainCheckout = "/home/codex/projects/orbit";
const worktree = "/home/codex/projects/.worktrees/orbit/784-worktree-install";

describe("guard-worktree-install", () => {
  it("allows the main checkout regardless of node_modules", () => {
    const result = checkWorktreeInstall({
      repoDir: mainCheckout,
      gitDir: `${mainCheckout}/.git`,
      gitCommonDir: `${mainCheckout}/.git`,
      nodeModulesPath: `${mainCheckout}/node_modules`,
      realpath: () => `${mainCheckout}/node_modules`,
    });
    expect(result.blocked).toBe(false);
  });

  it("allows a worktree with no node_modules yet", () => {
    const result = checkWorktreeInstall({
      repoDir: worktree,
      gitDir: `${mainCheckout}/.git/worktrees/784-worktree-install`,
      gitCommonDir: `${mainCheckout}/.git`,
      nodeModulesPath: `${worktree}/node_modules`,
      realpath: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(result.blocked).toBe(false);
  });

  it("allows a worktree with its own independent node_modules", () => {
    const result = checkWorktreeInstall({
      repoDir: worktree,
      gitDir: `${mainCheckout}/.git/worktrees/784-worktree-install`,
      gitCommonDir: `${mainCheckout}/.git`,
      nodeModulesPath: `${worktree}/node_modules`,
      realpath: () => `${worktree}/node_modules`,
    });
    expect(result.blocked).toBe(false);
  });

  it("blocks a worktree whose node_modules resolves into the main checkout", () => {
    const result = checkWorktreeInstall({
      repoDir: worktree,
      gitDir: `${mainCheckout}/.git/worktrees/784-worktree-install`,
      gitCommonDir: `${mainCheckout}/.git`,
      nodeModulesPath: `${worktree}/node_modules`,
      realpath: () => `${mainCheckout}/node_modules`,
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/#784/u);
  });

  it("blocks a worktree whose node_modules resolves into a different worktree", () => {
    const otherWorktree = "/home/codex/projects/.worktrees/orbit/other-branch";
    const result = checkWorktreeInstall({
      repoDir: worktree,
      gitDir: `${mainCheckout}/.git/worktrees/784-worktree-install`,
      gitCommonDir: `${mainCheckout}/.git`,
      nodeModulesPath: `${worktree}/node_modules`,
      realpath: () => `${otherWorktree}/node_modules`,
    });
    expect(result.blocked).toBe(true);
  });
});
