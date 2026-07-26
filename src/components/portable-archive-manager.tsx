"use client";

import { FormEvent, useState } from "react";

export function PortableArchiveManager({ householdId, csrfToken }: { householdId: string; csrfToken: string }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [includeDocuments, setIncludeDocuments] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  </section>;
}
