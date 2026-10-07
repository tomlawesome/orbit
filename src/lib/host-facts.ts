import { z } from "zod";

import type { DatabaseVolumeSafetyAdapter } from "./database-volume-safety";

// Docker facts the install engine needs, gathered by the host shell (#1212
// build note F3). The engine never touches Docker (#295), so
// scripts/install.sh runs the same `docker` argv the engine's own adapter
// used to spawn -- `volume ls`, `volume inspect`, `ps -a` by volume and by
// project, `inspect` of each application container -- and hands the outputs
// over as JSON in ORBIT_INSTALL_HOST_FACTS. Pattern: injected facts, the
// shape database-volume-safety.ts already took through its adapter.
//
// Every docker output travels base64-encoded, byte for byte as the shell
// captured it, so building the JSON in bash needs no escaping and the engine
// still applies every bound and pattern it applied when it asked Docker
// itself (guarantee #14). A value of null means the shell's docker call
// failed; a fact the shell never gathered answers the same way, so a gap in
// the facts fails closed exactly like a failed docker call did. Anything that
// does not match the schema refuses the run.

/** ORBIT_INSTALL_HOST_FACTS is bounded before it is parsed: the volume listing alone was capped at 1 MiB (install.sh). */
const MAXIMUM_FACTS_BYTES = 2 * 1024 * 1024;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const encoded = z.string().regex(BASE64);
const encodedOrFailed = encoded.nullable();

const hostFactsSchema = z
  .object({
    targetBasename: encoded.min(1),
    cosignUsable: z.boolean(),
    imageVersion: z.string().regex(/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/),
    imageRevision: z.string().regex(/^[0-9a-f]{40}$/),
    appliedDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    volumeList: encodedOrFailed,
    volumes: z.array(z.object({ name: encoded, labels: encodedOrFailed, containers: encodedOrFailed }).strict()).max(256),
    projects: z.array(z.object({ name: encoded, containers: encodedOrFailed }).strict()).max(256),
    images: z.array(z.object({ container: encoded, image: encodedOrFailed }).strict()).max(1024),
  })
  .strict();

export interface HostFacts {
  /** The deployment directory's own name on the host (`basename "$(pwd -P)"`), the Compose project name's last fallback. Inside the engine the directory is always /orbit-deploy. */
  targetBasename: string;
  cosignUsable: boolean;
  imageVersion: string;
  imageRevision: string;
  appliedDigest: string;
  /** `docker volume ls --filter name=orbit-db-data --format '{{.Name}}'`, or null when it failed. */
  volumeList: string | null;
  volumes: ReadonlyMap<string, { labels: string | null; containers: string | null }>;
  projects: ReadonlyMap<string, string | null>;
  images: ReadonlyMap<string, string | null>;
}

export class HostFactsRefusal extends Error {
  constructor() {
    super("The installer's Docker facts are missing or malformed; refusing to continue.");
    this.name = "HostFactsRefusal";
  }
}

/** Bash `$(...)` drops every trailing newline; the facts are compared as the shell would have seen them. */
function decode(value: string): string {
  return Buffer.from(value, "base64").toString("utf8").replace(/\n+$/, "");
}

function decodeOrNull(value: string | null): string | null {
  return value === null ? null : decode(value);
}

/** Parses and validates ORBIT_INSTALL_HOST_FACTS; throws HostFactsRefusal on anything but the exact shape. */
export function parseHostFacts(raw: string | undefined): HostFacts {
  if (raw === undefined || raw === "" || Buffer.byteLength(raw, "utf8") > MAXIMUM_FACTS_BYTES) throw new HostFactsRefusal();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new HostFactsRefusal();
  }
  const parsed = hostFactsSchema.safeParse(json);
  if (!parsed.success) throw new HostFactsRefusal();
  const facts = parsed.data;
  const targetBasename = decode(facts.targetBasename);
  if (targetBasename === "") throw new HostFactsRefusal();
  return {
    targetBasename,
    cosignUsable: facts.cosignUsable,
    imageVersion: facts.imageVersion,
    imageRevision: facts.imageRevision,
    appliedDigest: facts.appliedDigest,
    volumeList: decodeOrNull(facts.volumeList),
    volumes: new Map(facts.volumes.map((volume) => [decode(volume.name), { labels: decodeOrNull(volume.labels), containers: decodeOrNull(volume.containers) }])),
    projects: new Map(facts.projects.map((project) => [decode(project.name), decodeOrNull(project.containers)])),
    images: new Map(facts.images.map((image) => [decode(image.container), decodeOrNull(image.image)])),
  };
}

/**
 * The database-volume-safety adapter answered from the gathered facts
 * (F3: `fromHostFacts`). The mid-run re-check of the recognised volume
 * (`listVolumesExactName`, guarantee #17) is the shell's, after the engine
 * has run, so it is never answered here.
 */
export function hostFactsVolumeAdapter(facts: HostFacts): DatabaseVolumeSafetyAdapter {
  return {
    listVolumesByKeySubstring: () => facts.volumeList,
    listVolumesExactName: () => null,
    inspectVolumeLabels: (volume) => facts.volumes.get(volume)?.labels ?? null,
    inspectVolumeProjectLabel: (volume) => {
      const labels = facts.volumes.get(volume)?.labels;
      if (labels === null || labels === undefined) return null;
      return labels.split("|")[0];
    },
    listContainersByVolume: (volume) => facts.volumes.get(volume)?.containers ?? null,
    listContainersByProject: (project) => facts.projects.get(project) ?? null,
    inspectContainerImage: (container) => facts.images.get(container) ?? null,
  };
}
