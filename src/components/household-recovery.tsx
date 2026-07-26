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
