import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const tikaConfig = readFileSync(new URL("../config/tika-config.json", import.meta.url), "utf8");
const tikaAdapter = readFileSync(new URL("../src/server/documents/tika.ts", import.meta.url), "utf8");
const exactProcessorTest = readFileSync(new URL("./test-tika-processor.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/publish-container.yml", import.meta.url), "utf8");
// #801 moved the processor steps' shell into scripts/ci/. The workflow still
// owns the step names, the scope gate and the `if:` that reads it; the runtime
// assertions live in the two scripts it calls.
const processorScope = readFileSync(new URL("./ci/detect-processor-scope.sh", import.meta.url), "utf8");
const processorRuntime = readFileSync(new URL("./ci/verify-tika-processor.sh", import.meta.url), "utf8");
// The resolved-configuration half of the model server's no-egress proof (#935):
// the assertions here read the compose file, that script reads what Compose
// renders from it, and this file keeps the two from drifting apart.
const validateCompose = readFileSync(new URL("./ci/validate-compose.sh", import.meta.url), "utf8");

/**
 * Extracts one service block.
 *
 * Slicing to the next top-level key would swallow every service declared after
 * the target, so a sibling's `volumes:` could fail an isolation assertion that
 * is about this service alone. The block ends at the next sibling service.
 */
function serviceBlock(name) {
  const start = compose.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`Service ${name} is not declared`);
  const rest = compose.slice(start + 1);
  const nextSibling = rest.search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/u);
  return nextSibling < 0 ? rest : rest.slice(0, nextSibling);
}

describe("service block extraction", () => {
  it("stops at the next sibling service", () => {
    // Proves the isolation assertions below are about Tika alone. orbit-ollama
    // declares volumes; if the block leaked into it, that assertion would fail
    // for the wrong reason and could later be relaxed to compensate.
    const tika = serviceBlock("orbit-tika");
    expect(tika).toContain("orbit-tika");
    expect(tika).not.toContain("orbit-ollama");
    expect(tika).not.toContain("orbit-clamav");
  });

  it("still sees a violation inside the target service", () => {
    // Guards against the extraction being narrowed until assertions pass
    // vacuously: a service that genuinely declares volumes must show them.
    expect(serviceBlock("orbit-ollama")).toMatch(/\n\s+volumes:/u);
    expect(serviceBlock("orbit-app")).toMatch(/\n\s+secrets:/u);
  });

  it("refuses to silently return nothing for an absent service", () => {
    expect(() => serviceBlock("orbit-does-not-exist")).toThrow(/is not declared/u);
  });

  it("stops before the model pull helper", () => {
    // orbit-ollama-model-pull deliberately sits on the default network, which
    // is the one thing orbit-ollama must not have. If the server's block leaked
    // into its neighbour, the no-egress assertions below would be reading the
    // wrong service and could later be relaxed to compensate.
    const ollama = serviceBlock("orbit-ollama");
    expect(ollama).not.toContain("networks:\n      - default");
    expect(ollama).not.toContain('profiles: ["ai-model-pull"]');
  });
});

describe("hostile document processor contract", () => {
  it("keeps Tika non-root, read-only, capability-free and isolated", () => {
    const tika = serviceBlock("orbit-tika");
    expect(tika).toContain('user: "35002:35002"');
    expect(tika).toContain("read_only: true");
    // Only the `-c` argument selects a config file on Tika 4. A TIKA_CONFIG
    // variable is read by nothing in the server, so it would misdirect whoever
    // moves the config path next (#692).
    expect(tika).not.toContain("TIKA_CONFIG");
    expect(tika).toContain('command: ["-c", "/etc/orbit/tika-config.json"]');
    expect(tika).toContain("cap_drop:\n      - ALL");
    expect(tika).toContain("uid=35002,gid=35002,mode=0700,size=256m");
    expect(tika).toContain("networks:\n      - orbit-document-processing");
    expect(tika).not.toMatch(/\n\s+(?:volumes|secrets|ports):/u);
    expect(compose).toContain("orbit-document-processing:\n    internal: true");
  });

  it("disables OCR and embedded recursion without caller-controlled options", () => {
    // Tika 4 takes JSON and ignores the X-Tika-* request headers Tika 3 honoured,
    // so both restrictions now live in the config file and are asserted from the
    // parsed document rather than from a substring. A wrong shape here parses,
    // loads nothing and reports no error, which is why the array form and the
    // registered component name are pinned rather than merely "mentions OCR".
    const parsed = JSON.parse(tikaConfig);
    expect(Array.isArray(parsed.parsers)).toBe(true);
    const defaultParser = parsed.parsers.find(
      (entry) => typeof entry === "object" && entry !== null && "default-parser" in entry,
    )?.["default-parser"];
    expect(defaultParser?.exclude).toContain("tesseract-ocr-parser");
    // Tika 4 refuses class names outright, so the 3.x spelling must not return.
    expect(tikaConfig).not.toContain("org.apache.tika.parser.ocr.TesseractOCRParser");
    expect(parsed["parse-context"]?.["embedded-limits"]).toMatchObject({ maxDepth: 0, maxCount: 0 });
    expect(tikaAdapter).toContain('new URL("/tika", config.tika.url)');
    expect(tikaAdapter).not.toContain("input.url");
    expect(tikaAdapter).not.toContain("input.headers");
    // Tika 4 reads no X-Tika-* request header, so sending one would advertise a
    // per-request opt-out the server never honours (#692).
    expect(tikaAdapter).not.toContain("X-Tika");
  });

  it("retains protected exact-image runtime evidence for processor changes", () => {
    expect(workflow).toContain("Detect exact processor validation scope");
    expect(workflow).toContain("Verify exact hostile-document processor");
    // The step still runs only when the scope gate says so, and still calls
    // the script that carries the evidence.
    expect(workflow).toContain("bash scripts/ci/detect-processor-scope.sh");
    expect(workflow).toContain("steps.processor_scope.outputs.required == 'true'");
    expect(workflow).toContain("bash scripts/ci/verify-tika-processor.sh");
    expect(processorScope).toContain("scripts/test-tika-processor.mjs");
    expect(processorRuntime).toContain("scripts/test-tika-processor.mjs");
    expect(processorRuntime).toContain('test "${tika_uid}" = "35002"');
    expect(processorRuntime).toContain('test "${tika_read_only}" = "true"');
    expect(exactProcessorTest).toContain("EMBEDDED-CONTENT-MUST-NOT-APPEAR");
    expect(exactProcessorTest).toContain("OCR BLOCKED");
  });
});

