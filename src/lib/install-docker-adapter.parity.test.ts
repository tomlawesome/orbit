import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { APP_READINESS_PROBE, OIDC_DISCOVERY_PARSER, TIKA_READINESS_PROBE } from "./install-docker-adapter";

// Byte-for-byte parity between the embedded Node source strings this
// adapter ships (issue #295 slice 5) and the real, unmodified
// scripts/install.sh (`app_readiness_probe`, `tika_readiness_probe`,
// `oidc_discovery_parser`, install.sh:21-56, guarantees #27,#34). These are
// the exact bytes the resolved Orbit image's own container runs — a
// behavioural (bash-vs-TS) comparison doesn't apply the way it does for a
// ported *decision function*; instead this is exactly the byte-compare-
// literal strategy the task's rigor requirements call for. Extraction fails
// loudly (empty match) if any cited `readonly` name is ever renamed.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const installScriptPath = join(repoRoot, "scripts", "install.sh");

function extractReadonlyBlock(name: string, endLineExact: string): string {
  const script = `
    $0 ~ "^readonly ${name}=" { found = 1 }
    found { print; if ($0 == "${endLineExact}") { found = 0; exit } }
  `;
  const result = spawnSync("awk", [script, installScriptPath], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not extract readonly ${name} from install.sh; it may have been renamed or reshaped.`);
  }
  return result.stdout;
}

function extractSingleQuotedSource(name: string, endLineExact: string): string {
  const raw = extractReadonlyBlock(name, endLineExact);
  const lines = raw.replace(/\n$/, "").split("\n");
  lines[0] = lines[0].replace(new RegExp(`^readonly ${name}='`), "");
  const lastIndex = lines.length - 1;
  lines[lastIndex] = lines[lastIndex].replace(/'$/, "");
  return lines.join("\n");
}

describe("embedded Node-source parity (install.sh:21-56)", () => {
  it("app_readiness_probe agrees byte-for-byte (guarantee #34)", () => {
    expect(APP_READINESS_PROBE).toBe(extractSingleQuotedSource("app_readiness_probe", "  .catch(() => process.exit(1));'"));
  });

  it("tika_readiness_probe agrees byte-for-byte", () => {
    expect(TIKA_READINESS_PROBE).toBe(extractSingleQuotedSource("tika_readiness_probe", "  .catch(() => process.exit(1));'"));
  });

  it("oidc_discovery_parser agrees byte-for-byte (guarantee #27)", () => {
    expect(OIDC_DISCOVERY_PARSER).toBe(extractSingleQuotedSource("oidc_discovery_parser", "}'"));
  });
});
