"use client";

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { FocusDialog } from "@/components/focus-dialog";
import { carriesFiles, leavesDropZone } from "@/components/document-drop";
import { isReady, progressDescription } from "@/components/document-state";

export interface ItemDocument {
  id: string;
  itemId: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  lifecycle: string;
  scanStatus: string;
  availableAt: string | null;
  deleteAfter: string | null;
  /** Whether the content can be opened yet; derived when absent. */
  ready?: boolean;
  failureCode?: string | null;
}


interface UploadingDocument {
  id: string;
  name: string;
  progress: number;
}
interface CaptureReview { file: File; bitmap: ImageBitmap; rotation: number }
interface DraftReview { title: string; provider: string; reference: string }

interface DocumentManagerProps {
  householdId: string;
  itemId: string;
  sectionId: string;
  csrfToken: string;
  sectionNumber: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CapturedPhotoPreview({ bitmap, rotation }: Pick<CaptureReview, "bitmap" | "rotation">) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  }, [bitmap]);

  return <canvas ref={canvasRef} role="img" aria-label="Captured document preview" style={{ transform: `rotate(${rotation}deg)` }} />;
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: string; error?: { message?: string } };
    return body.message ?? body.error?.message ?? "The document action could not be completed.";
  } catch {
    return "The document action could not be completed.";
  }
}

