"use client";

import { useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { DocumentManager } from "@/components/document-manager";
import { suggestNextDate, type HomeItem, type HouseholdSection } from "@/lib/domain";
import type { ItemActivity } from "@/lib/workspace";

export interface CompletionInput {
  completedDate: string;
  nextDate?: string;
  costMinor?: number;
  notes?: string;
}

interface ItemDetailProps {
  item: HomeItem;
  section?: HouseholdSection;
  activities: ItemActivity[];
  today: string;
  householdId: string;
  csrfToken: string;
  onClose(): void;
  onEdit(): void;
  onComplete(input: CompletionInput): void;
  onReschedule(dueDate: string): void;
  onSnooze(until: string): void;
  onCancel(): void;
  onRestore(): void;
  onArchive(): void;
}

type DetailAction = "complete" | "reschedule" | "snooze" | null;

function formatDate(value: string | undefined, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
    ...options,
  }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

function formatCost(item: HomeItem) {
  if (item.costMinor == null) return "Not recorded";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: item.currency }).format(item.costMinor / 100);
}

function activityTitle(activity: ItemActivity) {
  const labels: Record<ItemActivity["kind"], string> = {
    created: "Item added",
    updated: "Details updated",
    renewal_completed: "Renewal completed",
    service_completed: "Service completed",
    rescheduled: "Date rescheduled",
    snoozed: "Reminder snoozed",
    cancelled: "Item cancelled",
    restored: "Item restored",
    archived: "Item archived",
  };
  return labels[activity.kind];
}

