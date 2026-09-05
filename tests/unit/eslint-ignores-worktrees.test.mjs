import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * #769: `pnpm lint` walked into `.claude/worktrees/` and linted a second
 * checkout of the codebase, so another branch's errors were reported as this
 * one's -- 352 of them in a tree whose own files were clean. Only the machine
 * that has worktrees sees it, which is why it survived: a CI checkout has
 * none.
 *
 * The ignore is by directory, never by worktree name, so a session that
 * creates a new worktree needs no config change. This test asserts that
 * shape: an invented worktree name is ignored, and a real project path with
 * the same file extension is not.
 */
describe("the ESLint config ignores sibling worktrees", () => {
  const eslint = new ESLint();

  // `new ESLint()` is cheap; the first `isPathIgnored` call is what loads
  // eslint.config.js and every plugin it imports. On a runner sharing its CPU
  // with the rest of the pipeline that outran vitest's 5 s default (#817), so
  // the one-off load gets its own budget here and the cases stay fast.
  beforeAll(async () => {
    await eslint.isPathIgnored("src/lib/install-orchestrator.ts");
  }, 30_000);

  it("ignores any worktree under .claude/worktrees, whatever it is called", async () => {
    for (const path of [
      ".claude/worktrees/a-branch-nobody-has-created-yet/src/lib/config.ts",
      ".claude/worktrees/475-backdrops/web/src/routes/home/home.behaviour.js",
      ".claude/worktrees/anything/web/.svelte-kit/generated/root.svelte",
    ]) {
      expect(await eslint.isPathIgnored(path), path).toBe(true);
    }
  });

  it("still lints the project's own files", async () => {
    for (const path of [
      "src/lib/install-orchestrator.ts",
      "web/src/routes/home/home.behaviour.js",
      "scripts/engine-runtime-deps-contract.test.mjs",
    ]) {
      expect(await eslint.isPathIgnored(path), path).toBe(false);
    }
  });
});
