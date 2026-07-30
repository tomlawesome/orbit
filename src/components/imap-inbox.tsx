"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

type Household = { id: string; name: string; currency: string };
type InboxReceipt = {
  id: string;
  status: string;
  householdId: string | null;
  draftVersion: number;
  expiresAt: string;
  receivedAt: string;
  attachmentCount: number;
  classification: "ready" | "waiting" | "retry" | "cleanup" | "unavailable";
  canApprove: boolean;
  canDiscard: boolean;
  cleanupOnly?: boolean;
  message: string;
  proposal: Record<string, unknown>;
  fieldEvidence: Record<string, { source: string; confidence: string }>;
};
type Inbox = { receipts: InboxReceipt[]; households: Household[] };
type Review = {
  receipt: Pick<InboxReceipt, "id" | "status" | "householdId" | "draftVersion" | "expiresAt" | "receivedAt" | "classification" | "canApprove" | "canDiscard" | "message"> & { proposal: Record<string, unknown>; fieldEvidence: Record<string, { source: string; confidence: string }> };
  sections: Array<{ id: string; name: string }>;
  candidates: Array<{ itemId: string; title: string; reason: string }>;
  attachments: Array<{ id: string; ordinal: number; mediaType: string; sizeBytes: number }>;
};
type ReviewFields = {
  title: string;
  subtype: string;
  provider: string;
  reference: string;
  cost: string;
  currency: string;
  dueDate: string;
  scheduleKind: "" | "renewal" | "service";
  recurrenceMonths: string;
  reminderDays: number[];
  notes: string;
};
type FieldErrors = Partial<Record<"title" | "sectionId" | "currency" | "cost" | "dueDate", string>>;

const reminderOptions = [30, 14, 7, 3, 1];
const suggestionFields = ["title", "subtype", "provider", "reference", "costMinor", "currency", "dueDate", "scheduleKind", "recurrenceMonths"] as const;
const preClaimApprovalErrorCodes = new Set([
  "validation_failed",
  "household_not_found",
  "section_not_found",
  "item_not_found",
  "reviewed_intake_stale",
  "reviewed_intake_not_approvable",
]);

