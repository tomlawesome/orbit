"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { FocusDialog } from "@/components/focus-dialog";
import { Icon } from "@/components/icons";
import type { HomeItem, HouseholdSection, ScheduleKind } from "@/lib/domain";
import { initialScheduleKind, workspaceItemSchema } from "@/lib/workspace";

type ItemFieldErrors = Partial<Record<"title" | "sectionId" | "dueDate" | "costMinor", string>>;

interface ItemEditorProps {
  item?: HomeItem;
  sections: HouseholdSection[];
  currency: string;
  householdId: string;
  csrfToken: string;
  onClose(): void;
  onSave(item: HomeItem, document?: File): Promise<void> | void;
  onArchive?(item: HomeItem): void;
}

function optionalValue(value: FormDataEntryValue | null): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

type InspectionReason = "supported_structure" | "unsupported_structure" | "prohibited_content";

function getRejectionMessage(reason: InspectionReason | undefined): string {
  switch (reason) {
    case "prohibited_content":
      return "Orbit rejected this document because it contains prohibited active or embedded content. Choose another document.";
    case "unsupported_structure":
      return "Orbit could not safely inspect this document structure. Choose another PDF, JPEG, or PNG before adding the item.";
    default:
      return "Orbit could not confirm that this document can be attached. Choose another document.";
  }
}

type InspectionPayload = {
  suggestions?: Array<{ field: string; value: string; source: "filename" | "document_text"; confidence: "high" | "medium" | "low" }>;
  message?: string;
  error?: { message?: string };
  attachmentDisposition?: "attachable" | "rejected";
  reason?: InspectionReason;
};

