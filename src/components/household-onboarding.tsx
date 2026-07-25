"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";

export interface HouseholdInput {
  name: string;
  timezone: string;
  currency: string;
}

interface HouseholdOnboardingProps {
  onClose(): void;
  onCreate(input: HouseholdInput): void;
}

export function HouseholdOnboarding({ onClose, onCreate }: HouseholdOnboardingProps) {
  const [nameError, setNameError] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") ?? "").trim();
    if (!name || name.length > 60) {
      setNameError(name ? "Use 60 characters or fewer" : "Give this household a name");
      return;
    }
    onCreate({
      name,
      timezone: String(formData.get("timezone") ?? "Europe/London"),
      currency: String(formData.get("currency") ?? "GBP"),
    });
  }

  return (
    <>
      <button className="editor-scrim" type="button" aria-label="Close household setup" onClick={onClose} />
      <section className="household-onboarding" role="dialog" aria-modal="true" aria-labelledby="household-title">
        <div className="onboarding-art" aria-hidden="true">
          <span>01</span>
          <Image className="onboarding-mark" src="/orbit-mark.svg" alt="" width={320} height={320} />
          <p>A fresh space<br />for every place.</p>
        </div>
        <div className="onboarding-form">
          <header>
            <div><p>New household</p><h2 id="household-title">Set up your space</h2></div>
            <button type="button" aria-label="Close household setup" onClick={onClose}>×</button>
          </header>
          <p className="onboarding-intro">Orbit will start you with Home, Vehicles, Devices, and Services. You can reshape those sections whenever you like.</p>
          <form onSubmit={handleSubmit} noValidate>
            <label className="field field-wide">
              <span>Household name</span>
              <input name="name" maxLength={60} autoFocus placeholder="e.g. The cottage" aria-invalid={Boolean(nameError)} />
              {nameError && <small className="field-error">{nameError}</small>}
            </label>
            <div className="field-grid">
              <label className="field">
                <span>Timezone</span>
                <select name="timezone" defaultValue="Europe/London">
                  <option value="Europe/London">London</option>
                  <option value="Europe/Dublin">Dublin</option>
                  <option value="Europe/Paris">Paris</option>
                  <option value="America/New_York">New York</option>
                  <option value="America/Los_Angeles">Los Angeles</option>
                  <option value="Australia/Sydney">Sydney</option>
                </select>
              </label>
              <label className="field">
                <span>Currency</span>
                <select name="currency" defaultValue="GBP">
                  <option value="GBP">GBP · £</option>
                  <option value="EUR">EUR · €</option>
                  <option value="USD">USD · $</option>
                  <option value="AUD">AUD · A$</option>
                </select>
              </label>
            </div>
            <footer>
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="submit">Create household</button>
            </footer>
          </form>
        </div>
      </section>
    </>
  );
}
