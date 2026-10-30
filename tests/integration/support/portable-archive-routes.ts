/**
 * Posting an archive upload to the preview and import routes (#1566), with a
 * fixture session, and the step-up proof the import asks for (#1132). The
 * body is the platform's own multipart serialisation of the client's form
 * (`./portable-archive-upload`).
 */
import { sealStepUpProof, stepUpProofCookieName, type StepUpIntent } from "@/lib/auth/recent-auth";
import { getAuthConfig } from "@/lib/env";
import type { IntegrationSession } from "./fixtures";
import { encodeForm } from "./portable-archive-upload";
import { callRouteForSession, type RouteHandler } from "./request-event";

export const ARCHIVE_ORIGIN = "http://127.0.0.1:3000";

/** The session cookie plus a fresh step-up proof for `intent`. */
export async function proofCookie(session: IntegrationSession, intent: StepUpIntent): Promise<string> {
  const config = getAuthConfig();
  const proof = await sealStepUpProof(session.sessionId, intent, config);
  return `${session.headers.cookie}; ${stepUpProofCookieName(config)}=${proof}`;
}

export interface UploadCall {
  /** `/api/portable-archives/preview` or `/import`. */
  path: string;
  session: IntegrationSession;
  /** The raw body and its content type, when a test needs to control them. */
  body: BodyInit;
  contentType: string;
  cookie?: string;
}

export function postUpload(handler: RouteHandler, call: UploadCall): Promise<Response> {
  return callRouteForSession(handler, call.session, {
    url: `${ARCHIVE_ORIGIN}${call.path}`,
    method: "POST",
    headers: { "content-type": call.contentType, ...(call.cookie ? { cookie: call.cookie } : {}) },
    body: call.body,
  });
}

/** Posts the client's form, serialised exactly as the platform does. */
export async function postForm(handler: RouteHandler, path: string, session: IntegrationSession, form: FormData, cookie?: string): Promise<Response> {
  const upload = await encodeForm(form);
  return postUpload(handler, { path, session, body: new Uint8Array(upload.bytes), contentType: upload.contentType, cookie });
}

export async function errorOf(response: Response): Promise<{ code?: string; message?: string; issues?: Array<{ path: Array<string | number> }> }> {
  const body = (await response.clone().json()) as { error?: { code?: string; message?: string; issues?: Array<{ path: Array<string | number> }> } };
  return body.error ?? {};
}
