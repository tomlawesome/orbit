"use client";

import { FormEvent, useState } from "react";

export function PortableArchiveManager({ householdId, csrfToken }: { householdId: string; csrfToken: string }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [includeDocuments, setIncludeDocuments] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [preview, setPreview] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passphrase !== confirmation) {
      setStatus("The passphrases do not match.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/households/${householdId}/portable-archives`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ passphrase, includeDocuments }),
      });
      const payload = await response.json() as { archive?: { downloadUrl: string; expiresAt: string }; error?: { message: string } };
      if (!response.ok || !payload.archive) throw new Error(payload.error?.message ?? "Orbit could not create the export");
      setPassphrase("");
      setConfirmation("");
      setStatus(`Your encrypted export is ready and expires ${new Date(payload.archive.expiresAt).toLocaleString()}. The download is starting.`);
      window.location.assign(payload.archive.downloadUrl);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Orbit could not create the export");
    } finally {
      setBusy(false);
    }
  }

  async function previewImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get("archive");
    if (!(file instanceof File) || file.size === 0) { setPreview("Choose an encrypted Orbit export first."); return; }
    setBusy(true); setPreview(null);
    try {
      const archive = JSON.parse(await file.text()) as unknown;
      const response = await fetch("/api/portable-archives/preview", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ archive, passphrase: importPassphrase }) });
      const payload = await response.json() as { preview?: { householdName: string; sections: number; items: number; documents: number }; error?: { message: string } };
      if (!response.ok || !payload.preview) throw new Error(payload.error?.message ?? "Orbit could not read that export");
      setImportPassphrase("");
      setPreview(`Ready to import: ${payload.preview.householdName} — ${payload.preview.sections} sections, ${payload.preview.items} items and ${payload.preview.documents} documents. Importing is not available until you review duplicate choices.`);
    } catch (error) { setPreview(error instanceof Error ? error.message : "Orbit could not read that export"); } finally { setBusy(false); }
  }

  return <section className="settings-section">
    <p className="eyebrow">Your data</p>
    <h3>Portable household export</h3>
    <p>Download a passphrase-encrypted archive of this household. Orbit never retains the passphrase. The encrypted file expires after 24 hours.</p>
    <form className="settings-form" onSubmit={submit}>
      <label>Export passphrase
        <input type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
      </label>
      <label>Confirm passphrase
        <input type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      </label>
      <label className="toggle-row"><input type="checkbox" checked={includeDocuments} onChange={(event) => setIncludeDocuments(event.target.checked)} /> Include original document bytes (up to 128 MiB)</label>
      <button className="wizard-primary" type="submit" disabled={busy}>{busy ? "Preparing encrypted export…" : "Create encrypted export"}</button>
      {status && <p role="status">{status}</p>}
    </form>
    <h3>Preview an import</h3>
    <p>Orbit checks the encrypted archive before making any changes. No records are imported from this screen.</p>
    <form className="settings-form" onSubmit={previewImport}>
      <label>Encrypted export file<input name="archive" type="file" accept="application/json,.json" required /></label>
      <label>Export passphrase<input type="password" autoComplete="off" minLength={12} maxLength={256} required value={importPassphrase} onChange={(event) => setImportPassphrase(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? "Checking export…" : "Preview import"}</button>
      {preview && <p role="status">{preview}</p>}
    </form>
  </section>;
}
