import { AppError } from "@/lib/app-error";

/**
 * The page a preview route was asked for (#1300).
 *
 * Every preview route takes an optional `page` query parameter. Absent, it is
 * page one, so every caller written before page turning answers exactly as it
 * did. Present, it must be a plain whole number from 1 to
 * `DOCUMENT_PREVIEW_MAX_PAGE`: no sign, no decimal point, no exponent, no leading
 * zero, no whitespace. Anything else is refused here, before the document is
 * read, decrypted or scanned. Whether the page exists is only known once the
 * document has passed every existing check, so that refusal is the
 * renderer's (`documentPreviewPageNotFound`).
 */
export const DOCUMENT_PREVIEW_PAGE_PARAMETER = "page";

/** The response header that carries the document's page count. */
export const DOCUMENT_PREVIEW_PAGE_COUNT_HEADER = "X-Orbit-Page-Count";

/**
 * The highest page any stored document can have: the structure check's cap
 * was 1,000 before #1436 lowered it to 100, and documents accepted then keep
 * their pages. Pages past 100 are drawn when viewed, up to the document's
 * stored page count (owner answer 10a); past that count is a 404.
 */
export const DOCUMENT_PREVIEW_MAX_PAGE = 1_000;

const WHOLE_PAGE_NUMBER = /^[1-9][0-9]{0,6}$/u;

export function documentPreviewPageInvalid(): AppError {
  return new AppError(
    "document_preview_page_invalid",
    `The page must be a whole number from 1 to ${DOCUMENT_PREVIEW_MAX_PAGE}`,
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
  if (page > DOCUMENT_PREVIEW_MAX_PAGE) throw documentPreviewPageInvalid();
  return page;
}
