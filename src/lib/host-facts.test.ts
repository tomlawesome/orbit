import { describe, expect, it } from "vitest";

import { HostFactsRefusal, hostFactsVolumeAdapter, parseHostFacts } from "./host-facts";

// The Docker facts install.sh gathers and hands to the engine (#1212 build
// note F3). Every docker output arrives base64-encoded, exactly as the shell
// read it, so the engine applies the same bounds and patterns it applied when
// it asked Docker itself; a fact that is missing answers like a failed docker
// call, and anything malformed refuses the whole run.

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

const DIGEST = `sha256:${"a".repeat(64)}`;
const REVISION = "b".repeat(40);

function validFacts(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    targetBasename: b64("household"),
    cosignUsable: false,
    imageVersion: "v1.2.3",
    imageRevision: REVISION,
    appliedDigest: DIGEST,
    volumeList: b64("orbit_orbit-db-data\nother_orbit-db-data"),
    volumes: [
      { name: b64("orbit_orbit-db-data"), labels: b64("orbit|orbit-db-data"), containers: b64(`${"c".repeat(12)}|orbit|orbit-db`) },
      { name: b64("other_orbit-db-data"), labels: null, containers: null },
    ],
    projects: [{ name: b64("orbit"), containers: b64(`${"d".repeat(12)}|orbit|orbit-app`) }],
    images: [{ container: b64("d".repeat(12)), image: b64(`ghcr.io/x/y@${DIGEST}`) }],
    ...overrides,
  });
}

describe("parseHostFacts", () => {
  it("decodes a well-formed fact set", () => {
    const facts = parseHostFacts(validFacts());
    expect(facts.targetBasename).toBe("household");
    expect(facts.imageVersion).toBe("v1.2.3");
    expect(facts.imageRevision).toBe(REVISION);
    expect(facts.appliedDigest).toBe(DIGEST);
    expect(facts.volumeList).toBe("orbit_orbit-db-data\nother_orbit-db-data");
  });

  it("refuses when the variable is missing or empty", () => {
    expect(() => parseHostFacts(undefined)).toThrow(HostFactsRefusal);
    expect(() => parseHostFacts("")).toThrow(HostFactsRefusal);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a missing field", JSON.stringify({ targetBasename: b64("x") })],
    ["an unknown field", validFacts({ extra: 1 })],
    ["a mutable version label", validFacts({ imageVersion: "latest" })],
    ["a short revision", validFacts({ imageRevision: "abc" })],
    ["a digest without its algorithm", validFacts({ appliedDigest: "a".repeat(64) })],
    ["a value that is not base64", validFacts({ volumeList: "not base64!" })],
    ["a volume entry with an extra key", validFacts({ volumes: [{ name: b64("v"), labels: null, containers: null, x: 1 }] })],
    ["an empty target basename", validFacts({ targetBasename: "" })],
  ])("refuses malformed facts: %s", (_label, raw) => {
    expect(() => parseHostFacts(raw)).toThrow(HostFactsRefusal);
  });

  it("refuses facts larger than the bound rather than parsing them", () => {
    expect(() => parseHostFacts(validFacts({ volumeList: b64("x".repeat(3 * 1024 * 1024)) }))).toThrow(HostFactsRefusal);
  });
});

describe("parseHostFacts: the target folder (#1570)", () => {
  it("decodes the physical and the logical path of the deployment folder", () => {
    const facts = parseHostFacts(validFacts({ targetFolder: b64("/mnt/data/orbit"), targetFolderLogical: b64("/srv/orbit") }));
    expect(facts.targetFolder).toBe("/mnt/data/orbit");
    expect(facts.targetFolderLogical).toBe("/srv/orbit");
  });

  it("leaves the folders undefined when the shell sent neither", () => {
    const facts = parseHostFacts(validFacts());
    expect(facts.targetFolder).toBeUndefined();
    expect(facts.targetFolderLogical).toBeUndefined();
  });

  it("accepts the physical path alone", () => {
    const facts = parseHostFacts(validFacts({ targetFolder: b64("/srv/orbit") }));
    expect(facts.targetFolder).toBe("/srv/orbit");
    expect(facts.targetFolderLogical).toBeUndefined();
  });

  it("refuses a folder that is not base64", () => {
    expect(() => parseHostFacts(validFacts({ targetFolder: "not base64!" }))).toThrow(HostFactsRefusal);
    expect(() => parseHostFacts(validFacts({ targetFolderLogical: "not base64!" }))).toThrow(HostFactsRefusal);
  });
});

