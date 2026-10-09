import { z } from "zod";

/**
 * Currency codes and time zones are checked against the platform's own lists
 * (`Intl.supportedValuesOf`), the standard "validate against the list the
 * runtime already ships" (#1333): a code the runtime cannot format is a code
 * Orbit cannot show, so it is not stored. The one place the lists are read.
 */
const currencies = new Set<string>(Intl.supportedValuesOf("currency"));

export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && currencies.has(value);
}

export const currencyCode = z.string().refine(isCurrencyCode, { message: "Use a currency code such as GBP" });

/*
 * The runtime lists each zone under one spelling and leaves "UTC" off it,
 * though every browser offers it and `Intl.DateTimeFormat` takes it. So the
 * list is the platform's plus UTC, and a name the platform spells another way
 * (Asia/Kolkata for Asia/Calcutta) is taken when the platform resolves it to a
 * listed zone. A different capitalisation is not an alias: it is refused.
 */
const zones = new Set<string>([...Intl.supportedValuesOf("timeZone"), "UTC"]);

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (zones.has(value)) return true;
  try {
    const resolved = new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
    return zones.has(resolved) && resolved.toLowerCase() !== value.toLowerCase();
  } catch {
    return false;
  }
}

export const timeZoneName = z.string().refine(isTimeZone, { message: "Use a time zone such as Europe/London" });
