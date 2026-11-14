/**
 * Source-checkout entry point for the KEK rewrap worker (#932): `pnpm rewrap-kek
 * --next-key-file <path>`. The command itself is runRewrapKek
 * (./rewrap-kek-run), which `orbit rewrap-kek` in the app container also
 * calls (#1635). Run this only after the running application has
 * also been given the next key via `DOCUMENT_KEK_NEXT`/`DOCUMENT_KEK_NEXT_FILE`
 * (#954, ADR-0024 decision 4) — see docs/administrator-operations.md,
 * "Rotating the document key-encryption key", for the full procedure. With
 * the next key loaded application-side, every row stays readable throughout:
 * one already moved to the next key, and one the worker has not reached yet,
 * are both readable by their own `key_id`.
 *
 * The current key comes from the ordinary runtime configuration
 * (`DOCUMENT_KEK`/`DOCUMENT_KEK_FILE`, unchanged); the next key is read only
 * from the file this command is given, exactly once, and never touches
 * configuration or the environment. Rotation is always an operator decision
 * (#932 scope): nothing here runs on a schedule or in response to anything
 * but this explicit invocation.
 */
import { runRewrapKek } from "./rewrap-kek-run";

void runRewrapKek(process.argv.slice(2));
