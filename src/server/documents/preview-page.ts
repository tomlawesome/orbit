import { AppError } from "@/lib/app-error";
import { PDF_STRUCTURE_MAX_PAGES } from "@/server/documents/validation";

/**
 * The page a preview route was asked for (#1300).
 *
 * Every preview route takes an optional `page` query parameter. Absent, it is
 * page one, so every caller written before page turning answers exactly as it
 * did. Present, it must be a plain whole number from 1 to the structure
 * check's own page cap: no sign, no decimal point, no exponent, no leading
 * zero, no whitespace. Anything else is refused here, before the document is
 * read, decrypted or scanned. Whether the page exists is only known once the
 * document has passed every existing check, so that refusal is the
 * renderer's (`documentPreviewPageNotFound`).
 */
export const DOCUMENT_PREVIEW_PAGE_PARAMETER = "page";

/** The response header that carries the document's page count. */
export const DOCUMENT_PREVIEW_PAGE_COUNT_HEADER = "X-Orbit-Page-Count";

const WHOLE_PAGE_NUMBER = /^[1-9][0-9]{0,6}$/u;

export function documentPreviewPageInvalid(): AppError {
  return new AppError(
    "document_preview_page_invalid",
    `The page must be a whole number from 1 to ${PDF_STRUCTURE_MAX_PAGES}`,
    400,
  );
}

export function documentPreviewPageNotFound(): AppError {
  return new AppError(
    "document_preview_page_not_found",
    "That page is past the end of this document",
    404,
  );
}

/** Reads the `page` parameter: 1 when absent, otherwise a bounded whole number or a 400. */
export function parseDocumentPreviewPage(searchParams: URLSearchParams): number {
  const values = searchParams.getAll(DOCUMENT_PREVIEW_PAGE_PARAMETER);
  if (values.length === 0) return 1;
  if (values.length > 1) throw documentPreviewPageInvalid();
  const [raw] = values;
  if (!WHOLE_PAGE_NUMBER.test(raw)) throw documentPreviewPageInvalid();
  const page = Number(raw);
  if (page > PDF_STRUCTURE_MAX_PAGES) throw documentPreviewPageInvalid();
  return page;
}
