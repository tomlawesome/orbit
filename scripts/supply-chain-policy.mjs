import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEVERITIES = new Set(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function validDate(value, label) {
  const date = requiredString(value, label);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !DATE_PATTERN.test(date) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`${label} must be an ISO date.`);
  }
  return date;
}

function requireLiveDate(value, label, now) {
  const date = validDate(value, label);
  if (date < now) {
    throw new Error(`${label} expired on ${date}.`);
  }
  return date;
}

function requireTrackingIssue(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} requires a positive tracking issue number.`);
  }
}

function validateTool(tool, label, now, { image = false } = {}) {
  requiredString(tool?.name, `${label} name`);
  requiredString(tool?.version, `${label} version`);
  requiredString(tool?.license, `${label} licence`);
  const source = requiredString(tool?.source, `${label} source`);
  if (!source.startsWith("https://")) {
    throw new Error(`${label} source must use HTTPS.`);
  }
  requiredString(tool?.updateOwner, `${label} update owner`);
  requireLiveDate(tool?.reviewBy, `${label} review`, now);
  if (image && !/^[^@\s]+@sha256:[0-9a-f]{64}$/u.test(tool?.image ?? "")) {
    throw new Error(`${label} image must be pinned to a full sha256 digest.`);
  }
  if (!image && !/^[0-9a-f]{40}$/u.test(tool?.commit ?? "")) {
    throw new Error(`${label} action must be pinned to a full commit.`);
  }
}

function validateThresholds(thresholds) {
  for (const key of [
    "sourceVulnerabilities",
    "sourceSecrets",
    "imageVulnerabilities",
  ]) {
    const values = thresholds?.[key];
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`${key} must contain at least one severity.`);
    }
    for (const severity of values) {
      if (!SEVERITIES.has(severity)) {
        throw new Error(`${key} contains unsupported severity ${severity}.`);
      }
    }
  }
}

function validateException(exception, index, now) {
  const label = `Exception ${index + 1}`;
  if (exception?.kind !== "vulnerability") {
    throw new Error(`${label} may cover only a vulnerability; secret findings cannot be excepted.`);
  }
  if (!["source", "image"].includes(exception?.scope)) {
    throw new Error(`${label} has an unsupported scope.`);
  }
  requiredString(exception.id, `${label} finding id`);
  requiredString(exception.package, `${label} package`);
  requiredString(exception.owner, `${label} owner`);
  requiredString(exception.rationale, `${label} rationale`);
  requireLiveDate(exception.expiresOn, `${label} expiry`, now);
  requireTrackingIssue(exception.trackingIssue, label);
}

function validateContainerImage(entry, index, now) {
  const label = `Container image ${index + 1}`;
  requiredString(entry?.name, `${label} name`);
  const tag = requiredString(entry?.tag, `${label} tag`);
  const reference = requiredString(entry?.reference, `${label} reference`);
  const separator = reference.lastIndexOf("@");
  const digest = separator === -1 ? "" : reference.slice(separator + 1);
  if (separator === -1 || !DIGEST_PATTERN.test(digest)) {
    throw new Error(`${label} reference must be pinned to a full sha256 digest.`);
  }
  if (reference !== `${tag}@${digest}`) {
    throw new Error(`${label} tag and pinned reference must identify the same image.`);
  }
  if (!DIGEST_PATTERN.test(entry?.indexDigest ?? "")) {
    throw new Error(`${label} index digest must be a full sha256 digest.`);
  }
  if (entry?.platform !== "linux/amd64") {
    throw new Error(`${label} platform must be linux/amd64.`);
  }
  if (
    !Array.isArray(entry?.locations) ||
    entry.locations.length === 0 ||
    entry.locations.some((location) => typeof location !== "string" || location.trim() === "")
  ) {
    throw new Error(`${label} requires at least one location.`);
  }
  if (new Set(entry.locations).size !== entry.locations.length) {
    throw new Error(`${label} locations must be unique.`);
  }
  for (const key of ["source", "registry", "licenseSource"]) {
    const value = requiredString(entry?.[key], `${label} ${key}`);
    if (!value.startsWith("https://")) {
      throw new Error(`${label} ${key} must use HTTPS.`);
    }
  }
  requiredString(entry?.license, `${label} licence`);
  requiredString(entry?.updateOwner, `${label} update owner`);
  const resolvedOn = validDate(entry?.resolvedOn, `${label} resolution date`);
  if (resolvedOn > now) {
    throw new Error(`${label} resolution date cannot be in the future.`);
  }
  requireLiveDate(entry?.reviewBy, `${label} review`, now);
}

export function validateSupplyChainPolicy(policy, now = new Date().toISOString().slice(0, 10)) {
  const currentDate = validDate(now, "Policy evaluation date");
  if (policy?.schemaVersion !== 1) {
    throw new Error("Supply-chain policy schemaVersion must be 1.");
  }
  validateTool(policy.scanner, "Scanner", currentDate, { image: true });
  if (!Array.isArray(policy.attestationActions) || policy.attestationActions.length === 0) {
    throw new Error("At least one reviewed attestation action is required.");
  }
  policy.attestationActions.forEach((tool, index) =>
    validateTool(tool, `Attestation action ${index + 1}`, currentDate),
  );
  if (
    !Array.isArray(policy.dependencyReviewActions) ||
    policy.dependencyReviewActions.length === 0
  ) {
    throw new Error("At least one reviewed dependency action is required.");
  }
  policy.dependencyReviewActions.forEach((tool, index) =>
    validateTool(tool, `Dependency review action ${index + 1}`, currentDate),
  );
  validateThresholds(policy.thresholds);
  if (!Array.isArray(policy.exceptions)) {
    throw new Error("Supply-chain exceptions must be an array.");
  }
  policy.exceptions.forEach((exception, index) =>
    validateException(exception, index, currentDate),
  );
  if (!Array.isArray(policy.containerImages) || policy.containerImages.length === 0) {
    throw new Error("At least one reviewed container image is required.");
  }
  policy.containerImages.forEach((entry, index) =>
    validateContainerImage(entry, index, currentDate),
  );
  if (
    new Set(policy.containerImages.map((entry) => entry.reference)).size !==
    policy.containerImages.length
  ) {
    throw new Error("Pinned container image references must be unique.");
  }
  if (!Array.isArray(policy.mutableImageReferences)) {
    throw new Error("Mutable image references must be an array.");
  }
  if (policy.mutableImageReferences.length !== 0) {
    throw new Error("Mutable image references are not permitted.");
  }
  return {
    scannerVersion: policy.scanner.version,
    dependencyReviewActionCount: policy.dependencyReviewActions.length,
    exceptionCount: policy.exceptions.length,
    pinnedImageCount: policy.containerImages.length,
    mutableReferenceCount: 0,
  };
}

export function validateReport(report) {
  if (report?.SchemaVersion !== 2 || !Array.isArray(report.Results)) {
    throw new Error("Trivy report schema is missing or unsupported.");
  }
}

function normalizedSeverity(value) {
  const severity = typeof value === "string" ? value.toUpperCase() : "UNKNOWN";
  return SEVERITIES.has(severity) ? severity : "UNKNOWN";
}

function matchingException(policy, finding, scope) {
  return policy.exceptions.find(
    (exception) =>
      exception.kind === finding.kind &&
      exception.scope === scope &&
      exception.id === finding.id &&
      (exception.package === undefined || exception.package === finding.package) &&
      (exception.installedVersion === undefined ||
        exception.installedVersion === finding.installedVersion) &&
      (exception.target === undefined || exception.target === finding.target),
  );
}

export function vulnerabilityFinding(vulnerability, target) {
  return {
    kind: "vulnerability",
    id: requiredString(vulnerability?.VulnerabilityID, "Vulnerability id"),
    severity: normalizedSeverity(vulnerability?.Severity),
    target,
    package: requiredString(vulnerability?.PkgName, "Vulnerability package"),
    installedVersion:
      typeof vulnerability?.InstalledVersion === "string"
        ? vulnerability.InstalledVersion
        : "",
    fixedVersion:
      typeof vulnerability?.FixedVersion === "string" ? vulnerability.FixedVersion : "",
  };
}

function secretFinding(secret, target) {
  return {
    kind: "secret",
    id: requiredString(secret?.RuleID, "Secret rule id"),
    severity: normalizedSeverity(secret?.Severity),
    target,
    category: typeof secret?.Category === "string" ? secret.Category : "",
    startLine: Number.isInteger(secret?.StartLine) ? secret.StartLine : null,
    endLine: Number.isInteger(secret?.EndLine) ? secret.EndLine : null,
  };
}

export function summarizeFindings(findings, thresholdKey, policy, scope) {
  let blocked = 0;
  let excepted = 0;
  const thresholds = new Set(policy.thresholds[thresholdKey]);
  const reviewed = findings.map((finding) => {
    const blocks = thresholds.has(finding.severity);
    const exception = blocks ? matchingException(policy, finding, scope) : undefined;
    if (exception) excepted += 1;
    else if (blocks) blocked += 1;
    return {
      ...finding,
      policy: exception ? "excepted" : blocks ? "blocked" : "reported",
      ...(exception
        ? {
            exception: {
              owner: exception.owner,
              expiresOn: exception.expiresOn,
              trackingIssue: exception.trackingIssue,
            },
          }
        : {}),
    };
  });
  return { findings: reviewed, blocked, excepted };
}

function contentHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function evaluateSourceEvidence(
  report,
  policy,
  now = new Date().toISOString().slice(0, 10),
) {
  validateSupplyChainPolicy(policy, now);
  validateReport(report);
  const vulnerabilities = [];
  const secrets = [];
  for (const result of report.Results) {
    const target = typeof result?.Target === "string" ? result.Target : "";
    for (const vulnerability of result?.Vulnerabilities ?? []) {
      vulnerabilities.push(vulnerabilityFinding(vulnerability, target));
    }
    for (const secret of result?.Secrets ?? []) {
      secrets.push(secretFinding(secret, target));
    }
  }
  const vulnerabilityReview = summarizeFindings(
    vulnerabilities,
    "sourceVulnerabilities",
    policy,
    "source",
  );
  const secretReview = summarizeFindings(
    secrets,
    "sourceSecrets",
    policy,
    "source",
  );
  return {
    schemaVersion: 1,
    generatedOn: now,
    scope: "source",
    scanner: {
      name: policy.scanner.name,
      version: policy.scanner.version,
      image: policy.scanner.image,
    },
    summary: {
      vulnerabilities: vulnerabilities.length,
      secrets: secrets.length,
      blocked: vulnerabilityReview.blocked + secretReview.blocked,
      excepted: vulnerabilityReview.excepted + secretReview.excepted,
    },
    findings: [...vulnerabilityReview.findings, ...secretReview.findings],
  };
}

export function evaluateImageEvidence({
  report,
  sbom,
  reportSha256,
  sbomSha256,
  policy,
  expectedImageId,
  expectedTag,
  revision,
  now = new Date().toISOString().slice(0, 10),
}) {
  validateSupplyChainPolicy(policy, now);
  validateReport(report);
  if (!DIGEST_PATTERN.test(expectedImageId ?? "")) {
    throw new Error("Expected image identity must be a sha256 digest.");
  }
  if (report?.Metadata?.ImageID !== expectedImageId) {
    throw new Error("Vulnerability report image identity does not match the tested image.");
  }
  if (report?.ArtifactName !== expectedTag) {
    throw new Error("Vulnerability report tag does not match the tested image.");
  }
  if (sbom?.spdxVersion !== "SPDX-2.3" || sbom?.name !== expectedTag) {
    throw new Error("SPDX SBOM does not identify the tested image.");
  }
  if (!/^[0-9a-f]{40}$/u.test(revision ?? "")) {
    throw new Error("Image evidence requires a valid source revision.");
  }
  for (const [label, digest] of [
    ["Vulnerability report", reportSha256],
    ["SBOM", sbomSha256],
  ]) {
    if (digest !== undefined && !DIGEST_PATTERN.test(digest)) {
      throw new Error(`${label} artifact hash must be a sha256 digest.`);
    }
  }
  const vulnerabilities = [];
  for (const result of report.Results) {
    const target = typeof result?.Target === "string" ? result.Target : "";
    for (const vulnerability of result?.Vulnerabilities ?? []) {
      vulnerabilities.push(vulnerabilityFinding(vulnerability, target));
    }
  }
  const review = summarizeFindings(
    vulnerabilities,
    "imageVulnerabilities",
    policy,
    "image",
  );
  return {
    schemaVersion: 1,
    generatedOn: now,
    scope: "image",
    scanner: {
      name: policy.scanner.name,
      version: policy.scanner.version,
      image: policy.scanner.image,
    },
    image: {
      id: expectedImageId,
      tag: expectedTag,
      revision,
    },
    artifacts: {
      vulnerabilityReportSha256: reportSha256 ?? contentHash(report),
      sbomSha256: sbomSha256 ?? contentHash(sbom),
      sbomFormat: "SPDX-2.3",
    },
    summary: {
      vulnerabilities: vulnerabilities.length,
      blocked: review.blocked,
      excepted: review.excepted,
    },
    findings: review.findings,
  };
}

function parseArguments(arguments_) {
  const [command, ...rest] = arguments_;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Supply-chain policy arguments must use --name value pairs.");
    }
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is missing or invalid JSON.`);
  }
}

