"use client";

import { useMemo, useState, type FormEvent } from "react";
import Image from "next/image";
import { Icon } from "@/components/icons";
import {
  defaultSections,
  sectionAccents,
  sectionIcons,
  type HouseholdSection,
} from "@/lib/domain";
import type { HouseholdWorkspace } from "@/lib/workspace";

export interface HouseholdSetupInput {
  name: string;
  timezone: string;
  currency: string;
  sections: HouseholdSection[];
}

interface FirstRunWizardProps {
  household: HouseholdWorkspace;
  onComplete(input: HouseholdSetupInput): void;
}

type CategoryMode = "suggested" | "custom";

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

function suggestedSections(existing: HouseholdSection[]): HouseholdSection[] {
  return defaultSections.map((section, index) => ({
    ...section,
    id: existing[index]?.id ?? crypto.randomUUID(),
  }));
}

export function FirstRunWizard({ household, onComplete }: FirstRunWizardProps) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState(household.name);
  const [timezone, setTimezone] = useState(household.timezone);
  const [currency, setCurrency] = useState(household.currency);
  const [categoryMode, setCategoryMode] = useState<CategoryMode>("suggested");
  const [customNames, setCustomNames] = useState([""]);
  const suggestions = useMemo(() => suggestedSections(household.sections), [household.sections]);

  function submitDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStep(3);
  }

  function complete() {
    const sections = categoryMode === "suggested"
      ? suggestions
      : customNames
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((sectionName, index) => ({
          id: household.sections[index]?.id ?? crypto.randomUUID(),
          name: sectionName,
          icon: sectionIcons[index % sectionIcons.length],
          accent: sectionAccents[index % sectionAccents.length],
          visible: true,
        }));
    if (!sections.length) return;
    onComplete({ name: name.trim(), timezone, currency, sections });
  }

  return (
    <div className="first-run-shell">
      <main className="first-run-card" aria-labelledby="setup-title">
        <header>
          <span className="first-run-brand"><Image src="/orbit-mark.svg" alt="" width={44} height={44} /> Orbit</span>
          <span>Step {step} of 3</span>
        </header>

        {step === 1 ? (
          <section className="first-run-intro">
            <p className="eyebrow">Welcome to your Orbit</p>
            <h1 id="setup-title">Let&apos;s bring everything into view.</h1>
            <p>We&apos;ll set up your first household and the categories you want to keep on track. Nothing is pre-filled with sample records.</p>
            <button className="wizard-primary" type="button" onClick={() => setStep(2)}>
              Start setup <Icon name="chevron" />
            </button>
          </section>
        ) : step === 2 ? (
          <form className="first-run-form" onSubmit={submitDetails}>
            <div>
              <p className="eyebrow">Your household</p>
              <h1 id="setup-title">Set the basics.</h1>
              <p>These settings control how Orbit presents dates and costs.</p>
            </div>
            <label className="field">
              <span>Household name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required />
            </label>
            <div className="field-grid">
              <label className="field">
                <span>Timezone</span>
                <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
                  {timezones.map((entry) => <option key={entry} value={entry}>{entry.replace("_", " ")}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Currency</span>
                <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                  {["GBP", "EUR", "USD", "CAD", "AUD", "NZD"].map((entry) => <option key={entry}>{entry}</option>)}
                </select>
              </label>
            </div>
            <footer>
              <button type="button" onClick={() => setStep(1)}>Back</button>
              <button className="wizard-primary" type="submit">Choose categories <Icon name="chevron" /></button>
            </footer>
          </form>
        ) : (
          <section className="first-run-categories">
            <div>
              <p className="eyebrow">Organise your orbit</p>
              <h1 id="setup-title">Choose your categories.</h1>
              <p>Start with Orbit&apos;s suggested structure or define your own.</p>
            </div>
            <div className="category-mode-picker">
              <button type="button" className={categoryMode === "suggested" ? "active" : ""} onClick={() => setCategoryMode("suggested")}>
                <strong>Use suggested</strong><small>Home, Vehicles, Devices and Services</small>
              </button>
              <button type="button" className={categoryMode === "custom" ? "active" : ""} onClick={() => setCategoryMode("custom")}>
                <strong>Create my own</strong><small>Start with a clean custom list</small>
              </button>
            </div>
            {categoryMode === "suggested" ? (
              <div className="suggested-categories">
                {suggestions.map((section) => (
                  <article className={`accent-${section.accent}`} key={section.id}>
                    <Icon name={section.icon} /><strong>{section.name}</strong>
                  </article>
                ))}
              </div>
            ) : (
              <div className="custom-categories">
                {customNames.map((entry, index) => (
                  <label className="field" key={index}>
                    <span>Category {index + 1}</span>
                    <span className="custom-category-input">
                      <input
                        value={entry}
                        onChange={(event) => setCustomNames(customNames.map((nameEntry, nameIndex) => nameIndex === index ? event.target.value : nameEntry))}
                        placeholder={index === 0 ? "e.g. Property" : "Category name"}
                        maxLength={30}
                        required
                      />
                      {customNames.length > 1 && (
                        <button type="button" aria-label={`Remove category ${index + 1}`} onClick={() => setCustomNames(customNames.filter((_, nameIndex) => nameIndex !== index))}>×</button>
                      )}
                    </span>
                  </label>
                ))}
                {customNames.length < 12 && <button className="add-category" type="button" onClick={() => setCustomNames([...customNames, ""])}><Icon name="plus" /> Add category</button>}
              </div>
            )}
            <footer>
              <button type="button" onClick={() => setStep(2)}>Back</button>
              <button className="wizard-primary" type="button" disabled={categoryMode === "custom" && !customNames.some((entry) => entry.trim())} onClick={complete}>
                Finish setup <Icon name="chevron" />
              </button>
            </footer>
          </section>
        )}
      </main>
    </div>
  );
}
