import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  summarizeFindings,
  validateReport,
  validateSupplyChainPolicy,
  vulnerabilityFinding,
} from "./supply-chain-policy.mjs";

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function slugForTag(tag) {
  return tag.toLowerCase().replace(/[^a-z0-9]/gu, "-");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is missing or invalid JSON.`);
  }
}

function readScanReport(scansDir, entry) {
  const path = join(scansDir, `${slugForTag(entry.tag)}.json`);
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Scan report for ${entry.tag} is missing or invalid JSON.`);
  }
  try {
    validateReport(report);
  } catch {
    throw new Error(`Scan report for ${entry.tag} is missing or invalid JSON.`);
  }
  return report;
}

function writeEvidence(path, evidence) {
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

export function listContainerImageReferences(policy) {
  return policy.containerImages.map((entry) => ({
    slug: slugForTag(entry.tag),
    reference: entry.reference,
  }));
}

export function evaluateSidecarImageEvidence({
  policy,
  scansDir,
  revision,
  now = new Date().toISOString().slice(0, 10),
}) {
  validateSupplyChainPolicy(policy, now);
  requiredString(scansDir, "Scans directory");
  if (!/^[0-9a-f]{40}$/u.test(revision ?? "")) {
    throw new Error("Sidecar image evidence requires a valid source revision.");
  }
  const images = policy.containerImages.map((entry) => {
    const report = readScanReport(scansDir, entry);
    const vulnerabilities = [];
    for (const result of report.Results) {
      const target = typeof result?.Target === "string" ? result.Target : "";
      for (const vulnerability of result?.Vulnerabilities ?? []) {
        vulnerabilities.push(vulnerabilityFinding(vulnerability, target));
      }
    }
    const review = summarizeFindings(vulnerabilities, "imageVulnerabilities", policy, "image");
    return {
      name: entry.name,
      tag: entry.tag,
      reference: entry.reference,
      findings: review.findings,
      blocked: review.blocked,
      excepted: review.excepted,
    };
  });
  return {
    schemaVersion: 1,
    revision,
    generatedAt: now,
    images,
  };
}

function blockedSeverityCounts(findings) {
  const counts = new Map();
  for (const finding of findings) {
    if (finding.policy !== "blocked") continue;
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  return [...counts.entries()].map(([severity, count]) => `${count} ${severity}`).join(", ");
}

function parseArguments(arguments_) {
  const [mode, ...rest] = arguments_;
  if (mode !== "--list-references" && mode !== "evaluate") {
    throw new Error("Sidecar image evidence command must be --list-references or evaluate.");
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Sidecar image evidence arguments must use --name value pairs.");
    }
    options[flag.slice(2)] = value;
  }
  return { mode, options };
}

function runCli() {
  const { mode, options } = parseArguments(process.argv.slice(2));
  const policyPath = options.policy ?? ".github/supply-chain-policy.json";
  const policy = readJson(policyPath, "Supply-chain policy");
  const now = new Date().toISOString().slice(0, 10);

  if (mode === "--list-references") {
    validateSupplyChainPolicy(policy, now);
    for (const { slug, reference } of listContainerImageReferences(policy)) {
      process.stdout.write(`${slug} ${reference}\n`);
    }
    return;
  }

  const evidence = evaluateSidecarImageEvidence({
    policy,
    scansDir: requiredString(options.scans, "Scans directory"),
    revision: requiredString(options.revision, "Revision"),
    now,
  });
  writeEvidence(requiredString(options.output, "Sidecar image evidence path"), evidence);

  const blockedImages = evidence.images.filter((image) => image.blocked > 0);
  if (blockedImages.length > 0) {
    for (const image of blockedImages) {
      process.stderr.write(
        `${image.tag}: ${image.blocked} blocked finding(s) (${blockedSeverityCounts(image.findings)})\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Sidecar image supply-chain policy passed for ${evidence.images.length} image(s).\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Sidecar image evidence failed."}\n`,
    );
    process.exitCode = 1;
  }
}