/** Keeps document transfers outside the offline workspace queue. */
export function DocumentManager({ householdId, itemId, sectionId, csrfToken, sectionNumber }: DocumentManagerProps) {
  const inputId = useId();
  const cameraInputId = useId();
  const [documents, setDocuments] = useState<ItemDocument[]>([]);
  const [uploading, setUploading] = useState<UploadingDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [failedUploads, setFailedUploads] = useState<File[]>([]);
  const [captureReview, setCaptureReview] = useState<CaptureReview | null>(null);
  const [draft, setDraft] = useState<{ id: string; proposal: { title: string; provider?: string; reference?: string }; evidence: { excerpt: string }; duplicates?: Array<{ itemId: string; title: string; reason: string }> } | null>(null);
  const [draftReview, setDraftReview] = useState<DraftReview>({ title: "", provider: "", reference: "" });
  const [draftApprovalBusy, setDraftApprovalBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const listUrl = `/api/households/${encodeURIComponent(householdId)}/items/${encodeURIComponent(itemId)}/documents`;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(listUrl, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as { documents: ItemDocument[] };
      setDocuments(payload.documents);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Documents could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [listUrl]);

  useEffect(() => {
    const task = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(task);
  }, [refresh]);

  useEffect(() => {
    const bitmap = captureReview?.bitmap;
    return () => bitmap?.close();
  }, [captureReview?.bitmap]);

  useEffect(() => {
    // Without this the browser navigates away from Orbit when a file is
    // dropped anywhere outside the zone, silently discarding unsaved work.
    const ignoreStrayFileDrop = (event: globalThis.DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", ignoreStrayFileDrop);
    window.addEventListener("drop", ignoreStrayFileDrop);
    return () => {
      window.removeEventListener("dragover", ignoreStrayFileDrop);
      window.removeEventListener("drop", ignoreStrayFileDrop);
    };
  }, []);

  function updateUpload(id: string, patch: Partial<UploadingDocument>) {
    setUploading((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
  }

  function upload(file: File): Promise<void> {
    const uploadId = crypto.randomUUID();
    setUploading((current) => [...current, { id: uploadId, name: file.name, progress: 0 }]);
    setMessage(`Uploading ${file.name}.`);
    setError("");
    return new Promise((resolve) => {
      const request = new XMLHttpRequest();
      request.open("POST", listUrl);
      request.withCredentials = true;
      request.setRequestHeader("X-CSRF-Token", csrfToken);
      request.setRequestHeader("X-Orbit-Filename", encodeURIComponent(file.name));
      request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) updateUpload(uploadId, { progress: Math.round((event.loaded / event.total) * 100) });
      };
      request.onerror = () => {
        setError(`Could not upload ${file.name}. Check your connection and try again.`);
        setUploading((current) => current.filter((entry) => entry.id !== uploadId));
        setFailedUploads((current) => [...current, file]);
        resolve();
      };
      request.onload = () => {
        setUploading((current) => current.filter((entry) => entry.id !== uploadId));
        if (request.status < 200 || request.status >= 300) {
          let uploadError = `Could not upload ${file.name}.`;
          try {
            const body = JSON.parse(request.responseText) as { message?: string; error?: { message?: string } };
            uploadError = body.message ?? body.error?.message ?? uploadError;
          } catch { /* Use the safe generic upload error. */ }
          setError(uploadError);
          setFailedUploads((current) => [...current, file]);
          resolve();
          return;
        }
        setMessage(`${file.name} uploaded.`);
        void refresh().finally(resolve);
      };
      request.send(file);
    });
  }

  async function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    for (const file of files) await upload(file);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event.dataTransfer?.types)) return;
    // Preventing the default is what makes this element a valid drop target.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (leavesDropZone(event.currentTarget.contains(event.relatedTarget as Node | null))) {
      setDragging(false);
    }
  }

  async function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event.dataTransfer?.types)) return;
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    for (const file of files) await upload(file);
  }

  async function selectCamera(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setError("Choose a JPEG or PNG photo from your camera.");
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      setError("");
      setCaptureReview({ file, bitmap, rotation: 0 });
    } catch {
      setError("Choose a valid JPEG or PNG photo from your camera.");
    }
  }

  function closeCaptureReview() {
    setCaptureReview(null);
  }

  async function mutate(document: ItemDocument, action: "delete" | "restore") {
    const endpoint = action === "delete"
      ? `/api/documents/${encodeURIComponent(document.id)}`
      : `/api/documents/${encodeURIComponent(document.id)}/restore`;
    setBusyDocumentId(document.id);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: action === "delete" ? "DELETE" : "POST",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": csrfToken },
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setMessage(action === "delete" ? `${document.displayName} is scheduled for deletion.` : `${document.displayName} restored.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The document action could not be completed.");
    } finally {
      setBusyDocumentId(null);
    }
  }

  async function createDraft(document: ItemDocument) {
    setBusyDocumentId(document.id); setError("");
    try {
      const response = await fetch(`/api/documents/${document.id}/draft`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken } });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = await response.json() as { draft: NonNullable<typeof draft> };
      setDraft(payload.draft);
      setDraftReview({
        title: payload.draft.proposal.title,
        provider: payload.draft.proposal.provider ?? "",
        reference: payload.draft.proposal.reference ?? "",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Orbit could not prepare a draft.");
    } finally {
      setBusyDocumentId(null);
    }
  }
  async function approveDraft(mode: "create" | "merge" | "attach", targetItemId?: string) {
    if (!draft || draftApprovalBusy) return;
    const title = draftReview.title.trim();
    if (!title) {
      setError("Review and enter an item title.");
      return;
    }
    setDraftApprovalBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/document-drafts/${draft.id}/approve`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({
          sectionId,
          title,
          provider: draftReview.provider.trim() || null,
          reference: draftReview.reference.trim() || null,
          mode,
          targetItemId,
        }),
      });
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      setMessage(mode === "create" ? "Draft approved and item created." : "Document attached to the selected item.");
      setDraft(null);
    } catch {
      setError("The reviewed draft could not be approved. Try again.");
    } finally {
      setDraftApprovalBusy(false);
    }
  }
  function updateDraftReview(field: keyof DraftReview, value: string) {
    setDraftReview((current) => ({ ...current, [field]: value }));
  }

  return (
    <section className="detail-section documents-section" aria-labelledby="documents-heading">
      <div className="detail-section-title"><span>{sectionNumber}</span><h3 id="documents-heading">Files</h3></div>
      <p className="documents-intro">Keep policies, receipts and photos with this item. Files upload directly and are not saved for offline sync.</p>
      <div
        className={dragging ? "document-dropzone dragging" : "document-dropzone"}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(event) => void onDrop(event)}
        data-testid="document-dropzone"
      >
        <p className="document-dropzone-hint">
          {dragging ? "Release to upload" : "Drag files here, or choose them below."}
        </p>
        <div className="document-actions">
          <label className="document-upload" htmlFor={inputId}>Add files</label>
          <input id={inputId} className="visually-hidden" type="file" accept="application/pdf,image/jpeg,image/png" multiple onChange={selectFiles} />
          <label className="document-upload document-camera" htmlFor={cameraInputId}>Take photo</label>
          <input id={cameraInputId} className="visually-hidden" type="file" accept="image/jpeg,image/png" capture="environment" onChange={(event) => void selectCamera(event)} />
        </div>
      </div>
      <p className="document-live" aria-live="polite">{message}</p>
      {error && <p className="document-error" role="alert">{error}</p>}
      {failedUploads.length > 0 && <ul className="document-list" aria-label="Uploads ready to retry">{failedUploads.map((file, index) => <li className="document-row" key={`${file.name}-${file.lastModified}-${index}`}><div><strong>{file.name}</strong><span>Upload did not finish</span></div><button type="button" onClick={() => { setFailedUploads((current) => current.filter((_, itemIndex) => itemIndex !== index)); void upload(file); }}>Retry</button></li>)}</ul>}

      {uploading.length > 0 && <ul className="document-list" aria-label="Uploading documents">
        {uploading.map((entry) => <li key={entry.id} className="document-row uploading">
          <div><strong>{entry.name}</strong><span>Uploading {entry.progress}%</span></div>
          <progress value={entry.progress} max="100">{entry.progress}%</progress>
        </li>)}
      </ul>}

      {loading ? <p className="document-empty">Loading documents…</p> : documents.length === 0 ? <p className="document-empty">No documents attached yet.</p> : (
        <ul className="document-list" aria-label="Attached documents">
          {documents.map((document) => {
            const progress = progressDescription(document);
            const ready = isReady(document);
            const rejected = document.lifecycle === "rejected";
            return (
              <li key={document.id} className={progress ? "document-row not-ready" : "document-row"}>
                <div className="document-summary">
                  <strong>{document.displayName}</strong>
                  <span>{formatBytes(document.sizeBytes)} · {document.mediaType}</span>
                  {document.scanStatus === "skipped" && <small className="document-warning">Virus scan was skipped for this file.</small>}
                  {document.lifecycle === "pending_deletion" && <small className="document-pending">Scheduled for deletion{document.deleteAfter ? ` on ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(document.deleteAfter))}` : ""}.</small>}
                  {progress && <small className={rejected ? "document-warning" : "document-pending"} role="status">{progress}</small>}
                </div>
                <div className="document-controls">
                  {/* Actions are offered only where they can succeed. A document
                      still processing has nothing to download, and a rejected one
                      never will. */}
                  {ready && document.lifecycle === "available" && <a href={`/api/documents/${encodeURIComponent(document.id)}/download`}>Download</a>}
                  {ready && document.lifecycle === "available" && <button type="button" disabled={busyDocumentId === document.id} onClick={() => void createDraft(document)}>Review as draft</button>}
                  {ready && (
                    <button type="button" disabled={busyDocumentId === document.id} onClick={() => void mutate(document, document.lifecycle === "available" ? "delete" : "restore")}>
                      {busyDocumentId === document.id ? "Working…" : document.lifecycle === "available" ? "Delete" : "Restore"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {draft && <section className="detail-action-panel" aria-labelledby="document-draft-heading">
        <h3 id="document-draft-heading">Review extracted draft</h3>
        <p>Suggestions are untrusted document text. Check, edit or clear every field before approval.</p>
        <label className="field field-wide"><span>Item title</span><input value={draftReview.title} maxLength={100} required onChange={(event) => updateDraftReview("title", event.currentTarget.value)} /></label>
        <div className="field-grid">
          <label className="field"><span>Provider</span><input value={draftReview.provider} maxLength={100} onChange={(event) => updateDraftReview("provider", event.currentTarget.value)} /></label>
          <label className="field"><span>Reference</span><input value={draftReview.reference} maxLength={80} onChange={(event) => updateDraftReview("reference", event.currentTarget.value)} /></label>
        </div>
        {draft.evidence.excerpt && <p>Extracted evidence: {draft.evidence.excerpt.slice(0, 500)}</p>}
        {draft.duplicates?.map((candidate) => <p key={candidate.itemId}>Possible match: <strong>{candidate.title}</strong> ({candidate.reason}) <button type="button" disabled={draftApprovalBusy} onClick={() => void approveDraft("merge", candidate.itemId)}>Merge reviewed fields</button><button type="button" disabled={draftApprovalBusy} onClick={() => void approveDraft("attach", candidate.itemId)}>Attach only</button></p>)}
        <footer><button type="button" disabled={draftApprovalBusy} onClick={() => setDraft(null)}>Discard</button><button type="button" disabled={draftApprovalBusy} onClick={() => void approveDraft("create")}>{draftApprovalBusy ? "Approving…" : "Create separate item"}</button></footer>
      </section>}
      {captureReview && <><button type="button" className="capture-review-scrim" aria-label="Close captured photo review" onClick={closeCaptureReview} /><FocusDialog className="capture-review" aria-label="Review captured photo" onDismiss={closeCaptureReview}><CapturedPhotoPreview bitmap={captureReview.bitmap} rotation={captureReview.rotation} /><p>Check the photo before uploading. Rotation only changes this preview; Orbit retains the original photo.</p><div><button type="button" data-dialog-initial-focus onClick={() => setCaptureReview((current) => current && { ...current, rotation: (current.rotation + 90) % 360 })}>Rotate</button><button type="button" onClick={closeCaptureReview}>Discard</button><button type="button" onClick={() => { const file = captureReview.file; closeCaptureReview(); void upload(file); }}>Upload photo</button></div></FocusDialog></>}
    </section>
  );
}
