/**
 * Ship the fonts' licences with the fonts (#440).
 *
 * OFL-1.1 permits bundling a typeface with software, and Orbit self-hosts
 * three of them (#418) — but only on the condition that each copy carries the
 * copyright notice and the licence text. The woff2 files are emitted into the
 * client bundle by Vite; their LICENSE files are not, so without this the
 * distributed product met none of that condition.
 *
 * Generated from node_modules at build time rather than checked in, so the
 * text cannot drift from the version actually shipped.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PACKAGES = [
  "@fontsource/space-grotesk",
  "@fontsource-variable/inter",
  "@fontsource-variable/jetbrains-mono",
];

const sections = PACKAGES.map((name) => {
  const manifest = require.resolve(`${name}/package.json`);
  const { version } = JSON.parse(readFileSync(manifest, "utf8"));
  const licence = readFileSync(join(dirname(manifest), "LICENSE"), "utf8").trim();
  return `${"=".repeat(72)}\n${name} ${version}\n${"=".repeat(72)}\n\n${licence}\n`;
});

const output = resolve(here, "../static/licenses");
mkdirSync(output, { recursive: true });
writeFileSync(
  join(output, "fonts.txt"),
  "Typefaces bundled with Orbit\n\n"
    + "Orbit self-hosts these faces so that no request leaves your machine to\n"
    + "render a page. They are licensed separately from Orbit itself, under the\n"
    + "SIL Open Font License 1.1, reproduced in full below. Orbit distributes\n"
    + "them unmodified and unrenamed.\n\n"
    + sections.join("\n"),
);
console.log(`fonts.txt written for ${PACKAGES.length} typefaces`);
