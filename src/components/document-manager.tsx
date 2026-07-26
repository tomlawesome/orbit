"use client";

import { useCallback, useEffect, useId, useState, type ChangeEvent } from "react";

export interface ItemDocument {
  id: string;
  itemId: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  lifecycle: "available" | "pending_deletion";
  scanStatus: "clean" | "skipped";
  availableAt: string;
  deleteAfter: string | null;
}

interface UploadingDocument {
  id: string;
  name: string;
  progress: number;
}

interface DocumentManagerProps {
  householdId: string;
  itemId: string;
  csrfToken: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
export function DocumentManager({ householdId, itemId, csrfToken }: DocumentManagerProps) {
  const inputId = useId();
  const cameraInputId = useId();
  const [documents, setDocuments] = useState<ItemDocument[]>([]);
  const [uploading, setUploading] = useState<UploadingDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
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

  return (
    <section className="detail-section documents-section" aria-labelledby="documents-heading">
      <div className="detail-section-title"><span>Documents</span><h3 id="documents-heading">Files</h3></div>
      <p className="documents-intro">Keep policies, receipts and photos with this item. Files upload directly and are not saved for offline sync.</p>
      <div className="document-actions">
        <label className="document-upload" htmlFor={inputId}>Add files</label>
        <input id={inputId} className="visually-hidden" type="file" accept="application/pdf,image/*" multiple onChange={selectFiles} />
        <label className="document-upload document-camera" htmlFor={cameraInputId}>Take photo</label>
        <input id={cameraInputId} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={selectFiles} />
      </div>
      <p className="document-live" aria-live="polite">{message}</p>
      {error && <p className="document-error" role="alert">{error}</p>}

      {uploading.length > 0 && <ul className="document-list" aria-label="Uploading documents">
        {uploading.map((entry) => <li key={entry.id} className="document-row uploading">
          <div><strong>{entry.name}</strong><span>Uploading {entry.progress}%</span></div>
          <progress value={entry.progress} max="100">{entry.progress}%</progress>
        </li>)}
      </ul>}

      {loading ? <p className="document-empty">Loading documents…</p> : documents.length === 0 ? <p className="document-empty">No documents attached yet.</p> : (
        <ul className="document-list" aria-label="Attached documents">
          {documents.map((document) => <li key={document.id} className="document-row">
            <div className="document-summary">
              <strong>{document.displayName}</strong>
              <span>{formatBytes(document.sizeBytes)} · {document.mediaType}</span>
              {document.scanStatus === "skipped" && <small className="document-warning">Virus scan was skipped for this file.</small>}
              {document.lifecycle === "pending_deletion" && <small className="document-pending">Scheduled for deletion{document.deleteAfter ? ` on ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(document.deleteAfter))}` : ""}.</small>}
            </div>
            <div className="document-controls">
              {document.lifecycle === "available" && <a href={`/api/documents/${encodeURIComponent(document.id)}/download`}>Download</a>}
              <button type="button" disabled={busyDocumentId === document.id} onClick={() => void mutate(document, document.lifecycle === "available" ? "delete" : "restore")}>
                {busyDocumentId === document.id ? "Working…" : document.lifecycle === "available" ? "Delete" : "Restore"}
              </button>
            </div>
          </li>)}
        </ul>
      )}
    </section>
  );
}
