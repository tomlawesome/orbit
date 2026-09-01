import { AppError } from "@/lib/app-error";
import { log } from "@/lib/logger";
import { getDocumentConfig } from "@/server/documents/config";
import type { SupportedDocumentMediaType } from "@/server/documents/validation";

const MAX_EXTRACTED_CHARACTERS = 250_000;
const MAX_EXTRACTED_BYTES = MAX_EXTRACTED_CHARACTERS * 4;

/**
 * Fixed failure vocabulary. The parser handles hostile documents, so its own
 * output and any caught error text must never reach a log record.
 */
type ParserFailure =
  | "unreachable"
  | "rejected"
  | "unexpected_content_type"
  | "oversized_response"
  | "undecodable_response";

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function parserUnavailable(document: string, startedAt: number, reason: ParserFailure): AppError {
  log.warn({
    event: "document.parse",
    state: "degraded",
    reason,
    action: "check_parser",
    impact: "document_processing_blocked",
    durationMs: elapsedMilliseconds(startedAt),
  });
  return new AppError("parser_unavailable", "Document processing is unavailable", 503);
}

function hasPlainTextContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  if (!contentType) return false;
  return contentType.split(";", 1)[0].trim().toLowerCase() === "text/plain";
}

function hasAcceptableContentLength(response: Response): boolean {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null) return true;
  const normalized = contentLength.trim();
  if (!/^\d+$/.test(normalized)) return false;
  const bytes = Number(normalized);
  return Number.isSafeInteger(bytes) && bytes <= MAX_EXTRACTED_BYTES;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The response is already being rejected; cancellation details are not safe to expose.
  }
}

async function readBoundedText(body: ReadableStream<Uint8Array>, document: string, startedAt: number): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array) || result.value.byteLength > MAX_EXTRACTED_BYTES - totalBytes) {
        await cancelReader(reader);
        throw parserUnavailable(document, startedAt, "oversized_response");
      }
      if (result.value.byteLength === 0) continue;
      chunks.push(result.value);
      totalBytes += result.value.byteLength;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw parserUnavailable(document, startedAt, "unreachable");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Keep all stream failures within the bounded parser error contract.
    }
  }

  try {
    const bytes = Buffer.concat(chunks, totalBytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).slice(0, MAX_EXTRACTED_CHARACTERS);
  } catch {
    throw parserUnavailable(document, startedAt, "undecodable_response");
  }
}

export interface TikaHealth {
  status: "disabled" | "ready" | "unavailable";
}

/**
 * Sends document bytes directly to the private Tika service. No URL, Orbit
 * credential, or database access is ever given to the parser service.
 */
export async function extractTextWithTika(
  bytes: Buffer,
  mediaType: SupportedDocumentMediaType,
  document: string,
): Promise<string> {
  const config = getDocumentConfig();
  if (!config.tika.url) throw new AppError("parser_disabled", "Document processing is not enabled", 409);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.tika.timeoutMs);
  const startedAt = Date.now();
  log.info({ event: "document.parse", state: "starting", action: "check_parser" });
  try {
    const response = await fetch(new URL("/tika", config.tika.url), {
      method: "PUT",
      headers: {
        Accept: "text/plain",
        "Content-Type": mediaType,
      },
      body: new Uint8Array(bytes),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || response.type === "opaqueredirect" || response.redirected) {
      throw parserUnavailable(document, startedAt, "rejected");
    }
    if (!hasPlainTextContentType(response) || !hasAcceptableContentLength(response) || !response.body) {
      throw parserUnavailable(document, startedAt, "unexpected_content_type");
    }
    const text = await readBoundedText(response.body, document, startedAt);
    // Character count only. Extracted text is hostile content and never logged.
    log.info({
      event: "document.parse",
      state: "ready",
      action: "none",
      durationMs: elapsedMilliseconds(startedAt),
    });
    return text;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw parserUnavailable(document, startedAt, "unreachable");
  } finally {
    clearTimeout(timer);
  }
}

export async function getTikaHealth(): Promise<TikaHealth> {
  const config = getDocumentConfig();
  if (!config.tika.url) return { status: "disabled" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.tika.timeoutMs, 5_000));
  try {
    const response = await fetch(new URL("/version", config.tika.url), {
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
    return { status: response.ok ? "ready" : "unavailable" };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
