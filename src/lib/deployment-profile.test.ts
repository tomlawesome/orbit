import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type LocalAiCapacity, chooseDeploymentProfile, resolveNonInteractiveProfileSelection, updateIdentityLines } from "./deployment-profile";
import { InstallPromptStop, selectChoice } from "./install-terminal";
import { scriptedTerminal } from "../../tests/support/scripted-terminal";

// The profile wizard install.sh's choose_deployment_profile and
// check_local_ai_capacity ran (#1212 build note F4), now asked by the engine
// on the operator's terminal. Guarantee #20: a model download is a separate,
// explicit confirmation, never a side effect of choosing a profile.

const sufficient = (): LocalAiCapacity => "sufficient";

function stopCode(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof InstallPromptStop) return error.exitCode;
    throw error;
  }
  return undefined;
}

describe("selectChoice", () => {
  const choices = [
    ["install", "Install"],
    ["update", "Update"],
  ] as const;

  it("takes Enter as the default, a name, or a number", () => {
    expect(selectChoice(scriptedTerminal([""]), "Heading", "update", choices)).toBe("update");
    expect(selectChoice(scriptedTerminal(["install"]), "Heading", "update", choices)).toBe("install");
    expect(selectChoice(scriptedTerminal(["2"]), "Heading", "install", choices)).toBe("update");
  });

  it("asks again after an answer that is not a choice", () => {
    const terminal = scriptedTerminal(["9", "maybe", "Install"]);
    expect(selectChoice(terminal, "Heading", "update", choices)).toBe("install");
    expect(terminal.output().match(/Enter one of install\/update/g)).toHaveLength(2);
  });

  it("treats end of input as a failed input channel (exit 1), never as the default", () => {
    expect(stopCode(() => selectChoice(scriptedTerminal([undefined]), "Heading", "install", choices))).toBe(1);
  });

  it("passes Ctrl-C on as the operator declining (exit 130)", () => {
    expect(stopCode(() => selectChoice(scriptedTerminal(["^C"]), "Heading", "install", choices))).toBe(130);
  });
});