function readJsonWithHash(path, label) {
  try {
    const content = readFileSync(path);
    return {
      value: JSON.parse(content.toString("utf8")),
      sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    };
  } catch {
    throw new Error(`${label} is missing or invalid JSON.`);
  }
}

function writeEvidence(path, evidence) {
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

function blockedFindingSummary(evidence) {
  return evidence.findings
    .filter((finding) => finding.policy === "blocked")
    .slice(0, 10)
    .map((finding) => `${finding.id}${finding.package ? `/${finding.package}` : ""}`)
    .join(", ");
}

function runCli() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const policyPath = options.policy ?? ".github/supply-chain-policy.json";
  const policy = readJson(policyPath, "Supply-chain policy");
  const now = process.env.ORBIT_POLICY_DATE ?? new Date().toISOString().slice(0, 10);

  if (command === "validate") {
    const result = validateSupplyChainPolicy(policy, now);
    process.stdout.write(
      `Supply-chain policy: Trivy ${result.scannerVersion}, ${result.dependencyReviewActionCount} dependency review action(s), ${result.pinnedImageCount} pinned container image(s), ${result.exceptionCount} exception(s), ${result.mutableReferenceCount} mutable reference exception(s).\n`,
    );
    return;
  }
  if (command === "source") {
    const evidence = evaluateSourceEvidence(
      readJson(requiredString(options.input, "Source report path"), "Source report"),
      policy,
      now,
    );
    writeEvidence(requiredString(options.output, "Source evidence path"), evidence);
    if (evidence.summary.blocked > 0) {
      throw new Error(
        `Source supply-chain policy blocked ${evidence.summary.blocked} finding(s): ${blockedFindingSummary(evidence)}.`,
      );
    }
    process.stdout.write(
      `Source supply-chain policy passed: ${evidence.summary.vulnerabilities} vulnerability finding(s), ${evidence.summary.secrets} secret finding(s), ${evidence.summary.excepted} exception(s).\n`,
    );
    return;
  }
  if (command === "image") {
    const reportFile = readJsonWithHash(
      requiredString(options.input, "Image report path"),
      "Image report",
    );
    const sbomFile = readJsonWithHash(
      requiredString(options.sbom, "SBOM path"),
      "SPDX SBOM",
    );
    const evidence = evaluateImageEvidence({
      report: reportFile.value,
      sbom: sbomFile.value,
      reportSha256: reportFile.sha256,
      sbomSha256: sbomFile.sha256,
      policy,
      expectedImageId: options["expected-image-id"],
      expectedTag: requiredString(options["expected-tag"], "Expected image tag"),
      revision: options.revision,
      now,
    });
    writeEvidence(requiredString(options.output, "Image evidence path"), evidence);
    if (evidence.summary.blocked > 0) {
      throw new Error(
        `Image supply-chain policy blocked ${evidence.summary.blocked} finding(s): ${blockedFindingSummary(evidence)}.`,
      );
    }
    process.stdout.write(
      `Image supply-chain policy passed for ${evidence.image.id}: ${evidence.summary.vulnerabilities} finding(s), ${evidence.summary.excepted} exception(s).\n`,
    );
    return;
  }
  throw new Error("Supply-chain policy command must be validate, source, or image.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Supply-chain policy failed."}\n`,
    );
    process.exitCode = 1;
  }
}
