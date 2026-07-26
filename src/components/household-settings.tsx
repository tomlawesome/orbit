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
  onSave(input: HouseholdSettingsInput): void;
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

export function HouseholdSettings({ household, onSave }: HouseholdSettingsProps) {
  const [message, setMessage] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSave({
      name: String(data.get("name") ?? "").trim(),
      timezone: String(data.get("timezone") ?? household.timezone),
      currency: String(data.get("currency") ?? household.currency),
    });
    setMessage("Household settings are being saved.");
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
          <button type="submit">Save household</button>
        </form>
        {message && <p className="member-message" role="status">{message}</p>}
      </section>
    </div>
  );
}