describe("parseHostFacts: container lines with the working_dir label (#1570)", () => {
  const withFolders = (volumeLine: string, projectLine: string) =>
    hostFactsVolumeAdapter(
      parseHostFacts(
        validFacts({
          volumes: [{ name: b64("orbit_orbit-db-data"), labels: b64("orbit|orbit-db-data"), containers: b64(volumeLine) }],
          projects: [{ name: b64("orbit"), containers: b64(projectLine) }],
        }),
      ),
    );

  it("hands four-field lines to the proof as the shell sent them", () => {
    const dbLine = `${"c".repeat(12)}|orbit|orbit-db|/srv/orbit`;
    const appLine = `${"d".repeat(12)}|orbit|orbit-app|/srv/orbit`;
    const adapter = withFolders(dbLine, appLine);
    expect(adapter.listContainersByVolume("orbit_orbit-db-data")).toBe(dbLine);
    expect(adapter.listContainersByProject("orbit")).toBe(appLine);
  });

  it("still parses three-field lines", () => {
    const dbLine = `${"c".repeat(12)}|orbit|orbit-db`;
    const appLine = `${"d".repeat(12)}|orbit|orbit-app`;
    const adapter = withFolders(dbLine, appLine);
    expect(adapter.listContainersByVolume("orbit_orbit-db-data")).toBe(dbLine);
    expect(adapter.listContainersByProject("orbit")).toBe(appLine);
  });
});

describe("hostFactsVolumeAdapter", () => {
  const adapter = hostFactsVolumeAdapter(parseHostFacts(validFacts()));

  it("answers each docker question from the gathered output", () => {
    expect(adapter.listVolumesByKeySubstring("orbit-db-data")).toBe("orbit_orbit-db-data\nother_orbit-db-data");
    expect(adapter.inspectVolumeLabels("orbit_orbit-db-data")).toBe("orbit|orbit-db-data");
    expect(adapter.inspectVolumeProjectLabel("orbit_orbit-db-data")).toBe("orbit");
    expect(adapter.listContainersByVolume("orbit_orbit-db-data")).toBe(`${"c".repeat(12)}|orbit|orbit-db`);
    expect(adapter.listContainersByProject("orbit")).toBe(`${"d".repeat(12)}|orbit|orbit-app`);
    expect(adapter.inspectContainerImage("d".repeat(12))).toBe(`ghcr.io/x/y@${DIGEST}`);
  });

  it("answers like a failed docker call for anything the shell did not gather or could not read", () => {
    expect(adapter.inspectVolumeLabels("other_orbit-db-data")).toBeNull();
    expect(adapter.inspectVolumeProjectLabel("other_orbit-db-data")).toBeNull();
    expect(adapter.listContainersByVolume("absent_orbit-db-data")).toBeNull();
    expect(adapter.listContainersByProject("absent")).toBeNull();
    expect(adapter.inspectContainerImage("e".repeat(12))).toBeNull();
    // The mid-run re-check is the shell's own, after the engine (F1/F3).
    expect(adapter.listVolumesExactName("orbit_orbit-db-data")).toBeNull();
  });

  it("answers a failed volume listing as a failed docker call", () => {
    const failed = hostFactsVolumeAdapter(parseHostFacts(validFacts({ volumeList: null })));
    expect(failed.listVolumesByKeySubstring("orbit-db-data")).toBeNull();
  });

  it("strips the single trailing newline docker's own output ends with, as $(...) did", () => {
    const withNewline = hostFactsVolumeAdapter(parseHostFacts(validFacts({ volumeList: b64("orbit_orbit-db-data\n") })));
    expect(withNewline.listVolumesByKeySubstring("orbit-db-data")).toBe("orbit_orbit-db-data");
  });
});
