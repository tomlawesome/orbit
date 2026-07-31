"use client";

import { useState } from "react";

export interface RecoverableHousehold { id: string; name: string; deleteAfter: string }

interface RecoveryProps {
  households: RecoverableHousehold[];
  csrfToken: string;
  isInstanceAdmin: boolean;
}

function deletionDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long" }).format(new Date(value));
}

function RecoveryActions({ households, csrfToken, isInstanceAdmin, compact = false }: RecoveryProps & { compact?: boolean }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState<RecoverableHousehold | null>(null);
  const [confirmation, setConfirmation] = useState("");

  async function lifecycle(household: RecoverableHousehold, action: "restore" | "hard_delete") {
    setBusyId(household.id);
    setMessage("");
    try {
      const response = await fetch(`/api/households/${encodeURIComponent(household.id)}/lifecycle`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(action === "restore" ? { action } : { action, confirmation }),
      });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Orbit could not update this household");
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Orbit could not update this household");
    } finally {
      setBusyId(null);
    }
  }

  if (!households.length) return compact ? null : <p className="member-message">You have no removed households to restore.</p>;

  return <>
    <div className={compact ? "recovery-options" : "member-list"}>
      {compact && <strong>Households available to restore</strong>}
      {households.map((household) => <article key={household.id}>
        <div><b>{household.name}</b><small>Available until {deletionDate(household.deleteAfter)}</small></div>
        <span className="recovery-actions">
          <button type="button" onClick={() => void lifecycle(household, "restore")} disabled={busyId === household.id}>{busyId === household.id ? "Restoring…" : "Restore"}</button>
          {isInstanceAdmin && <button type="button" className="danger" onClick={() => { setConfirming(household); setConfirmation(""); }} disabled={busyId === household.id}>Permanently delete</button>}
        </span>
      </article>)}
    </div>
    {message && <p className="member-message" role="alert">{message}</p>}
    {confirming && <section className="recovery-confirmation" role="dialog" aria-modal="true" aria-labelledby="permanent-delete-title">
      <div>
        <p>Permanent deletion</p>
        <h3 id="permanent-delete-title">Delete {confirming.name} forever?</h3>
        <span>This immediately removes the household and its data. This cannot be undone. Type the household name to confirm.</span>
        <label className="field"><span>Household name</span><input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <footer><button type="button" onClick={() => setConfirming(null)}>Cancel</button><button type="button" className="danger" disabled={confirmation !== confirming.name || busyId === confirming.id} onClick={() => void lifecycle(confirming, "hard_delete")}>Permanently delete</button></footer>
      </div>
    </section>}
  </>;
}

export function HouseholdRecovery({ households, csrfToken, isInstanceAdmin }: RecoveryProps) {
  return <div className="settings-content"><section><div className="setting-heading"><h3>Removed households</h3><p>Removed households are hidden from all members. Restore one before its deletion date to make it available again.</p></div><RecoveryActions households={households} csrfToken={csrfToken} isInstanceAdmin={isInstanceAdmin} /></section></div>;
}

export function HouseholdRecoveryPrompt({ households, csrfToken, onCreate, isInstanceAdmin }: RecoveryProps & { onCreate(): void }) {
  return <><button className="editor-scrim" type="button" tabIndex={-1} aria-hidden="true" /><section className="household-onboarding household-recovery-prompt" role="dialog" aria-modal="true" aria-labelledby="recovery-title"><div className="onboarding-art" aria-hidden="true"><span>Your households</span><p>Choose a space,<br />or make a new one.</p></div><div className="onboarding-form"><header><div><p>No active households</p><h2 id="recovery-title">Where would you like to begin?</h2></div></header><p className="onboarding-intro">You can create a new household below. If you removed one previously, restore it here instead. Its name stays reserved until it is restored or permanently deleted by an instance administrator.</p><button className="wizard-primary" type="button" onClick={onCreate}>Create a new household</button><RecoveryActions households={households} csrfToken={csrfToken} isInstanceAdmin={isInstanceAdmin} compact /></div></section></>;
}
