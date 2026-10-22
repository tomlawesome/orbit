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
 * its own version, in the background; a read never waits on a live probe
 * (#1465). What a probe last read stands until the next probe reads another
 * (a failed or unreadable one keeps it). A sidecar that is switched off says
 * so, and one that has never been read is `version: null`, which the page
 * draws as "not known" unless the compose file pins a tag for it (the page
 * falls back to that, marked pinned; web/src/lib/about/group.js). Nothing is
 * guessed.
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

/** A saved version is asked for again once it is this old (stale-while-revalidate). */
const REFRESH_AFTER_MS = 10 * 60 * 1_000;

/**
 * How long a look with nothing saved yet waits for the probe it starts. The
 * server warms the saved answer at start-up (warmAboutFacts), so this is the
 * case of a service not read yet or never readable. Long enough for a service
 * on the same host to reply, far short of the probe's own 2 s limit: the page
 * never waits on a slow or dead service (#1465).
 */
const FIRST_LOOK_MS = 5;

interface Saved {
  /** The last version a probe read; kept when a later probe fails. */
  version: string | null;
  savedAt: number;
  inFlight: Promise<void> | null;
}

/**
 * Saved service versions, per probe set (the live set is one object for the
 * life of the process; a test's own set is its own entry).
 */
const SAVED = new WeakMap<AboutProbes, Map<AboutSidecarId, Saved>>();

function savedFor(probes: AboutProbes, id: AboutSidecarId): Saved {
  let rows = SAVED.get(probes);
  if (!rows) SAVED.set(probes, (rows = new Map()));
  let row = rows.get(id);
  if (!row) rows.set(id, (row = { version: null, savedAt: 0, inFlight: null }));
  return row;
}

/** Starts one probe for this service unless one is already out. Never rejects. */
function refresh(
  row: Saved,
  ask: () => Promise<string | null>,
  parse: (answer: string | null) => string | null,
): Promise<void> {
  if (row.inFlight) return row.inFlight;
  const started = (async () => {
    try {
      const version = parse(await withTimeout(Promise.resolve().then(ask), null));
      /* A failed or silent probe never replaces what was seen before. */
      if (version !== null) {
        row.version = version;
        row.savedAt = Date.now();
      }
    } catch {
      /* the saved answer stands */
    }
  })().finally(() => {
    row.inFlight = null;
  });
  row.inFlight = started;
  return started;
}

/** Waits for `work` for at most `ms`; the timer never holds the process open. */
function waitUpTo(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void work.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * The saved version, served as it stands (stale-while-revalidate, #1465).
 * Nothing saved: start the probe and give it a moment, then say null. Saved
 * but old: serve it and refresh in the background. Never waits on a live
 * probe beyond that first moment.
 */
async function probe(
  probes: AboutProbes,
  id: AboutSidecarId,
  on: boolean,
  ask: () => Promise<string | null>,
  parse: (answer: string | null) => string | null,
): Promise<AboutSidecar> {
  if (!on) return { id, state: "off", version: null };
  const row = savedFor(probes, id);
  if (row.savedAt === 0) {
    await waitUpTo(refresh(row, ask, parse), FIRST_LOOK_MS);
  } else if (Date.now() - row.savedAt > REFRESH_AFTER_MS) {
    void refresh(row, ask, parse);
  }
  return { id, state: "running", version: row.version };
}

/** The four rows, each with how to ask it and how to read its answer. */
function plan(probes: AboutProbes) {
  const on = (check: () => boolean) => {
    try {
      return check();
    } catch {
      return false;
    }
  };
  return [
    { id: "postgres", on: true, ask: probes.postgres, parse: (answer: string | null) => versionAfter("PostgreSQL", answer) },
    { id: "tika", on: on(probes.tikaOn), ask: probes.tika, parse: (answer: string | null) => versionAfter("Tika", answer) },
    { id: "clamav", on: on(probes.clamavOn), ask: probes.clamav, parse: (answer: string | null) => versionAfter("ClamAV", answer) },
    { id: "ollama", on: on(probes.ollamaOn), ask: probes.ollama, parse: versionOnly },
  ] as const;
}

/**
 * Starts every switched-on service's probe in the background and returns at
 * once (#1465), so the first visit after a restart already has versions.
 * Shares the in-flight probes with getAboutFacts; never rejects.
 */
export function warmAboutFacts(probes: AboutProbes = LIVE_PROBES): void {
  try {
    for (const one of plan(probes)) {
      if (one.on) void refresh(savedFor(probes, one.id), one.ask, one.parse);
    }
  } catch {
    /* warming is a courtesy: the first visit probes for itself */
  }
}

/**
 * Never throws and never waits on a live probe for long: a failing probe
 * costs its own row's version, nothing more.
 */
export async function getAboutFacts(
  probes: AboutProbes = LIVE_PROBES,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AboutFacts> {
  const sidecars = await Promise.all(plan(probes).map((one) => probe(probes, one.id, one.on, one.ask, one.parse)));
  return {
    build: { ...readBuildInfo(), image: imageOf(environment.ORBIT_IMAGE) },
    node: versionOnly(process.version) ? process.version : null,
    sidecars,
  };
}
