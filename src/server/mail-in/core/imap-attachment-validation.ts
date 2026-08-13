/**
 * mail-in/core boundary: pure parsing logic only. No `getDb`/`db`/schema
 * imports and no `imapflow` import — see src/server/mail-in/README.md.
 * Moved as-is from src/server/imap-attachment-validation.ts as part of the
 * #298 module split.
 */
import { detectDocumentMediaType, validateSupportedDocumentStructure, type SupportedDocumentMediaType } from "@/server/documents/validation";

/** Fixed defaults for hostile provider input. Values are intentionally not provider-controlled. */
export const IMAP_ATTACHMENT_LIMITS = Object.freeze({
  rawMessageBytes: 25 * 1024 * 1024,
  attachmentCount: 10,
  aggregateAttachmentBytes: 25 * 1024 * 1024,
  mimePartCount: 100,
  mimeNestingDepth: 10,
  displayNameBytes: 180,
});

export type ImapAttachmentValidationCode =
  | "attachment_count_exceeded"
  | "attachment_total_too_large"
  | "document_too_large"
  | "mime_part_count_exceeded"
  | "mime_nesting_too_deep"
  | "mime_structure_invalid"
  | "mime_type_mismatch"
  | "document_type_unsupported";

export interface ImapAttachmentCandidate {
  part: string;
  filename?: string;
  declaredMediaType?: string;
  sizeBytes?: number;
}

export interface ImapBodyStructureClassification {
  ok: boolean;
  code?: ImapAttachmentValidationCode;
  candidates: ImapAttachmentCandidate[];
  partCount: number;
  totalBytes: number;
}

type HostileBodyStructure = {
  part?: unknown;
  type?: unknown;
  subtype?: unknown;
  contentType?: unknown;
  disposition?: unknown;
  dispositionParameters?: unknown;
  parameters?: unknown;
  filename?: unknown;
  size?: unknown;
  childNodes?: unknown;
};