describe("chooseDeploymentProfile: install", () => {
  const context = { installerAction: "install" as const, existingProfile: "standard" as const, capacity: sufficient };

  it("chooses a preset and confirms it on the review", () => {
    const terminal = scriptedTerminal(["processing", "", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toEqual({
      selectedProfile: "processing",
      selectedModel: undefined,
      profileChange: true,
      modelPullRequested: false,
      scanner: "on",
    });
    expect(terminal.output()).toContain("Profiles keep data inside the private Compose network.");
  });

  it("states the fixed resource classes, the optional boundaries and local privacy before the choice", () => {
    const terminal = scriptedTerminal(["standard", "", "apply"]);
    chooseDeploymentProfile(terminal, context);
    const shown = terminal.output();
    for (const line of [
      "Profiles keep data inside the private Compose network. Resource classes are fixed relative labels: standard, medium, and high; they are not hardware guarantees.",
      "Required Orbit core stays enabled; private scanning (ClamAV) is on by default and optional; document processing and local AI are optional services.",
      "Sign-in is chosen separately: local accounts always work, and an identity provider (OIDC) is optional (configure.sh --init).",
      "Ollama is optional local infrastructure and is not yet consumed by Orbit product workflows.",
    ]) {
      expect(shown).toContain(line);
    }
    expect(shown.indexOf("Resource classes")).toBeLessThan(shown.indexOf("Choose a deployment profile"));
  });

  it("offers the four custom combinations, including local AI alone", () => {
    const terminal = scriptedTerminal(["custom", "ai", "llama3.2:3b", "", "", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toMatchObject({ selectedProfile: "ai", selectedModel: "llama3.2:3b" });
  });

  it("saves the model choice without downloading it by default (guarantee #20)", () => {
    const terminal = scriptedTerminal(["full", "llama3.2:3b", "", "", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toEqual({
      selectedProfile: "full",
      selectedModel: "llama3.2:3b",
      profileChange: true,
      modelPullRequested: false,
      scanner: "on",
    });
    expect(terminal.output()).toContain("Save the model choice without downloading it now (default)");
  });

  it("requests the download only on its own explicit confirmation (guarantee #20)", () => {
    const terminal = scriptedTerminal(["full", "llama3.2:3b", "pull", "", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toMatchObject({ modelPullRequested: true, selectedModel: "llama3.2:3b" });
  });

  it.each([
    ["sufficient", "Host capacity check: the configured local-service CPU and memory envelope is available"],
    ["below", "Host capacity check: this host is below the configured local-service CPU or memory envelope"],
    ["unknown", "Host capacity check: CPU, memory or available storage could not be verified"],
  ] as const)("reports the host capacity check (%s) before the download question", (capacity, line) => {
    const terminal = scriptedTerminal(["full", "llama3.2:3b", "", "", "apply"]);
    chooseDeploymentProfile(terminal, { ...context, capacity: () => capacity });
    expect(terminal.output()).toContain(line);
  });

  it("refuses an invalid model identifier with exit 2, as install.sh did", () => {
    expect(stopCode(() => chooseDeploymentProfile(scriptedTerminal(["full", "bad model!"]), context))).toBe(2);
  });

  it.each([
    ["Back on the profile menu", ["back"]],
    ["Back on the custom menu", ["custom", "back"]],
    ["Cancel on the download question", ["full", "llama3.2:3b", "cancel"]],
    ["Cancel on the review", ["standard", "", "cancel"]],
  ])("treats %s as the operator declining (exit 130)", (_label, answers) => {
    expect(stopCode(() => chooseDeploymentProfile(scriptedTerminal(answers), context))).toBe(130);
  });

  // #1170: the scanner step, after the profile; Enter keeps ClamAV.
  it("asks about ClamAV after the profile, keeps it on Enter, and turns it off only when chosen (#1170)", () => {
    const kept = scriptedTerminal(["standard", "", "apply"]);
    expect(chooseDeploymentProfile(kept, context)).toMatchObject({ scanner: "on" });
    expect(kept.output()).toContain("Keep ClamAV (recommended): uploaded and mailed documents are virus-scanned");
    expect(kept.output().indexOf("Choose a deployment profile")).toBeLessThan(kept.output().indexOf("Private document scanner (ClamAV)"));
    const off = scriptedTerminal(["standard", "off", "apply"]);
    expect(chooseDeploymentProfile(off, context)).toMatchObject({ scanner: "off" });
    expect(off.output()).toContain("Run without ClamAV: documents are not virus-scanned. Turn it back on later with scripts/configure.sh --set-scanner on");
  });

  it("treats end of input on the review as a failed input channel (exit 1), not a decline", () => {
    expect(stopCode(() => chooseDeploymentProfile(scriptedTerminal(["standard", "", undefined]), context))).toBe(1);
  });
});

describe("chooseDeploymentProfile: update", () => {
  const context = { installerAction: "update" as const, existingProfile: "processing" as const, capacity: sufficient, identityLines: ["Current: x", "Target: y"] };

  it("preserves the current profile by default, with no profile change", () => {
    const terminal = scriptedTerminal(["", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toEqual({
      selectedProfile: "processing",
      selectedModel: undefined,
      profileChange: false,
      modelPullRequested: false,
    });
    expect(terminal.output()).toContain("Current: x\nTarget: y");
    expect(terminal.output()).toContain("Review: preserve the current processing profile and OIDC configuration.");
  });

  it("lets the operator change to another supported profile", () => {
    const terminal = scriptedTerminal(["change", "standard", "", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toMatchObject({ selectedProfile: "standard", profileChange: true });
  });

  it.each([
    ["Back", ["back"]],
    ["Cancel on the preserve review", ["preserve", "cancel"]],
  ])("treats %s as declining (exit 130)", (_label, answers) => {
    expect(stopCode(() => chooseDeploymentProfile(scriptedTerminal(answers), context))).toBe(130);
  });
});

// #1170 review: the scanner step's default is the deployment's current
// choice, so an update over a disabled install is never turned on by Enter.
describe("chooseDeploymentProfile: the scanner step over a disabled install (#1170)", () => {
  const context = {
    installerAction: "update" as const,
    existingProfile: "standard" as const,
    existingScanner: "off" as const,
    capacity: sufficient,
    identityLines: ["Current: x", "Target: y"],
  };

  it("keeps the scanner off on Enter, and says it is the current choice", () => {
    const terminal = scriptedTerminal(["change", "standard", "", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toMatchObject({ selectedProfile: "standard", profileChange: true, scanner: "off" });
    expect(terminal.output()).toContain("Keep running without ClamAV (current)");
    expect(terminal.output()).toContain("without ClamAV");
  });

  it("turns it on only when on is chosen", () => {
    const terminal = scriptedTerminal(["change", "standard", "on", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toMatchObject({ scanner: "on" });
  });

  it("does not offer off again, since off is the current choice", () => {
    const terminal = scriptedTerminal(["change", "standard", "off", "apply"]);
    expect(() => chooseDeploymentProfile(terminal, context)).toThrow();
  });

  it("an install over a handed-in disabled file keeps it off on Enter too", () => {
    const terminal = scriptedTerminal(["standard", "", "apply"]);
    expect(chooseDeploymentProfile(terminal, { ...context, installerAction: "install" as const })).toMatchObject({ scanner: "off" });
  });
});

describe("updateIdentityLines (show_update_identity)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reports the recorded identity, and none for anything unrecorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-update-identity-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env-orbit"), `ORBIT_CONFIG_SCHEMA_VERSION=1\nORBIT_IMAGE=ghcr.io/x/y@sha256:${"c".repeat(64)}\n`, { mode: 0o600 });
    expect(updateIdentityLines(dir, "full", { version: "v1.2.3", digest: `sha256:${"d".repeat(64)}`, channel: "latest" })).toEqual([
      `Current: schema=v1 version=none digest=sha256:${"c".repeat(64)} optional-profile=full`,
      `Target: schema=v1 version=v1.2.3 digest=sha256:${"d".repeat(64)} channel=latest`,
    ]);
  });
});

// #1504: the launcher's ORBIT_INSTALL_PROFILE reaches a plain-mode fresh
// install; only `standard` and `processing` are accepted, and an update never
// looks at it.
describe("resolveNonInteractiveProfileSelection (#1504)", () => {
  const refusal = { refused: true, message: "ORBIT_INSTALL_PROFILE must be standard or processing." };

  it.each(["standard", "processing"])("installs the requested %s profile as a profile change (#1504)", (requested) => {
    expect(resolveNonInteractiveProfileSelection("install", "standard", requested)).toEqual({ selectedProfile: requested, profileChange: true });
  });

  it("installs the standard profile when nothing is requested, as before (#1504)", () => {
    expect(resolveNonInteractiveProfileSelection("install", "standard", undefined)).toEqual({ selectedProfile: "standard", profileChange: true });
    expect(resolveNonInteractiveProfileSelection("install", "standard")).toEqual({ selectedProfile: "standard", profileChange: true });
  });

  it.each(["ai", "full", "bogus", "", "PROCESSING"])("refuses the unsupported request %j on an install (#1504)", (requested) => {
    expect(resolveNonInteractiveProfileSelection("install", "standard", requested)).toEqual(refusal);
  });

  it.each([undefined, "standard", "processing", "ai", "full", "bogus", "", "PROCESSING"])("ignores the request %j on an update and keeps the existing profile (#1504)", (requested) => {
    expect(resolveNonInteractiveProfileSelection("update", "processing", requested)).toEqual({ selectedProfile: "processing", profileChange: false });
  });
});

// #1542: on a non-interactive update, ORBIT_INSTALL_PROFILE changes a deployment
// between standard and processing; a local-model deployment is never changed
// this way. Install and interactive behaviour stay as #1504 left them.
describe("resolveNonInteractiveProfileSelection on an update (#1542)", () => {
  const LOCAL_MODEL_REFUSAL = {
    refused: true,
    message: "ORBIT_INSTALL_PROFILE cannot change a deployment that uses a local model; use the installer at a terminal.",
  };
  const MUST_BE_REFUSAL = { refused: true, message: "ORBIT_INSTALL_PROFILE must be standard or processing." };

  it.each(["standard", "processing", "ai", "full"] as const)("keeps the existing %s profile when the variable is unset (#1542)", (existing) => {
    expect(resolveNonInteractiveProfileSelection("update", existing, undefined)).toEqual({ selectedProfile: existing, profileChange: false });
    expect(resolveNonInteractiveProfileSelection("update", existing)).toEqual({ selectedProfile: existing, profileChange: false });
  });

  it.each([
    ["standard", "processing", true],
    ["processing", "standard", true],
    ["standard", "standard", false],
    ["processing", "processing", false],
  ] as const)("over an existing %s profile, requesting %s selects it with profileChange %s (#1542)", (existing, requested, change) => {
    expect(resolveNonInteractiveProfileSelection("update", existing, requested)).toEqual({ selectedProfile: requested, profileChange: change });
  });

  it.each([
    ["ai", "standard"],
    ["ai", "processing"],
    ["full", "standard"],
    ["full", "processing"],
  ] as const)("refuses %s -> %s with the local-model message (#1542)", (existing, requested) => {
    expect(resolveNonInteractiveProfileSelection("update", existing, requested)).toEqual(LOCAL_MODEL_REFUSAL);
  });

  it.each(["ai", "full", "bogus", "", "PROCESSING"])("refuses the value %j over a standard or processing deployment with the must-be message (#1542)", (requested) => {
    expect(resolveNonInteractiveProfileSelection("update", "standard", requested)).toEqual(MUST_BE_REFUSAL);
    expect(resolveNonInteractiveProfileSelection("update", "processing", requested)).toEqual(MUST_BE_REFUSAL);
  });

  it.each(["ai", "full"] as const)("refuses an invalid value over an existing %s profile with the must-be message, not the local-model one (#1542)", (existing) => {
    expect(resolveNonInteractiveProfileSelection("update", existing, "bogus")).toEqual(MUST_BE_REFUSAL);
  });

  it("leaves install behaviour as it was (#1542)", () => {
    expect(resolveNonInteractiveProfileSelection("install", "standard", "processing")).toEqual({ selectedProfile: "processing", profileChange: true });
    expect(resolveNonInteractiveProfileSelection("install", "standard", undefined)).toEqual({ selectedProfile: "standard", profileChange: true });
    expect(resolveNonInteractiveProfileSelection("install", "standard", "ai")).toEqual(MUST_BE_REFUSAL);
  });
});
