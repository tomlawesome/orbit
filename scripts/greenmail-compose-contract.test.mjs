import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #1489: the acceptance stack's mail sidecar is built from tests/greenmail
// (the pinned upstream image with the leaked roots removed), not pulled.
// Static: reads the compose text and the policy JSON, no Docker.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8").replaceAll("\r\n", "\n");

const compose = read("compose/docker-compose.acceptance.yml");

function serviceBlock(name) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`Service ${name} is not declared`);
  const rest = compose.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[A-Za-z][\w-]*:\n|\n[A-Za-z]/u);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

const uncommented = (text) => text.replace(/^\s*#.*$/gmu, "");

describe("orbit-greenmail build (#1489)", () => {
  const block = uncommented(serviceBlock("orbit-greenmail"));

  it("has no image: key", () => {
    expect(block).not.toMatch(/^\s+image:/mu);
  });

  it("builds ./tests/greenmail", () => {
    expect(block).toMatch(/^\s+build:\s*\n\s+context:\s*["']?\.\/tests\/greenmail\/?["']?\s*$/mu);
  });

  it("derives FROM the digest the supply-chain policy pins", () => {
    const policy = JSON.parse(read(".github/supply-chain-policy.json"));
    const entry = JSON.stringify(policy).match(/greenmail\/standalone:[0-9.]+@sha256:[0-9a-f]{64}/u)?.[0];
    expect(entry).toBeTruthy();

    const dockerfile = read("tests/greenmail/Dockerfile");
    const from = dockerfile.match(/^FROM\s+(\S+)/mu)?.[1];
    expect(from).toBe(entry);
  });

  it("is listed in the policy at the Dockerfile, not the compose file", () => {
    const policy = JSON.parse(read(".github/supply-chain-policy.json"));
    const found = [];
    const walk = (node) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        if (typeof node.reference === "string" && node.reference.startsWith("greenmail/standalone:")) found.push(node);
        Object.values(node).forEach(walk);
      }
    };
    walk(policy);
    expect(found).toHaveLength(1);
    expect(found[0].locations).toEqual(["tests/greenmail/Dockerfile"]);
  });
});