export function ItemEditor({ item, sections, currency, householdId, csrfToken, onClose, onSave, onArchive }: ItemEditorProps) {
  const newItemIdRef = useRef(item?.id ?? crypto.randomUUID());
  const inspectionSequenceRef = useRef(0);
  const inspectionAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind | "none">(initialScheduleKind(item));
  const [errors, setErrors] = useState<ItemFieldErrors>({});
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [document, setDocument] = useState<File>();
  const [inspectionMessage, setInspectionMessage] = useState("");
  const [inspectionPending, setInspectionPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const visibleSections = sections.filter((section) => section.visible);
  const availableSections = visibleSections.length
    ? sections.filter((section) => section.visible || section.id === item?.sectionId)
    : sections;

  useEffect(() => () => {
    inspectionSequenceRef.current += 1;
    inspectionAbortRef.current?.abort();
  }, []);

  function closeEditor() {
    inspectionSequenceRef.current += 1;
    inspectionAbortRef.current?.abort();
    inspectionAbortRef.current = null;
    onClose();
  }

  function clearDocument(message = "") {
    inspectionSequenceRef.current += 1;
    inspectionAbortRef.current?.abort();
    inspectionAbortRef.current = null;
    setInspectionPending(false);
    setDocument(undefined);
    setInspectionMessage(message);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function inspectDocument(file: File) {
    inspectionAbortRef.current?.abort();
    const sequence = ++inspectionSequenceRef.current;
    const controller = new AbortController();
    inspectionAbortRef.current = controller;
    setDocument(file);
    setInspectionPending(true);
    setInspectionMessage("Inspecting document securely…");
    try {
      const response = await fetch(`/api/households/${householdId}/item-document-inspection`, {
        method: "POST", credentials: "same-origin",
        headers: { "X-CSRF-Token": csrfToken, "X-Orbit-Filename": encodeURIComponent(file.name), "X-Orbit-Declared-Bytes": String(file.size) },
        body: file,
        signal: controller.signal,
      });
      const payload = await response.json() as InspectionPayload;
      if (!response.ok) throw new Error(payload.error?.message ?? "Orbit could not inspect that document");
      if (sequence !== inspectionSequenceRef.current) return;

      if (payload.attachmentDisposition !== "attachable" || payload.reason !== "supported_structure") {
        clearDocument(getRejectionMessage(payload.reason));
        return;
      }

      const form = formRef.current;
      for (const suggestion of payload.suggestions ?? []) {
        const control = form?.elements.namedItem(suggestion.field) as HTMLInputElement | HTMLSelectElement | null;
        if (control && !control.value && suggestion.value) control.value = suggestion.value;
      }
      setInspectionPending(false);
      setInspectionMessage(payload.message ?? "Document inspected. Review or change the suggested fields, then add the item.");
    } catch (error) {
      if (sequence !== inspectionSequenceRef.current || (error instanceof DOMException && error.name === "AbortError")) return;
      clearDocument(error instanceof Error ? error.message : "Orbit could not inspect that document");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const rawCost = optionalValue(formData.get("cost"));
    const rawRecurrence = optionalValue(formData.get("recurrenceMonths"));
    const candidate: HomeItem = {
      id: item?.id ?? newItemIdRef.current,
      sectionId: String(formData.get("sectionId") ?? ""),
      title: String(formData.get("title") ?? "").trim(),
      subtype: optionalValue(formData.get("subtype")),
      provider: optionalValue(formData.get("provider")),
      reference: optionalValue(formData.get("reference")),
      costMinor: rawCost ? Math.round(Number(rawCost) * 100) : undefined,
      currency,
      dueDate: scheduleKind === "none" ? undefined : optionalValue(formData.get("dueDate")),
      scheduleKind: scheduleKind === "none" ? undefined : scheduleKind,
      recurrenceMonths: scheduleKind === "none" || !rawRecurrence ? undefined : Number(rawRecurrence),
      reminderDays: scheduleKind === "none"
        ? undefined
        : formData.getAll("reminderDays").map(Number).sort((left, right) => right - left),
      snoozedUntil: item?.snoozedUntil,
      notes: optionalValue(formData.get("notes")),
      status: item?.status ?? "active",
      version: (item?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    const parsed = workspaceItemSchema.safeParse(candidate);
    if (!parsed.success || (rawCost && !Number.isFinite(Number(rawCost)))) {
      const fieldErrors = parsed.success ? {} : parsed.error.flatten().fieldErrors;
      setErrors({
        title: fieldErrors.title?.[0],
        sectionId: fieldErrors.sectionId?.[0],
        dueDate: fieldErrors.dueDate?.[0],
        costMinor: rawCost && !Number.isFinite(Number(rawCost)) ? "Enter a valid cost" : fieldErrors.costMinor?.[0],
      });
      return;
    }
    if (inspectionPending) return;
    setSubmitting(true);
    try { await onSave(parsed.data, document); } catch (error) { setInspectionMessage(error instanceof Error ? error.message : "Orbit could not add this item"); } finally { setSubmitting(false); }
  }

  return (
    <>
      <button className="editor-scrim" type="button" aria-label="Close item editor" onClick={closeEditor} />
      <FocusDialog className="item-editor" aria-labelledby="item-editor-title" onDismiss={closeEditor}>
        <header className="editor-header">
          <div>
            <p>{item ? "Update your records" : "Add to your home"}</p>
            <h2 id="item-editor-title">{item ? "Edit item" : "Add an item"}</h2>
          </div>
          <button type="button" aria-label="Close item editor" onClick={closeEditor}>×</button>
        </header>

        <form ref={formRef} onSubmit={handleSubmit} noValidate>
          <div className="editor-body">
            <section className="form-section form-section-lead">
              <label className="field field-wide">
                <span>What do you want to keep track of?</span>
                <input name="title" defaultValue={item?.title} maxLength={100} data-dialog-initial-focus placeholder="e.g. Buildings insurance" aria-invalid={Boolean(errors.title)} />
                {errors.title && <small className="field-error">{errors.title}</small>}
              </label>
              <div className="field field-wide">
                <span>Section</span>
                <div className="section-choice">
                  {availableSections.map((section, index) => (
                    <label key={section.id}>
                      <input type="radio" name="sectionId" value={section.id} defaultChecked={section.id === item?.sectionId || (!item?.sectionId && index === 0)} />
                      <span className={`accent-${section.accent}`}><Icon name={section.icon} /></span>
                      <b>{section.name}</b>
                    </label>
                  ))}
                </div>
                {errors.sectionId && <small className="field-error">{errors.sectionId}</small>}
              </div>
            </section>

            {!item && <section className="form-section">
              <div className="form-section-heading"><span>01</span><div><h3>Optional document</h3><p>Upload a document to inspect it and suggest editable fields. It is only stored with the item after you submit.</p></div></div>
              <label className="field field-wide">
                <span>Document</span>
                <input ref={fileInputRef} type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void inspectDocument(file); }} />
                {document && <small>{document.name} selected for attachment after you submit.</small>}
                {document && !inspectionPending && <button type="button" onClick={() => clearDocument("Document selection cleared.")}>Remove document</button>}
                {inspectionMessage && <small role="status">{inspectionMessage}</small>}
              </label>
            </section>}

            <section className="form-section">
              <div className="form-section-heading">
                <span>02</span>
                <div><h3>The essentials</h3><p>Useful details for finding and identifying this record.</p></div>
              </div>
              <div className="field-grid">
                <label className="field">
                  <span>Type</span>
                  <input name="subtype" defaultValue={item?.subtype} maxLength={80} placeholder="Insurance, warranty…" />
                </label>
                <label className="field">
                  <span>Provider</span>
                  <input name="provider" defaultValue={item?.provider} maxLength={100} placeholder="Company or contractor" />
                </label>
                <label className="field">
                  <span>Reference</span>
                  <input name="reference" defaultValue={item?.reference} maxLength={80} placeholder="Policy or account number" />
                </label>
                <label className="field">
                  <span>Cost ({currency})</span>
                  <input name="cost" type="number" min="0" max="1000000" step="0.01" defaultValue={item?.costMinor == null ? "" : (item.costMinor / 100).toFixed(2)} placeholder="0.00" aria-invalid={Boolean(errors.costMinor)} />
                  {errors.costMinor && <small className="field-error">{errors.costMinor}</small>}
                </label>
              </div>
            </section>

            <section className="form-section">
              <div className="form-section-heading">
                <span>03</span>
                <div><h3>What happens next?</h3><p>Schedule a renewal or service and choose when Orbit should remind you.</p></div>
              </div>
              <div className="schedule-picker">
                {(["renewal", "service", "none"] as const).map((kind) => (
                  <button type="button" key={kind} className={scheduleKind === kind ? "active" : ""} onClick={() => setScheduleKind(kind)}>
                    {kind === "renewal" ? "Renews" : kind === "service" ? "Needs service" : "No schedule"}
                  </button>
                ))}
              </div>
              {scheduleKind !== "none" && (
                <>
                  <div className="field-grid schedule-fields">
                    <label className="field">
                      <span>{scheduleKind === "renewal" ? "Renewal date" : "Service date"}</span>
                      <input name="dueDate" type="date" defaultValue={item?.dueDate} aria-invalid={Boolean(errors.dueDate)} />
                      {errors.dueDate && <small className="field-error">{errors.dueDate}</small>}
                    </label>
                    <label className="field">
                      <span>Repeats</span>
                      <select name="recurrenceMonths" defaultValue={item?.recurrenceMonths ?? ""}>
                        <option value="">Does not repeat</option>
                        <option value="1">Every month</option>
                        <option value="3">Every 3 months</option>
                        <option value="6">Every 6 months</option>
                        <option value="12">Every year</option>
                        <option value="18">Every 18 months</option>
                        <option value="24">Every 2 years</option>
                      </select>
                    </label>
                  </div>
                  <fieldset className="reminder-picker">
                    <legend>Remind me beforehand</legend>
                    {[30, 14, 7, 3, 1].map((days) => (
                      <label key={days}>
                        <input type="checkbox" name="reminderDays" value={days} defaultChecked={item?.reminderDays?.includes(days) ?? [30, 7].includes(days)} />
                        <span>{days === 1 ? "1 day" : `${days} days`}</span>
                      </label>
                    ))}
                  </fieldset>
                </>
              )}
            </section>

            <section className="form-section">
              <div className="form-section-heading">
                <span>04</span>
                <div><h3>Notes</h3><p>Add the details you will want when the date comes around.</p></div>
              </div>
              <label className="field field-wide">
                <textarea name="notes" defaultValue={item?.notes} maxLength={2000} rows={4} placeholder="Contact details, coverage notes, what to ask…" />
              </label>
            </section>

            {item && onArchive && (
              <section className="archive-zone">
                {!confirmArchive ? (
                  <button type="button" onClick={() => setConfirmArchive(true)}>Archive this item</button>
                ) : (
                  <div role="alert">
                    <span><strong>Archive {item.title}?</strong><small>You can undo this immediately after closing.</small></span>
                    <button type="button" onClick={() => setConfirmArchive(false)}>Cancel</button>
                    <button type="button" onClick={() => onArchive(item)}>Archive</button>
                  </div>
                )}
              </section>
            )}
          </div>

          <footer className="editor-footer">
            <span>{item ? "Changes are saved automatically." : "You can add more details later."}</span>
            <div>
              <button type="button" onClick={closeEditor}>Cancel</button>
              <button type="submit" disabled={submitting || inspectionPending}>{inspectionPending ? "Inspecting document…" : submitting ? "Adding item…" : item ? "Save changes" : "Add item"}</button>
            </div>
          </footer>
        </form>
      </FocusDialog>
    </>
  );
}
