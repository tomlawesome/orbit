import { z } from "zod";
import { AppError } from "@/lib/errors";

const uuidSchema = z.uuid();

/**
 * The one answer to "is this text a UUID" (#1334). Every engine check goes
 * through here, so the answers cannot drift: the copies this replaced differed
 * on case, on which versions they accepted (one refused version 7) and on
 * whether any hex digit would do.
 *
 * A malformed id has to be refused before it reaches a uuid column: the
 * database driver runs without prepared statements, so a bad literal arrives
 * as text and surfaces as an unclassifiable driver error, a 500 (#383).
 */
export function validUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

/** Returns the id, or refuses it with 422 `invalid_identifier` naming `field`. */
export function requireUuid(value: string, field: string): string {
  if (!validUuid(value)) throw new AppError("invalid_identifier", `${field} is not a valid identifier`, 422);
  return value;
}