function activityDetail(activity: ItemActivity, currency: string) {
  const parts: string[] = [];
  if (activity.previousDate && activity.nextDate) {
    parts.push(`${formatDate(activity.previousDate)} → ${formatDate(activity.nextDate)}`);
  } else if (activity.nextDate) {
    parts.push(`Next date ${formatDate(activity.nextDate)}`);
  } else if (activity.effectiveDate) {
    parts.push(`Completed ${formatDate(activity.effectiveDate)}`);
  }
  if (activity.costMinor != null) {
    parts.push(new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(activity.costMinor / 100));
  }
  if (activity.notes) parts.push(activity.notes);
  return parts.join(" · ");
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function ItemDetail({
  item,
  section,
  activities,
  today,
  householdId,
  csrfToken,
  onClose,
  onEdit,
  onComplete,
  onReschedule,
  onSnooze,
  onCancel,
  onRestore,
  onArchive,
}: ItemDetailProps) {
  const [action, setAction] = useState<DetailAction>(null);
  const itemActivities = activities
    .filter((activity) => activity.itemId === item.id)
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  const defaultNextDate = item.recurrenceMonths && item.dueDate
    ? suggestNextDate(item.dueDate, item.recurrenceMonths)
    : "";
  const active = item.status === "active";

  function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const rawCost = String(formData.get("cost") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    setAction(null);
    onComplete({
      completedDate: String(formData.get("completedDate")),
      nextDate: String(formData.get("nextDate") ?? "").trim() || undefined,
      costMinor: rawCost ? Math.round(Number(rawCost) * 100) : undefined,
      notes: notes || undefined,
    });
  }

  function reschedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAction(null);
    onReschedule(String(new FormData(event.currentTarget).get("dueDate")));
  }

  function snooze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAction(null);
    onSnooze(String(new FormData(event.currentTarget).get("snoozedUntil")));
  }

  return (
    <>
      <button className="editor-scrim" type="button" aria-label="Close item details" onClick={onClose} />
      <aside className="item-detail" role="dialog" aria-modal="true" aria-labelledby="item-detail-title">
        <header className="detail-header">
          <span className={`detail-icon accent-${section?.accent ?? "sage"}`}><Icon name={section?.icon ?? "calendar"} /></span>
          <div>
            <p>{section?.name ?? "Household item"}</p>
            <h2 id="item-detail-title">{item.title}</h2>
            <span className={`detail-status detail-status-${item.status}`}>{item.status}</span>
          </div>
          <button type="button" aria-label="Close item details" onClick={onClose}>×</button>
        </header>

        <div className="detail-body">
          {active ? (
            <div className="detail-actions">
              {item.scheduleKind && item.dueDate && (
                <button className="primary" onClick={() => setAction(action === "complete" ? null : "complete")}>
                  <Icon name="check" /> Complete {item.scheduleKind}
                </button>
              )}
              <button onClick={onEdit}><Icon name="settings" /> Edit details</button>
            </div>
          ) : (
            <div className="restore-banner">
              <span><strong>This item is {item.status}</strong><small>Restore it to return it to your active household.</small></span>
              <button onClick={onRestore}>Restore item</button>
            </div>
          )}

          {action === "complete" && (
            <form className="detail-action-panel" onSubmit={complete}>
              <header><div><span>Complete</span><h3>Record this {item.scheduleKind}</h3></div><button type="button" onClick={() => setAction(null)}>×</button></header>
              <div className="field-grid">
                <label className="field">
                  <span>Completed on</span>
                  <input name="completedDate" type="date" defaultValue={today} required />
                </label>
                <label className="field">
                  <span>Final cost ({item.currency})</span>
                  <input name="cost" type="number" min="0" step="0.01" defaultValue={item.costMinor == null ? "" : (item.costMinor / 100).toFixed(2)} />
                </label>
              </div>
              <label className="field field-wide">
                <span>{item.recurrenceMonths ? "Next scheduled date" : "Schedule another date (optional)"}</span>
                <input name="nextDate" type="date" defaultValue={defaultNextDate} />
              </label>
              <label className="field field-wide">
                <span>Completion notes</span>
                <textarea name="notes" rows={3} maxLength={1000} placeholder="What changed, who completed it, anything to remember…" />
              </label>
              <footer><button type="button" onClick={() => setAction(null)}>Cancel</button><button type="submit">Save completion</button></footer>
            </form>
          )}

          {action === "reschedule" && (
            <form className="detail-action-panel compact" onSubmit={reschedule}>
              <header><div><span>Schedule</span><h3>Choose a new date</h3></div><button type="button" onClick={() => setAction(null)}>×</button></header>
              <label className="field field-wide"><span>New due date</span><input name="dueDate" type="date" defaultValue={item.dueDate ?? today} required /></label>
              <footer><button type="button" onClick={() => setAction(null)}>Cancel</button><button type="submit">Reschedule</button></footer>
            </form>
          )}

          {action === "snooze" && (
            <form className="detail-action-panel compact" onSubmit={snooze}>
              <header><div><span>Notifications</span><h3>Snooze reminders</h3></div><button type="button" onClick={() => setAction(null)}>×</button></header>
              <p>The actual due date will not change. Notifications will resume on the date below.</p>
              <label className="field field-wide"><span>Resume reminders</span><input name="snoozedUntil" type="date" min={today} defaultValue={item.snoozedUntil ?? addDays(today, 7)} required /></label>
              <footer><button type="button" onClick={() => setAction(null)}>Cancel</button><button type="submit">Snooze</button></footer>
            </form>
          )}

          <section className="detail-section">
            <div className="detail-section-title"><span>01</span><h3>At a glance</h3></div>
            <dl className="detail-facts">
              <div><dt>Provider</dt><dd>{item.provider ?? "Not recorded"}</dd></div>
              <div><dt>Reference</dt><dd>{item.reference ?? "Not recorded"}</dd></div>
              <div><dt>Type</dt><dd>{item.subtype ?? "Not recorded"}</dd></div>
              <div><dt>Cost</dt><dd>{formatCost(item)}</dd></div>
              <div><dt>{item.scheduleKind === "service" ? "Service date" : "Renewal date"}</dt><dd>{formatDate(item.dueDate)}</dd></div>
              <div><dt>Repeats</dt><dd>{item.recurrenceMonths ? item.recurrenceMonths === 12 ? "Every year" : `Every ${item.recurrenceMonths} months` : "Does not repeat"}</dd></div>
            </dl>
            {item.reminderDays?.length ? <p className="reminder-summary"><Icon name="bell" /> Reminders {item.reminderDays.map((days) => days === 1 ? "1 day" : `${days} days`).join(", ")} beforehand{item.snoozedUntil ? ` · snoozed until ${formatDate(item.snoozedUntil)}` : ""}</p> : null}
          </section>

          {item.notes && (
            <section className="detail-section">
              <div className="detail-section-title"><span>02</span><h3>Notes</h3></div>
              <p className="detail-notes">{item.notes}</p>
            </section>
          )}

          <DocumentManager householdId={householdId} itemId={item.id} csrfToken={csrfToken} />

          <section className="detail-section">
            <div className="detail-section-title"><span>{item.notes ? "04" : "03"}</span><h3>Activity</h3></div>
            <div className="activity-timeline">
              {itemActivities.map((activity) => (
                <article key={activity.id}>
                  <i />
                  <div>
                    <span><strong>{activityTitle(activity)}</strong><time>{formatDate(activity.occurredAt, { month: "short" })}</time></span>
                    {activityDetail(activity, item.currency) && <p>{activityDetail(activity, item.currency)}</p>}
                  </div>
                </article>
              ))}
              {!itemActivities.length && <p className="activity-empty">No activity has been recorded yet.</p>}
            </div>
          </section>

          {active && (
            <section className="detail-manage">
              <h3>Manage item</h3>
              <div>
                <button onClick={() => setAction(action === "reschedule" ? null : "reschedule")}><Icon name="calendar" /> Reschedule</button>
                {item.dueDate && <button onClick={() => setAction(action === "snooze" ? null : "snooze")}><Icon name="clock" /> Snooze</button>}
                <button onClick={onCancel}><Icon name="close" /> Cancel item</button>
                <button onClick={onArchive}><Icon name="archive" /> Archive</button>
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
