import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { themePacks } from "@/lib/preferences";

// The token names v19 defines for every pack (design/v19/home.html,
// design/family/family.css — issue #325). This list is the contract:
// each of the four packs must define exactly this set, no more, no less,
// so no pack silently falls back to an unstyled surface.
const EXPECTED_TOKENS = [
  "--bg", "--panel", "--panel-raised",
  "--line", "--line-soft",
  "--ink", "--ink-mid", "--ink-faint",
  "--accent", "--ok", "--warm", "--overdue", "--upcoming", "--degraded",
  "--sun", "--sun-core", "--stars", "--celestial",
  "--chart-line", "--chart-line-soft", "--chart-ink",
].sort();

const cssPath = fileURLToPath(new URL("./theme-tokens.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

/** Extracts the custom-property names declared inside a `[data-theme="x"]{...}` block. */
function tokensDefinedFor(pack: string): string[] {
  const blockPattern = new RegExp(`\\[data-theme="${pack}"\\]\\s*{([^}]*)}`);
  const match = blockPattern.exec(css);
  if (!match) throw new Error(`No [data-theme="${pack}"] block found in theme-tokens.css`);
  const names = [...match[1].matchAll(/(--[\w-]+)\s*:/g)].map((entry) => entry[1]);
  return [...new Set(names)].sort();
}

describe("theme-tokens.css pack completeness (#325)", () => {
  it("defines a [data-theme] block for every configured theme pack", () => {
    for (const pack of themePacks) {
      expect(css).toMatch(new RegExp(`\\[data-theme="${pack}"\\]`));
    }
  });

  it.each(themePacks)("%s pack defines exactly the v19 token set", (pack) => {
    expect(tokensDefinedFor(pack)).toEqual(EXPECTED_TOKENS);
  });

  it("every pack agrees on the same token names (no pack-specific drift)", () => {
    const tokenSets = themePacks.map((pack) => tokensDefinedFor(pack));
    for (const tokens of tokenSets) {
      expect(tokens).toEqual(tokenSets[0]);
    }
  });
});
