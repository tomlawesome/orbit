import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type LocalAiCapacity, chooseDeploymentProfile, updateIdentityLines } from "./deployment-profile";
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
    const terminal = scriptedTerminal(["processing", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toEqual({
      selectedProfile: "processing",
      selectedModel: undefined,
      profileChange: true,
      modelPullRequested: false,
    });
    expect(terminal.output()).toContain("Profiles keep data inside the private Compose network.");
  });

  it("offers the four custom combinations, including local AI alone", () => {
    const terminal = scriptedTerminal(["custom", "ai", "llama3.2:3b", "", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toMatchObject({ selectedProfile: "ai", selectedModel: "llama3.2:3b" });
  });

  it("saves the model choice without downloading it by default (guarantee #20)", () => {
    const terminal = scriptedTerminal(["full", "llama3.2:3b", "", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toEqual({
      selectedProfile: "full",
      selectedModel: "llama3.2:3b",
      profileChange: true,
      modelPullRequested: false,
    });
    expect(terminal.output()).toContain("Save the model choice without downloading it now (default)");
  });

  it("requests the download only on its own explicit confirmation (guarantee #20)", () => {
    const terminal = scriptedTerminal(["full", "llama3.2:3b", "pull", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toMatchObject({ modelPullRequested: true, selectedModel: "llama3.2:3b" });
  });

  it.each([
    ["sufficient", "Host capacity check: the configured local-service CPU and memory envelope is available"],
    ["below", "Host capacity check: this host is below the configured local-service CPU or memory envelope"],
    ["unknown", "Host capacity check: CPU, memory or available storage could not be verified"],
  ] as const)("reports the host capacity check (%s) before the download question", (capacity, line) => {
    const terminal = scriptedTerminal(["full", "llama3.2:3b", "", "apply"]);
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
    ["Cancel on the review", ["standard", "cancel"]],
  ])("treats %s as the operator declining (exit 130)", (_label, answers) => {
    expect(stopCode(() => chooseDeploymentProfile(scriptedTerminal(answers), context))).toBe(130);
  });

  it("treats end of input on the review as a failed input channel (exit 1), not a decline", () => {
    expect(stopCode(() => chooseDeploymentProfile(scriptedTerminal(["standard", undefined]), context))).toBe(1);
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
    const terminal = scriptedTerminal(["change", "standard", "apply"]);
    expect(chooseDeploymentProfile(terminal, context)).toMatchObject({ selectedProfile: "standard", profileChange: true });
  });

  it.each([
    ["Back", ["back"]],
    ["Cancel on the preserve review", ["preserve", "cancel"]],
  ])("treats %s as declining (exit 130)", (_label, answers) => {
    expect(stopCode(() => chooseDeploymentProfile(scriptedTerminal(answers), context))).toBe(130);
  });
});

describe("updateIdentityLines (show_update_identity)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reports the recorded identity, and legacy/unknown for anything unrecorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-update-identity-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env-orbit"), `ORBIT_CONFIG_SCHEMA_VERSION=1\nORBIT_IMAGE=ghcr.io/x/y@sha256:${"c".repeat(64)}\n`, { mode: 0o600 });
    expect(updateIdentityLines(dir, "full", { version: "v1.2.3", digest: `sha256:${"d".repeat(64)}`, channel: "latest" })).toEqual([
      `Current: schema=v1 version=legacy/unknown digest=sha256:${"c".repeat(64)} optional-profile=full`,
      `Target: schema=v1 version=v1.2.3 digest=sha256:${"d".repeat(64)} channel=latest`,
    ]);
  });
});
