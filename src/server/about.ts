import { sql } from "drizzle-orm";

import { getDb } from "@/db";
import { readBuildInfo, withTimeout, type AdministratorBuildInfo } from "@/server/admin-health";
import { getDocumentConfig } from "@/server/documents/config";
import { readExtractionModelVersion, selectedExtractionModel } from "@/server/documents/model-extraction";
import { readClamAvVersion } from "@/server/documents/scanner";
import { readTikaVersion } from "@/server/documents/tika";

/**
 * What this Orbit runs on, for the About page's first card (#1256).
 *
 * Any signed-in member reads it, so it carries what the shipped product is
 * and nothing about where it runs: versions and the image reference only,
 * never a hostname, URL, port, error string or path. Each sidecar is asked
 * its own version; a sidecar that is switched off says so, and one whose
 * answer cannot be read is `version: null`, which the page draws as
 * "not known". Nothing is guessed.
 */

export type AboutSidecarId = "postgres" | "tika" | "clamav" | "ollama";

export interface AboutSidecar {
  id: AboutSidecarId;
  state: "running" | "off";
  version: string | null;
}

export interface AboutFacts {
  build: AdministratorBuildInfo & { image: string | null };
  node: string | null;
  sidecars: AboutSidecar[];
}

/** A version is a short run of these characters, or it is not one we show. */
const VERSION_SHAPE = /^[0-9][0-9A-Za-z.+_-]{0,39}$/;

/** First version-shaped word after the given product name, e.g. "PostgreSQL 18.0 on …" → "18.0". */
export function versionAfter(product: string, answer: string | null | undefined): string | null {
  if (typeof answer !== "string") return null;
  const words = answer.trim().split(/[\s/]+/);
  const at = words.findIndex((word) => word.toLowerCase() === product.toLowerCase());
  const candidate = at >= 0 ? words[at + 1] : undefined;
  return candidate && VERSION_SHAPE.test(candidate) ? candidate : null;
}

/** Only ever a version-shaped string, or null. */
export function versionOnly(answer: string | null | undefined): string | null {
  if (typeof answer !== "string") return null;
  const trimmed = answer.trim().replace(/^v(?=\d)/, "");
  return VERSION_SHAPE.test(trimmed) ? trimmed : null;
}

/**
 * The image this container was started from, as the launcher passed it
 * through compose (#1256, owner answer 9). A digest reference is reduced to
 * its digest, so a registry's host name never reaches the page; anything else
 * is a local build tag and is shown as given.
 */
export function imageOf(reference: string | undefined): string | null {
  const value = (reference ?? "").trim();
  if (!value) return null;
  const digest = /@(sha256:[a-f0-9]{64})$/i.exec(value);
  return digest ? digest[1].toLowerCase() : value;
}

export interface AboutProbes {
  postgres: () => Promise<string | null>;
  tika: () => Promise<string | null>;
  clamav: () => Promise<string | null>;
  ollama: () => Promise<string | null>;
  tikaOn: () => boolean;
  clamavOn: () => boolean;
  ollamaOn: () => boolean;
}

async function postgresVersion(): Promise<string | null> {
  const rows = await getDb().execute(sql`select version() as version`);
  const row = (rows as unknown as { version?: unknown }[])[0];
  return typeof row?.version === "string" ? row.version : null;
}

function documentConfigOrNull() {
  try {
    return getDocumentConfig();
  } catch {
    return null;
  }
}

const LIVE_PROBES: AboutProbes = {
  postgres: postgresVersion,
  tika: readTikaVersion,
  clamav: async () => {
    const config = documentConfigOrNull();
    if (!config) return null;
    return readClamAvVersion({ ...config.clamAv, timeoutMs: Math.min(config.clamAv.timeoutMs, 2_000) });
  },
  ollama: readExtractionModelVersion,
  tikaOn: () => Boolean(documentConfigOrNull()?.tika.url),
  clamavOn: () => documentConfigOrNull()?.scanMode !== "disabled",
  ollamaOn: () => selectedExtractionModel() !== undefined,
};

async function probe(
  id: AboutSidecarId,
  on: boolean,
  ask: () => Promise<string | null>,
  parse: (answer: string | null) => string | null,
): Promise<AboutSidecar> {
  if (!on) return { id, state: "off", version: null };
  const answer = await withTimeout(ask(), null);
  return { id, state: "running", version: parse(answer) };
}

/** Never throws: a failing probe costs its own row's version, nothing more. */
export async function getAboutFacts(
  probes: AboutProbes = LIVE_PROBES,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AboutFacts> {
  const on = (check: () => boolean) => {
    try {
      return check();
    } catch {
      return false;
    }
  };
  const sidecars = await Promise.all([
    probe("postgres", true, probes.postgres, (answer) => versionAfter("PostgreSQL", answer)),
    probe("tika", on(probes.tikaOn), probes.tika, (answer) => versionAfter("Tika", answer)),
    probe("clamav", on(probes.clamavOn), probes.clamav, (answer) => versionAfter("ClamAV", answer)),
    probe("ollama", on(probes.ollamaOn), probes.ollama, versionOnly),
  ]);
  return {
    build: { ...readBuildInfo(), image: imageOf(environment.ORBIT_IMAGE) },
    node: versionOnly(process.version) ? process.version : null,
    sidecars,
  };
}
