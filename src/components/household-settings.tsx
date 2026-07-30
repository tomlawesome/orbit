"use client";

import { useState, type FormEvent } from "react";
import type { HouseholdWorkspace } from "@/lib/workspace";

export interface HouseholdSettingsInput {
  name: string;
  timezone: string;
  currency: string;
}

interface HouseholdSettingsProps {
  household: HouseholdWorkspace;
  onSave(input: HouseholdSettingsInput): Promise<void>;
  csrfToken: string;
}

const timezones = [
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Australia/Sydney",
  "UTC",
];

export function HouseholdSettings({ household, onSave, csrfToken }: HouseholdSettingsProps) {
  const [message, setMessage] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [lifecycleBusy, setLifecycleBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSaveBusy(true);
    setMessage("Household settings are being saved.");
    try {
      await onSave({
        name: String(data.get("name") ?? "").trim(),
        timezone: String(data.get("timezone") ?? household.timezone),
        currency: String(data.get("currency") ?? household.currency),
      });
      setMessage("Household settings were saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Orbit could not save this change");
    } finally {
      setSaveBusy(false);
    }
  }

  async function changeLifecycle(action: "delete" | "restore") {
    setLifecycleBusy(true);
    try {
      const response = await fetch(`/api/households/${household.id}/lifecycle`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(action === "delete" ? { action, confirmation: deletionConfirmation } : { action }),
      });
      const payload = await response.json() as { deleteAfter?: string; error?: { message: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Orbit could not update this household");
      setMessage(action === "delete" ? `Deletion is scheduled for ${new Date(payload.deleteAfter!).toLocaleDateString()}.` : "Household deletion was cancelled.");
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Orbit could not update this household");
    } finally { setLifecycleBusy(false); }
  }

  return (
    <div className="settings-content">
      <section>
        <div className="setting-heading">
          <h3>Household details</h3>
          <p>These settings control household dates, reminder times and costs.</p>
        </div>
        <form className="member-form" onSubmit={submit}>
          <label className="field">
            <span>Household name</span>
            <input name="name" defaultValue={household.name} maxLength={60} required />
          </label>
          <label className="field">
            <span>Timezone</span>
            <select name="timezone" defaultValue={household.timezone}>
              {timezones.map((timezone) => <option key={timezone} value={timezone}>{timezone.replaceAll("_", " ")}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Currency</span>
            <select name="currency" defaultValue={household.currency}>
              {["GBP", "EUR", "USD", "CAD", "AUD", "NZD"].map((currency) => <option key={currency}>{currency}</option>)}
            </select>
          </label>
          <button type="submit" disabled={saveBusy}>{saveBusy ? "Saving…" : "Save household"}</button>
        </form>
        {message && <p className="member-message" role="status">{message}</p>}
      </section>
      <section>
        <div className="setting-heading">
          <h3>Household lifecycle</h3>
          {household.deleteAfter
            ? <p>This household is scheduled for deletion on {new Intl.DateTimeFormat("en-GB", { dateStyle: "long" }).format(new Date(household.deleteAfter))}. Restore it before then to keep its records.</p>
            : <p>Removing a household hides it from every member immediately. An owner or instance administrator can restore it for 30 days; records are permanently purged afterwards.</p>}
        </div>
        {household.deleteAfter ? <button type="button" onClick={() => void changeLifecycle("restore")} disabled={lifecycleBusy}>{lifecycleBusy ? "Restoring…" : "Restore household"}</button> : <div className="member-form">
          <label className="field"><span>Type “{household.name}” to remove this household</span><input value={deletionConfirmation} onChange={(event) => setDeletionConfirmation(event.target.value)} maxLength={60} /></label>
          <button type="button" onClick={() => void changeLifecycle("delete")} disabled={lifecycleBusy || deletionConfirmation !== household.name}>{lifecycleBusy ? "Removing…" : "Remove household"}</button>
        </div>}
      </section>
    </div>
  );
}