function record(value: unknown): HostileBodyStructure | undefined {
  return value !== null && typeof value === "object" ? value as HostileBodyStructure : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mediaType(node: HostileBodyStructure): string | undefined {
  const explicit = stringValue(node.contentType);
  if (explicit) return explicit.toLowerCase().split(";", 1)[0].trim();
  const type = stringValue(node.type);
  const subtype = stringValue(node.subtype);
  return type && subtype ? `${type}/${subtype}`.toLowerCase() : undefined;
}

function parameter(node: HostileBodyStructure, key: string): string | undefined {
  for (const source of [node.dispositionParameters, node.parameters]) {
    if (!source || typeof source !== "object") continue;
    const entries = Object.entries(source as Record<string, unknown>);
    const match = entries.find(([name]) => name.toLowerCase() === key);
    const value = match?.[1];
    if (typeof value === "string") return value;
  }
  return stringValue(node.filename);
}

function failure(code: ImapAttachmentValidationCode, state: { candidates: ImapAttachmentCandidate[]; partCount: number; totalBytes: number }): ImapBodyStructureClassification {
  return { ok: false, code, ...state };
}

/**
 * Validates provider BODYSTRUCTURE metadata without retaining message bytes.
 * Only named leaf attachment/inline parts are candidates; multipart and
 * message/rfc822 containers are never downloaded as files.
 */
export function classifyImapBodyStructure(
  input: unknown,
  options: { maxDocumentBytes?: number; mailboxPdfOnly?: boolean } = {},
): ImapBodyStructureClassification {
  const maximumDocumentBytes = options.maxDocumentBytes ?? IMAP_ATTACHMENT_LIMITS.aggregateAttachmentBytes;
  const candidates: ImapAttachmentCandidate[] = [];
  const state = { candidates, partCount: 0, totalBytes: 0 };
  const seenParts = new Set<string>();
  let structuralFailure: ImapAttachmentValidationCode | undefined;

  const visit = (value: unknown, depth: number): void => {
    if (structuralFailure) return;
    const node = record(value);
    if (!node || !Number.isInteger(depth) || depth < 1) {
      structuralFailure = "mime_structure_invalid";
      return;
    }
    if (depth > IMAP_ATTACHMENT_LIMITS.mimeNestingDepth) {
      structuralFailure = "mime_nesting_too_deep";
      return;
    }
    state.partCount += 1;
    if (state.partCount > IMAP_ATTACHMENT_LIMITS.mimePartCount) {
      structuralFailure = "mime_part_count_exceeded";
      return;
    }
    const children = node.childNodes;
    if (children !== undefined && !Array.isArray(children)) {
      structuralFailure = "mime_structure_invalid";
      return;
    }
    const part = stringValue(node.part);
    if (node.part !== undefined && (!part || !/^(?:\d+)(?:\.\d+)*$/u.test(part))) {
      structuralFailure = "mime_structure_invalid";
      return;
    }
    if (part) {
      if (seenParts.has(part)) {
        structuralFailure = "mime_structure_invalid";
        return;
      }
      seenParts.add(part);
    }
    if (children && children.length > 0) {
      for (const child of children) visit(child, depth + 1);
      return;
    }
    if (!part) {
      if (depth > 1) structuralFailure = "mime_structure_invalid";
      return;
    }
    const declaredMediaType = mediaType(node);
    const disposition = stringValue(node.disposition)?.toLowerCase();
    const filename = parameter(node, "filename") ?? parameter(node, "name");
    const rawSize = node.size;
    if (rawSize !== undefined && (!Number.isSafeInteger(rawSize) || (rawSize as number) < 0)) {
      structuralFailure = "mime_structure_invalid";
      return;
    }
    const sizeBytes = rawSize as number | undefined;
    const claimsPdf = declaredMediaType === "application/pdf" || filename?.toLowerCase().endsWith(".pdf") === true;
    const isCandidate = options.mailboxPdfOnly
      ? claimsPdf
      : disposition === "attachment" || disposition === "inline";
    if (!isCandidate) return;
    if (sizeBytes !== undefined && sizeBytes > maximumDocumentBytes) {
      structuralFailure = "document_too_large";
      return;
    }
    if (sizeBytes !== undefined && state.totalBytes + sizeBytes > IMAP_ATTACHMENT_LIMITS.aggregateAttachmentBytes) {
      structuralFailure = "attachment_total_too_large";
      return;
    }
    candidates.push({ part, filename, declaredMediaType, sizeBytes });
    state.totalBytes += sizeBytes ?? 0;
    if (candidates.length > IMAP_ATTACHMENT_LIMITS.attachmentCount) structuralFailure = "attachment_count_exceeded";
  };

  visit(input, 1);
  return structuralFailure ? failure(structuralFailure, state) : { ok: true, ...state };
}

const bidiOrControl = /[\u0000-\u001f\u007f\u0080-\u009f\u202a-\u202e\u2066-\u2069]/gu;

/** Converts an untrusted provider name into display-only text, never a key. */
export function normalizeImapAttachmentName(input: string | undefined, mediaType: SupportedDocumentMediaType): string {
  const fallback = mediaType === "application/pdf" ? "document.pdf"
    : mediaType === "image/jpeg" ? "document.jpg" : "document.png";
  const leaf = (input ?? "").replaceAll("\\", "/").split("/").pop() ?? "";
  const normalized = leaf.normalize("NFKC").replace(bidiOrControl, "").replace(/\s+/gu, " ").trim();
  if (!normalized) return fallback;
  let result = "";
  for (const character of normalized) {
    if (Buffer.byteLength(result + character, "utf8") > IMAP_ATTACHMENT_LIMITS.displayNameBytes) break;
    result += character;
  }
  return result || fallback;
}

export async function validateImapAttachmentBytes(
  bytes: Buffer,
  declaredMediaType: string | undefined,
  maximumDocumentBytesOrOptions: number | { maximumDocumentBytes?: number; pdfOnly?: boolean } = IMAP_ATTACHMENT_LIMITS.aggregateAttachmentBytes,
): Promise<{ ok: true; mediaType: SupportedDocumentMediaType } | { ok: false; code: ImapAttachmentValidationCode }> {
  const maximumDocumentBytes = typeof maximumDocumentBytesOrOptions === "number"
    ? maximumDocumentBytesOrOptions
    : maximumDocumentBytesOrOptions.maximumDocumentBytes ?? IMAP_ATTACHMENT_LIMITS.aggregateAttachmentBytes;
  const pdfOnly = typeof maximumDocumentBytesOrOptions === "object" && maximumDocumentBytesOrOptions.pdfOnly === true;
  if (bytes.length < 1 || bytes.length > maximumDocumentBytes) return { ok: false, code: "document_too_large" };
  let detected: SupportedDocumentMediaType;
  try {
    detected = detectDocumentMediaType(bytes);
  } catch {
    return { ok: false, code: "document_type_unsupported" };
  }
  const declared = declaredMediaType?.toLowerCase().split(";", 1)[0].trim();
  if (declared && declared !== detected) return { ok: false, code: "mime_type_mismatch" };
  if (pdfOnly && detected !== "application/pdf") return { ok: false, code: "mime_type_mismatch" };
  if (!await validateSupportedDocumentStructure(bytes, detected)) return { ok: false, code: "mime_structure_invalid" };
  return { ok: true, mediaType: detected };
}
