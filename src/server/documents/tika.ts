import { AppError } from "@/lib/app-error";
import { getDocumentConfig } from "@/server/documents/config";

const MAX_EXTRACTED_CHARACTERS = 250_000;

export interface TikaHealth {
  status: "disabled" | "ready" | "unavailable";
}

/**
 * Sends document bytes directly to the private Tika service. No URL, Orbit
 * credential, or database access is ever given to the parser service.
 */
export async function extractTextWithTika(bytes: Buffer, mediaType: string): Promise<string> {
  const config = getDocumentConfig();
  if (!config.tika.url) throw new AppError("parser_disabled", "Document processing is not enabled", 409);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.tika.timeoutMs);
  try {
    const response = await fetch(new URL("/tika/text", config.tika.url), {
      method: "PUT",
      headers: { Accept: "text/plain", "Content-Type": mediaType },
      body: new Uint8Array(bytes),
      signal: controller.signal,
    });
    if (!response.ok) throw new AppError("parser_unavailable", "Document processing is unavailable", 503);
    return (await response.text()).slice(0, MAX_EXTRACTED_CHARACTERS);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("parser_unavailable", "Document processing is unavailable", 503);
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
    const response = await fetch(new URL("/version", config.tika.url), { signal: controller.signal, cache: "no-store" });
    return { status: response.ok ? "ready" : "unavailable" };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