describe("private model server contract", () => {
  it("confines the model server to the egress-free processing network", () => {
    const ollama = serviceBlock("orbit-ollama");
    // ADR-0025 gives two structural answers to "what stops this becoming a
    // cloud extraction path later". One is that Orbit's endpoint is a
    // compile-time constant with no configuration surface. This is the other:
    // the container that holds hostile document text has nowhere to send it,
    // whatever a future image or model tries. Same treatment as Tika.
    const declared = ollama.match(/\n {4}networks:\n((?: {6}- \S+\n)+)/u)?.[1];
    expect(declared?.trim()).toBe("- orbit-document-processing");
    expect(compose).toContain("orbit-document-processing:\n    internal: true");
    // Unpublished port, so the model is not reachable from the host either.
    expect(ollama).not.toMatch(/\n\s+ports:/u);
    // Defence in depth behind the network, never instead of it.
    expect(ollama).toContain('OLLAMA_NO_CLOUD: "1"');
    expect(ollama).toContain('profiles: ["ai"]');
  });

  it("keeps getting a model in a deliberate, separate operator step", () => {
    const pull = serviceBlock("orbit-ollama-model-pull");
    // The server can no longer fetch its own model, which is why this exists.
    // Its own profile is what keeps it out of every `up`: an operator asks for
    // a pull by name, or nothing in this stack ever reaches the internet.
    expect(pull).toContain('profiles: ["ai-model-pull"]');
    expect(pull).toContain('restart: "no"');
    expect(pull).toContain("networks:\n      - default");
    // Same pinned image and same volume as the server it fills, or it fills
    // nothing the server will read.
    const image = serviceBlock("orbit-ollama").match(/\n {4}image: (\S+)\n/u)?.[1];
    expect(image).toMatch(/^ollama\/ollama:[^@\s]+@sha256:[0-9a-f]{64}$/u);
    expect(pull).toContain(`image: ${image}`);
    expect(pull).toContain("- orbit-ollama-data:/root/.ollama");
    // It fetches model data and nothing else: no application secrets, no host
    // port, no document storage, no lingering container name to collide with.
    expect(pull).not.toMatch(/\n\s+(?:secrets|ports|configs|container_name):/u);
    expect(pull).toContain("cap_drop:\n      - ALL");
    expect(pull).toContain("no-new-privileges:true");
    // The temporary server it runs for the length of the download binds
    // loopback, so nothing else on the egress network can talk to it.
    expect(pull).toContain("OLLAMA_HOST: 127.0.0.1:11434");
    // Compose expands `${...}` before the container sees the command, so every
    // dollar the container's own shell must read is written `$$`. A single `$`
    // is silently replaced with an empty string at config time, which would
    // leave a script that runs and quietly does the wrong thing.
    expect(pull).toContain("server_pid=$$!");
    expect(pull).toContain('kill "$$server_pid"');
    expect(pull).toContain('/bin/ollama pull "$${ORBIT_OLLAMA_MODEL}"');
  });

  it("asserts no egress against the Compose configuration Compose resolves", () => {
    // The assertions above read the file. This one keeps the check that reads
    // what Compose actually resolves wired in, so a profile, an override file
    // or an inherited default cannot reintroduce egress without failing.
    expect(validateCompose).toContain(
      '.services["orbit-ollama"].networks | keys == ["orbit-document-processing"]',
    );
    expect(validateCompose).toContain('((.services["orbit-ollama"].ports // []) | length == 0)');
    expect(validateCompose).toContain('((.services | has("orbit-ollama-model-pull")) | not)');
    expect(validateCompose).toContain(
      "--profile ai --profile ai-model-pull config --format json",
    );
    expect(validateCompose).toContain(
      '(.services["orbit-ollama-model-pull"].networks | keys == ["default"])',
    );
  });
});
