"use client";

import { useState } from "react";

export interface RecoverableHousehold { id: string; name: string; deleteAfter: string }

export function HouseholdRecovery({ households, csrfToken }: { households: RecoverableHousehold[]; csrfToken: string }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  async function restore(household: RecoverableHousehold) {
    setBusyId(household.id); setMessage("");
    try {
      const response = await fetch(`/api/households/${encodeURIComponent(household.id)}/lifecycle`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ action: "restore" }),
      });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Orbit could not restore this household");
      window.location.reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Orbit could not restore this household"); }
    finally { setBusyId(null); }
  }
  return <div className="settings-content"><section><div className="setting-heading"><h3>Removed households</h3><p>These households are hidden from all members. Restore one before its deletion date to make it available again.</p></div>{households.length ? <div className="member-list">{households.map((household) => <article key={household.id}><div><strong>{household.name}</strong><small>Permanent deletion: {new Intl.DateTimeFormat("en-GB", { dateStyle: "long" }).format(new Date(household.deleteAfter))}</small></div><button type="button" onClick={() => void restore(household)} disabled={busyId === household.id}>{busyId === household.id ? "Restoring…" : "Restore household"}</button></article>)}</div> : <p className="member-message">You have no removed households to restore.</p>}{message && <p className="member-message" role="alert">{message}</p>}</section></div>;
}

export function HouseholdRecoveryPrompt({ households, csrfToken, onCreate, isInstanceAdmin }: { households: RecoverableHousehold[]; csrfToken: string; onCreate(): void; isInstanceAdmin: boolean }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  async function restore(household: RecoverableHousehold) {
    setBusyId(household.id); setMessage("");
    try {
      const response = await fetch(`/api/households/${encodeURIComponent(household.id)}/lifecycle`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ action: "restore" }) });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Orbit could not restore this household");
      window.location.reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Orbit could not restore this household"); }
    finally { setBusyId(null); }
  }
  async function hardDelete(household: RecoverableHousehold) { const confirmation = window.prompt(`Type ${household.name} to permanently delete it.`); if (confirmation === null) return; setBusyId(household.id); try { const response = await fetch(`/api/households/${encodeURIComponent(household.id)}/lifecycle`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ action: "hard_delete", confirmation }) }); const payload = await response.json() as { error?: { message?: string } }; if (!response.ok) throw new Error(payload.error?.message ?? "Orbit could not permanently delete this household"); window.location.reload(); } catch (error) { setMessage(error instanceof Error ? error.message : "Orbit could not permanently delete this household"); } finally { setBusyId(null); } }
  return <><button className="editor-scrim" type="button" tabIndex={-1} aria-hidden="true" /><section className="household-onboarding household-recovery-prompt" role="dialog" aria-modal="true" aria-labelledby="recovery-title"><div className="onboarding-art" aria-hidden="true"><span>Your households</span><p>Start fresh,<br />or bring one back.</p></div><div className="onboarding-form"><header><div><p>No active households</p><h2 id="recovery-title">Where would you like to begin?</h2></div></header><p className="onboarding-intro">Create a new household, or restore one you previously removed. A removed name is reserved until it is restored or permanently deleted by an instance administrator.</p><button className="wizard-primary" type="button" onClick={onCreate}>Create household</button>{households.length > 0 && <div className="recovery-options"><strong>Restore a removed household</strong>{households.map((household) => <article key={household.id}><div><b>{household.name}</b><small>Available until {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(household.deleteAfter))}</small></div><span><button type="button" onClick={() => void restore(household)} disabled={busyId === household.id}>{busyId === household.id ? "Restoring…" : "Restore"}</button>{isInstanceAdmin && <button type="button" onClick={() => void hardDelete(household)} disabled={busyId === household.id}>Permanently delete</button>}</span></article>)}</div>}{message && <p className="member-message" role="alert">{message}</p>}</div></section></>;
}