type SubmittedApprovalRequest = { operationId: string; body: Record<string, unknown> };

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function initialFields(proposal: Record<string, unknown>, currency: string): ReviewFields {
  const cost = typeof proposal.costMinor === "number" ? (proposal.costMinor / 100).toFixed(2) : "";
  return {
    title: textValue(proposal.title),
    subtype: textValue(proposal.subtype),
    provider: textValue(proposal.provider),
    reference: textValue(proposal.reference),
    cost,
    currency: textValue(proposal.currency) || currency,
    dueDate: textValue(proposal.dueDate),
    scheduleKind: proposal.scheduleKind === "renewal" || proposal.scheduleKind === "service" ? proposal.scheduleKind : "",
    recurrenceMonths: typeof proposal.recurrenceMonths === "number" ? String(proposal.recurrenceMonths) : "",
    reminderDays: [],
    notes: "",
  };
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function formItem(fields: ReviewFields, sectionId: string) {
  const rawCost = fields.cost.trim();
  const rawRecurrence = fields.recurrenceMonths.trim();
  return {
    sectionId,
    title: fields.title.trim(),
    subtype: optionalText(fields.subtype),
    provider: optionalText(fields.provider),
    reference: optionalText(fields.reference),
    costMinor: rawCost ? Math.round(Number(rawCost) * 100) : undefined,
    currency: fields.currency.trim().toUpperCase(),
    dueDate: fields.scheduleKind ? optionalText(fields.dueDate) : undefined,
    scheduleKind: fields.scheduleKind || undefined,
    recurrenceMonths: fields.scheduleKind && rawRecurrence ? Number(rawRecurrence) : undefined,
    reminderDays: fields.scheduleKind ? [...fields.reminderDays].sort((left, right) => right - left) : undefined,
    notes: optionalText(fields.notes),
    status: "active" as const,
  };
}

function ReviewForm({
  review,
  household,
  csrfToken,
  onBack,
  onChanged,
}: {
  review: Review;
  household: Household;
  csrfToken: string;
  onBack(): void;
  onChanged(): void;
}) {
  const [fields, setFields] = useState(() => initialFields(review.receipt.proposal, household.currency));
  const [sectionId, setSectionId] = useState(review.sections[0]?.id ?? "");
  const [action, setAction] = useState<"create_separate" | "attach_existing">("create_separate");
  const [targetItemId, setTargetItemId] = useState("");
  const [selectedAttachments, setSelectedAttachments] = useState<string[]>(review.attachments.map((attachment) => attachment.id));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [retryLocked, setRetryLocked] = useState(false);
  const operationIdRef = useRef<string | undefined>(undefined);
  const submittedRequestRef = useRef<SubmittedApprovalRequest | undefined>(undefined);

  function changed() {
    if (retryLocked) return;
    operationIdRef.current = undefined;
    submittedRequestRef.current = undefined;
  }

  function updateField<K extends keyof ReviewFields>(key: K, value: ReviewFields[K]) {
    changed();
    setFields((current) => ({ ...current, [key]: value }));
  }

  function validate(): boolean {
    const next: FieldErrors = {};
    if (!fields.title.trim()) next.title = "Enter a title";
    if (!sectionId) next.sectionId = "Choose a section";
    if (!/^[A-Za-z]{3}$/.test(fields.currency.trim())) next.currency = "Use a three-letter currency code";
    if (fields.cost.trim() && (!Number.isFinite(Number(fields.cost)) || Number(fields.cost) < 0)) next.cost = "Enter a valid cost";
    if (fields.scheduleKind && !fields.dueDate.trim()) next.dueDate = "Choose a date for the scheduled item";
    if (action === "attach_existing" && !targetItemId) setMessage("Choose one authorized possible match before attaching.");
    setErrors(next);
    return Object.keys(next).length === 0 && (action !== "attach_existing" || Boolean(targetItemId));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const retryRequest = retryLocked ? submittedRequestRef.current : undefined;
    if (retryLocked && !retryRequest) {
      setRetryLocked(false);
      operationIdRef.current = undefined;
      return;
    }
    if (!retryRequest && !validate()) return;
    const operationId = retryRequest?.operationId ?? operationIdRef.current ?? crypto.randomUUID();
    operationIdRef.current = operationId;
    const requestBody = retryRequest?.body ?? {
      operationId,
      source: { kind: "mailbox_draft", receiptId: review.receipt.id, draftVersion: review.receipt.draftVersion },
      householdId: household.id,
      sectionId,
      action,
      targetItemId: action === "attach_existing" ? targetItemId : undefined,
      item: formItem(fields, sectionId),
      attachmentIds: selectedAttachments,
    };
    submittedRequestRef.current = { operationId, body: requestBody };
    setSubmitting(true);
    setMessage("Submitting your reviewed values…");
    try {
      const response = await fetch("/api/reviewed-intake/approve", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json() as { error?: { code?: string; message?: string }; outcome?: "approved" | "partial_success"; itemId?: string };
      if (!response.ok) {
        const error = new Error(payload.error?.message ?? "Orbit could not approve this review") as Error & { code?: string };
        error.code = payload.error?.code;
        throw error;
      }
      if (payload.outcome !== "approved" && payload.outcome !== "partial_success") throw new Error("Orbit returned an incomplete approval result");
      if (payload.outcome === "partial_success") {
        setRetryLocked(true);
        setMessage("The item is recorded, but selected document transfer needs another try. Your reviewed values are retained.");
        return;
      }
      setMessage("Review approved. Refreshing your private inbox…");
      onChanged();
    } catch (error) {
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
      if (code && preClaimApprovalErrorCodes.has(code)) {
        operationIdRef.current = undefined;
        submittedRequestRef.current = undefined;
        setRetryLocked(false);
      } else {
        setRetryLocked(true);
      }
      setMessage(error instanceof Error ? error.message : "Orbit could not approve this review");
    } finally {
      setSubmitting(false);
    }
  }

  async function discard() {
    if (!window.confirm("Discard this private review? Its staged files will be purged.")) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/imap-inbox/${review.receipt.id}`, { method: "DELETE", credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken } });
      if (!response.ok) {
        const payload = await response.json() as { error?: { message?: string } };
        throw new Error(payload.error?.message ?? "Orbit could not discard this review");
      }
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Orbit could not discard this review");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleAttachment(event: ChangeEvent<HTMLInputElement>) {
    changed();
    setSelectedAttachments((current) => event.currentTarget.checked ? [...current, event.currentTarget.value] : current.filter((id) => id !== event.currentTarget.value));
  }

  const evidence = Object.entries(review.receipt.fieldEvidence).filter(([field]) => suggestionFields.includes(field as typeof suggestionFields[number]));
  const editable = review.receipt.canApprove;
  return <div className="imap-review" role="region" aria-labelledby="imap-review-title">
    <header className="imap-review-heading">
      <button type="button" onClick={onBack}>Back to inbox</button>
      <div><p className="eyebrow">Private review</p><h4 id="imap-review-title">Check every value before saving</h4><p>{review.receipt.message}</p></div>
    </header>
    {!editable ? <p role="status">{review.receipt.message}</p> : <form onSubmit={submit} noValidate>
      <fieldset className="imap-review-section" disabled={retryLocked}>
        <legend>Destination</legend>
        <label className="field"><span>Household</span><input value={household.name} readOnly /></label>
        <label className="field"><span>Section</span><select value={sectionId} onChange={(event) => { changed(); setSectionId(event.currentTarget.value); }} aria-invalid={Boolean(errors.sectionId)}><option value="">Choose a section…</option>{review.sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</select>{errors.sectionId && <small className="field-error">{errors.sectionId}</small>}</label>
      </fieldset>

      <fieldset className="imap-review-section" disabled={retryLocked}><legend>Suggested item values</legend><p className="imap-review-help">These are untrusted suggestions. Edit or clear anything before approval.</p>
        <label className="field"><span>Title</span><input value={fields.title} maxLength={100} onChange={(event) => updateField("title", event.currentTarget.value)} aria-invalid={Boolean(errors.title)} />{errors.title && <small className="field-error">{errors.title}</small>}</label>
        <div className="field-grid"><label className="field"><span>Type</span><input value={fields.subtype} maxLength={80} onChange={(event) => updateField("subtype", event.currentTarget.value)} /></label><label className="field"><span>Provider</span><input value={fields.provider} maxLength={100} onChange={(event) => updateField("provider", event.currentTarget.value)} /></label><label className="field"><span>Reference</span><input value={fields.reference} maxLength={80} onChange={(event) => updateField("reference", event.currentTarget.value)} /></label><label className="field"><span>Cost</span><input type="number" min="0" max="1000000" step="0.01" value={fields.cost} onChange={(event) => updateField("cost", event.currentTarget.value)} aria-invalid={Boolean(errors.cost)} />{errors.cost && <small className="field-error">{errors.cost}</small>}</label><label className="field"><span>Currency</span><input value={fields.currency} maxLength={3} onChange={(event) => updateField("currency", event.currentTarget.value)} aria-invalid={Boolean(errors.currency)} />{errors.currency && <small className="field-error">{errors.currency}</small>}</label></div>
        <div className="field-grid"><label className="field"><span>Schedule</span><select value={fields.scheduleKind} onChange={(event) => updateField("scheduleKind", event.currentTarget.value as ReviewFields["scheduleKind"])}><option value="">No schedule</option><option value="renewal">Renews</option><option value="service">Needs service</option></select></label>{fields.scheduleKind && <label className="field"><span>{fields.scheduleKind === "renewal" ? "Renewal date" : "Service date"}</span><input type="date" value={fields.dueDate} onChange={(event) => updateField("dueDate", event.currentTarget.value)} aria-invalid={Boolean(errors.dueDate)} />{errors.dueDate && <small className="field-error">{errors.dueDate}</small>}</label>}</div>
        {fields.scheduleKind && <><label className="field"><span>Repeats every</span><select value={fields.recurrenceMonths} onChange={(event) => updateField("recurrenceMonths", event.currentTarget.value)}><option value="">Does not repeat</option><option value="1">1 month</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">12 months</option><option value="24">24 months</option></select></label><fieldset className="reminder-picker"><legend>Remind me beforehand</legend>{reminderOptions.map((days) => <label key={days}><input type="checkbox" checked={fields.reminderDays.includes(days)} onChange={(event) => updateField("reminderDays", event.currentTarget.checked ? [...fields.reminderDays, days] : fields.reminderDays.filter((value) => value !== days))} /><span>{days} days</span></label>)}</fieldset></>}
        <label className="field"><span>Notes</span><textarea value={fields.notes} maxLength={2000} rows={3} onChange={(event) => updateField("notes", event.currentTarget.value)} /></label>
        {evidence.length > 0 && <ul className="imap-evidence" aria-label="Suggestion evidence">{evidence.map(([field, value]) => <li key={field}><span>{field}</span><small>{value.source}; {value.confidence} confidence</small></li>)}</ul>}
      </fieldset>

      <fieldset className="imap-review-section" disabled={retryLocked}><legend>Possible matches</legend><p className="imap-review-help">Only possible matches in {household.name} are shown. Orbit will not merge fields automatically.</p>{review.candidates.length === 0 ? <p>No possible matches were found.</p> : <div className="imap-candidates">{review.candidates.map((candidate) => <label key={candidate.itemId}><input type="radio" name="targetItemId" value={candidate.itemId} checked={targetItemId === candidate.itemId} onChange={(event) => { changed(); setAction("attach_existing"); setTargetItemId(event.currentTarget.value); }} /><span><strong>{candidate.title}</strong><small>{candidate.reason}</small></span></label>)}</div>}</fieldset>

      <fieldset className="imap-review-section" disabled={retryLocked}><legend>Outcome</legend><label><input type="radio" name="reviewAction" checked={action === "create_separate"} onChange={() => { changed(); setAction("create_separate"); setTargetItemId(""); }} /> Create a separate item</label><label><input type="radio" name="reviewAction" checked={action === "attach_existing"} onChange={() => { changed(); setAction("attach_existing"); }} /> Attach selected documents to the chosen existing item</label></fieldset>

      <fieldset className="imap-review-section" disabled={retryLocked}><legend>Documents</legend><p className="imap-review-help">Select only the staged originals you want to transfer. Names and message metadata are not shown.</p>{review.attachments.map((attachment) => <label className="imap-attachment" key={attachment.id}><input type="checkbox" value={attachment.id} checked={selectedAttachments.includes(attachment.id)} onChange={toggleAttachment} /><span>Document {attachment.ordinal}<small>{attachment.mediaType} · {attachment.sizeBytes} bytes</small></span></label>)}</fieldset>
      {message && <p role="status" className="imap-review-message">{message}</p>}
      <footer className="imap-review-actions"><button type="button" onClick={() => void discard()} disabled={submitting}>Discard</button><button type="submit" className="primary" disabled={submitting}>{submitting ? "Working…" : retryLocked ? "Retry approval" : action === "attach_existing" ? "Attach selected documents" : "Create separate item"}</button></footer>
    </form>}
  </div>;
}

export function ImapInbox({ csrfToken }: { csrfToken: string }) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [review, setReview] = useState<{ data: Review; household: Household } | null>(null);
  const [error, setError] = useState("");
  const [loadingReview, setLoadingReview] = useState(false);

  async function load() {
    try {
      const response = await fetch("/api/imap-inbox", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Could not load incoming documents");
      setInbox(await response.json() as Inbox);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load incoming documents"); }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/imap-inbox", { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("Could not load incoming documents");
      return response.json() as Promise<Inbox>;
    }).then((payload) => { if (!cancelled) setInbox(payload); }).catch((caught: unknown) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load incoming documents");
    });
    return () => { cancelled = true; };
  }, []);

  async function openReview(receipt: InboxReceipt, householdId: string) {
    const household = inbox?.households.find((choice) => choice.id === householdId);
    if (!household) return;
    setLoadingReview(true);
    setError("");
    try {
      const response = await fetch(`/api/imap-inbox/${receipt.id}?householdId=${encodeURIComponent(householdId)}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("This private review is no longer available");
      setReview({ data: await response.json() as Review, household });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not open this private review"); }
    finally { setLoadingReview(false); }
  }

  async function assign(receiptId: string, householdId: string) {
    const response = await fetch(`/api/imap-inbox/${receiptId}`, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, body: JSON.stringify({ householdId }) });
    if (!response.ok) { setError("Could not select that household"); return; }
    const receipt = inbox?.receipts.find((candidate) => candidate.id === receiptId);
    if (receipt) await openReview({ ...receipt, householdId }, householdId);
    await load();
  }

  async function discardFromInbox(receiptId: string) {
    if (!window.confirm("Discard this private review? Its staged files will be purged.")) return;
    const response = await fetch(`/api/imap-inbox/${receiptId}`, { method: "DELETE", credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken } });
    if (!response.ok) { setError("Could not discard that private review"); return; }
    await load();
  }

  if (review) return <section className="settings-content"><ReviewForm review={review.data} household={review.household} csrfToken={csrfToken} onBack={() => setReview(null)} onChanged={() => { setReview(null); void load(); }} /></section>;
  return <section className="settings-content"><div className="setting-heading"><h3>Incoming documents</h3><p>Incoming documents remain private until you explicitly review and approve their final values.</p></div>{error && <p role="alert">{error}</p>}{loadingReview && <p role="status">Opening private review…</p>}{!inbox ? <p>Loading incoming documents…</p> : inbox.receipts.length === 0 ? <p>No incoming documents waiting for review.</p> : <div className="admin-list imap-inbox-list">{inbox.receipts.map((receipt) => <article key={receipt.id}><span><strong>{receipt.attachmentCount} document{receipt.attachmentCount === 1 ? "" : "s"}</strong><small>Received {new Date(receipt.receivedAt).toLocaleString()}</small></span><div className="imap-inbox-actions"><b>{receipt.message}</b>{receipt.householdId ? <>{receipt.canApprove && <button type="button" onClick={() => void openReview(receipt, receipt.householdId as string)}>Review</button>}{receipt.canDiscard && <button type="button" onClick={() => void discardFromInbox(receipt.id)}>Discard</button>}</> : <>{receipt.classification === "ready" && <select aria-label={`Choose household for document ${receipt.id}`} defaultValue="" onChange={(event) => { if (event.currentTarget.value) void assign(receipt.id, event.currentTarget.value); }}><option value="" disabled>Choose household…</option>{inbox.households.map((household) => <option key={household.id} value={household.id}>{household.name}</option>)}</select>}{receipt.canDiscard && <button type="button" onClick={() => void discardFromInbox(receipt.id)}>Discard</button>}</>}</div></article>)}</div>}</section>;
}
