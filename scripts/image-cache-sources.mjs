import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Fail CI on any container image reference that skips the image cache (#1510,
// #1536 D-F13). This is an allowlist: a reference whose first path segment is a
// registry host (Docker's rule: it holds a dot or a :port) and which carries a
// tag or digest fails, unless the host is Docker Hub (`docker.io`, which the
// pull-through mirror covers), Orbit's own registry, or localhost / 127.0.0.1
// (the disposable local registry). `$CI_IMAGE_CACHE_*` prefixes and Docker Hub
// names with no host never look like a host, so they pass. ghcr.io, the
// Microsoft, Quay and Google registries and Amazon's public ECR also fail
// without a tag, to catch their case patterns. The GitLab Dependency Proxy is
// retired. Reads tracked CI, Compose, Dockerfile, shell and script files.

const EXCEPTIONS_FILE = ".github/image-cache-exceptions.json";

// A literal registry host at the start of a name: `ghcr.io/owner/tool:1`,
// `registry.example.com:5000/t:2`, `registry-host:5000/t:3`. The negative
// lookbehind skips anything after a `/`, so URLs do not match.
const REGISTRY_HOST_PATTERN =
  /(?<![\w.\-/])((?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?|[A-Za-z0-9-]+:\d+))(\/[^\s"'`,;)\]<>|]+)/gu;
// Registries the cache has a prefix for, or a mirror for, and which are refused
// even where the reference carries no tag (a `case` pattern, a `${x#host/}`).
const CACHED_ELSEWHERE_HOST =
  /(?:^|\.)(?:ghcr\.io|mcr\.microsoft\.com|quay\.io|gcr\.io|pkg\.dev|public\.ecr\.aws)$/u;
// Hosts a pull may name directly: the pull-through mirror covers Docker Hub,
// the rest are Orbit's own registry and the disposable local one.
const ALLOWED_HOSTS = new Set(["docker.io", "registry.tomlawson.io", "localhost", "127.0.0.1"]);
// A tag or digest needs something after the `:` or `@`: `tcp:` ending a
// sentence (`0.0.0.0:3000/tcp: address in use`) is prose, not a tag.
const TAG_OR_DIGEST_PATTERN = /:[\w$]|@\w/u;
const DEPENDENCY_PROXY_PATTERN =
  /\$\{?CI_DEPENDENCY_PROXY_[A-Z0-9_]+\}?(?:\/[^\s"'`,;)\]<>|]+)?/gu;
const DIND_IMAGE_PATTERN = /(?:^|\/)docker:[^\s"']*dind/u;
const MIRROR_FLAG_PATTERN =
  /--registry-mirror=https?:\/\/\$\{?CI_IMAGE_CACHE_DOCKERHUB\}?(?![A-Za-z0-9_])/u;
// The form CI uses (pipeline 2936): GitLab cannot fill runner-config values
// into a service's command, so the service reads the value itself at start.
const MIRROR_FROM_ENVIRONMENT_PATTERN =
  /printenv CI_IMAGE_CACHE_DOCKERHUB[\s\S]*--registry-mirror=/u;

const CACHE_PREFIX = {
  "ghcr.io": "$CI_IMAGE_CACHE_GHCR",
  "mcr.microsoft.com": "$CI_IMAGE_CACHE_MCR",
};

// --- Which files are read --------------------------------------------------

export function SCANNED_FILE(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/\.test\./u.test(name)) return false;
  if (name === ".gitlab-ci.yml") return true;
  if (/^docker-compose(?:\..+)?\.ya?ml$/u.test(name)) return true;
  if (/^compose(?:\..+)?\.ya?ml$/u.test(path)) return true;
  if (/^compose\/.+\.ya?ml$/u.test(path)) return true;
  if (/^Dockerfile(?:\..+)?$/u.test(name) || /\.Dockerfile$/u.test(name)) return true;
  return /^scripts\/.+\.(?:sh|bash|mjs|cjs|js)$/u.test(path);
}

// --- Comment stripping (line numbers are preserved) ------------------------

// `#` starts a comment at the start of a line or after whitespace, outside quotes.
function stripHashComments(text) {
  return text
    .split("\n")
    .map((line) => {
      let quote = "";
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quote) {
          if (char === "\\" && quote === '"') index += 1;
          else if (char === quote) quote = "";
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === "#" && (index === 0 || /\s/u.test(line[index - 1]))) {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join("\n");
}

// `//` and `/* */` comments, outside string and template literals.
function stripScriptComments(text) {
  let output = "";
  let state = "code";
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        output += char;
      } else output += " ";
    } else if (state === "block") {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else output += char === "\n" ? "\n" : " ";
    } else if (state === "string") {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        index += 1;
      } else if (char === quote || (char === "\n" && quote !== "`")) state = "code";
    } else if (char === "/" && next === "/") {
      state = "line";
      output += "  ";
      index += 1;
    } else if (char === "/" && next === "*") {
      state = "block";
      output += "  ";
      index += 1;
    } else {
      if (char === '"' || char === "'" || char === "`") {
        state = "string";
        quote = char;
      }
      output += char;
    }
  }
  return output;
}

function strippedLines(path, text) {
  const script = /\.(?:mjs|cjs|js)$/u.test(path);
  return (script ? stripScriptComments(text) : stripHashComments(text)).split("\n");
}

// --- Rules -----------------------------------------------------------------

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function trimTrailingPunctuation(value) {
  return value.replace(/[.,;:]+$/u, "");
}

function hostFindings(lines) {
  const found = [];
  lines.forEach((line, index) => {
    for (const match of line.matchAll(REGISTRY_HOST_PATTERN)) {
      const host = match[1].replace(/:\d+$/u, "").toLowerCase();
      if (ALLOWED_HOSTS.has(host)) continue;
      const known = Object.keys(CACHE_PREFIX).find((name) => host.endsWith(name));
      if (!CACHED_ELSEWHERE_HOST.test(host) && !TAG_OR_DIGEST_PATTERN.test(match[2])) continue;
      const hint = known ? ` (use ${CACHE_PREFIX[known]})` : "";
      found.push({
        line: index + 1,
        reference: trimTrailingPunctuation(match[0]),
        reason: `pulled from ${known ?? host} directly, not through the image cache${hint}`,
      });
    }
    for (const match of line.matchAll(DEPENDENCY_PROXY_PATTERN)) {
      found.push({
        line: index + 1,
        reference: trimTrailingPunctuation(match[0]),
        reason: "the GitLab Dependency Proxy is retired, use the image cache prefixes",
      });
    }
  });
  return found;
}

// A Docker-in-Docker service pulls images itself, so it needs the mirror flag
// in its command, or an entrypoint that reads the cache address from its
// environment and passes it on; the plain string form of a service has nowhere to put it.
function dindFindings(lines) {
  const found = [];
  for (let start = 0; start < lines.length; start += 1) {
    const header = /^(\s*)services:\s*(.*)$/u.exec(lines[start]);
    if (!header) continue;
    const keyIndent = header[1].length;
    if (header[2] !== "") {
      if (DIND_IMAGE_PATTERN.test(header[2].replace(/["'[\]]/gu, " ").trim()) || /dind/u.test(header[2])) {
        const image = /(\S*docker:[^\s"',\]}]*dind[^\s"',\]}]*)/u.exec(header[2])?.[1] ?? "docker-dind";
        found.push({ line: start + 1, reference: image, reason: dindReason() });
      }
      continue;
    }
    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end];
      const trimmed = line.trim();
      if (trimmed === "" || indentOf(line) > keyIndent || (indentOf(line) === keyIndent && trimmed.startsWith("-"))) {
        end += 1;
      } else break;
    }
    const block = lines.slice(start + 1, end);
    const itemIndent = Math.min(
      ...block.filter((line) => line.trim().startsWith("-")).map(indentOf),
    );
    const itemStarts = block
      .map((line, offset) => ({ line, offset }))
      .filter(({ line }) => line.trim().startsWith("-") && indentOf(line) === itemIndent)
      .map(({ offset }) => offset);
    itemStarts.forEach((offset, position) => {
      const itemLines = block.slice(offset, itemStarts[position + 1] ?? block.length);
      const text = itemLines.join("\n");
      const first = itemLines[0].trim().replace(/^-\s*/u, "");
      let name;
      if (/^[A-Za-z_]+:\s|^\{/u.test(first)) {
        name = /(?:^|[\s{,-])name:\s*["']?([^\s"',}]+)/u.exec(text)?.[1];
      } else {
        name = first.replace(/^["']|["']$/gu, "");
      }
      if (!name || !DIND_IMAGE_PATTERN.test(name)) return;
      if (MIRROR_FLAG_PATTERN.test(text) || MIRROR_FROM_ENVIRONMENT_PATTERN.test(text)) return;
      found.push({ line: start + 1 + offset + 1, reference: name, reason: dindReason() });
    });
  }
  return found;
}

function dindReason() {
  return "Docker-in-Docker service lacks --registry-mirror=http://$CI_IMAGE_CACHE_DOCKERHUB in its command, so its pulls bypass the image cache";
}

function scanFile({ path, text }) {
  const lines = strippedLines(path, text);
  const found = hostFindings(lines);
  if (path.slice(path.lastIndexOf("/") + 1) === ".gitlab-ci.yml") found.push(...dindFindings(lines));
  const seen = new Set();
  return found
    .map((finding) => ({ path, ...finding }))
    .filter((finding) => {
      const key = `${finding.line}\0${finding.reference}\0${finding.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line);
}

/**
 * Every image reference in `files` ({ path, text }) that does not go through
 * the image cache, minus those an exception (path + reference + reason) covers.
 * An exception without a reason, or one that matches nothing, is itself a finding.
 */
export function findUncachedImageReferences(files, exceptions = []) {
  const found = files.flatMap(scanFile);
  const valid = [];
  const extra = [];
  for (const exception of exceptions) {
    const path = typeof exception?.path === "string" ? exception.path : "";
    const reference = typeof exception?.reference === "string" ? exception.reference : "";
    if (path === "" || reference === "") {
      extra.push({ path: path || EXCEPTIONS_FILE, line: 0, reference, reason: "exception needs a path and a reference" });
    } else if (typeof exception.reason !== "string" || exception.reason.trim() === "") {
      extra.push({ path, line: 0, reference, reason: "exception needs a reason" });
    } else {
      valid.push({ path, reference, used: false });
    }
  }
  const remaining = found.filter((finding) => {
    const matches = valid.filter((e) => e.path === finding.path && e.reference === finding.reference);
    for (const match of matches) match.used = true;
    return matches.length === 0;
  });
  for (const exception of valid) {
    if (!exception.used) {
      extra.push({
        path: exception.path,
        line: 0,
        reference: exception.reference,
        reason: "stale exception: it matches no image reference, remove it",
      });
    }
  }
  return [...remaining, ...extra];
}

// --- Command line ----------------------------------------------------------

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function trackedFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .sort();
}

function readExceptions(root) {
  let content;
  try {
    content = readFileSync(join(root, EXCEPTIONS_FILE), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${EXCEPTIONS_FILE} is not valid JSON.`);
  }
  if (!Array.isArray(parsed?.exceptions)) {
    throw new Error(`${EXCEPTIONS_FILE} must hold an "exceptions" array.`);
  }
  return parsed.exceptions;
}

function runCli() {
  const files = [];
  for (const path of trackedFiles(REPOSITORY_ROOT).filter(SCANNED_FILE)) {
    try {
      files.push({ path, text: readFileSync(join(REPOSITORY_ROOT, path), "utf8") });
    } catch {
      // Tracked but absent from the working tree (deleted, not yet committed).
    }
  }
  const findings = findUncachedImageReferences(files, readExceptions(REPOSITORY_ROOT));
  for (const { path, line, reference, reason } of findings) {
    process.stdout.write(`${path}:${line}: ${reference} — ${reason}\n`);
  }
  if (findings.length > 0) {
    process.stderr.write(`${findings.length} image reference(s) not through the image cache.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Image cache check failed."}\n`);
    process.exitCode = 1;
  }
}
