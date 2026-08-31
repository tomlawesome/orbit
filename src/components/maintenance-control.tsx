"use client";

import { useEffect, useState } from "react";
import type { WorkspaceSession } from "@/lib/preview-workspace";
import {
  CONFIRM_ACTIVATE,
  CONFIRM_END,
  MAINTENANCE_MESSAGE_MAX_LENGTH,
  characterCountLabel,
  confirmCancelWindow,
  confirmSchedule,
  controlMode,
  formatWhen,
  localInputToIso,
  maintenanceFacts,
  messageProblem,
  pendingWindows,
  type MaintenanceStateView,
} from "@/lib/maintenance-view";

/* The administrator's maintenance control (#524, Fable's ruling 1), on the
   rolling-timeline model of #585. It renders as the first section of the
   administration page, above Operations, and the banner links here by the id.

   The one behavioural change users will notice: publishing during a window
   appends to the timeline instead of replacing what was published before it,
   so "we are running late, here is why" reads as a follow-on. */

type OpenForm = "none" | "activate" | "schedule" | "publish" | "expected-end";

async function responseError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return new Error(payload?.error?.message || fallback);
}

export const MAINTENANCE_CHANGED_EVENT = "orbit:maintenance-changed";

const ENTRY_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  started: "Started",
  update: "Update",
  resolved: "Resolved",
};

export function MaintenanceControl({ session }: { session: WorkspaceSession }) {
  const [state, setState] = useState<MaintenanceStateView | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date>(() => new Date(0));
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [openForm, setOpenForm] = useState<OpenForm>("none");
  const [editingUpdateId, setEditingUpdateId] = useState<string | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [expectedEndDraft, setExpectedEndDraft] = useState("");
  const [startsAtDraft, setStartsAtDraft] = useState("");

  /* Reading is driven by a token rather than a callback the effect
     invokes, because the repository's lint rule rejects a state update
     in an effect body. Anything that needs fresh state bumps the token. */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/maintenance", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw await responseError(response, "Maintenance settings could not be loaded");
        const payload = await response.json() as { maintenance?: MaintenanceStateView };
        if (!payload.maintenance) throw new Error("Maintenance settings could not be loaded");
        if (cancelled) return;
        setState(payload.maintenance);
        setLoadedAt(new Date());
        setLoadError("");
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "Maintenance settings could not be loaded");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadToken]);

  function reload() {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }

  /* A mutation the domain accepted moves the whole instance, so the
     banner is told to re-read rather than left showing the old state. */
  function announceChange() {
    window.dispatchEvent(new CustomEvent(MAINTENANCE_CHANGED_EVENT));
  }

  async function mutate(body: Record<string, unknown>, success: string, fallback: string) {
    if (!state) return;
    setBusy(true); setMessage(""); setActionError("");
    try {
      const response = await fetch("/api/admin/maintenance", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ ...body, expectedVersion: state.version }),
      });
      /* Someone else changed maintenance between the read and this
         write. Refresh and let the administrator look again; never
         replay the mutation against state they have not seen. */
      if (response.status === 409) {
        reload();
        setOpenForm("none");
        setEditingUpdateId(null);
        setActionError("Maintenance settings changed elsewhere. The view has been refreshed — review and try again.");
        return;
      }
      if (!response.ok) throw await responseError(response, fallback);
      const payload = await response.json() as { maintenance?: MaintenanceStateView };
      if (!payload.maintenance) throw new Error(fallback);
      setState(payload.maintenance);
      setLoadedAt(new Date());
      setOpenForm("none");
      setEditingUpdateId(null);
      setMessage(success);
      announceChange();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  function disclose(form: OpenForm) {
    setMessage(""); setActionError(""); setEditingUpdateId(null);
    if (form !== "none") { setMessageDraft(""); setExpectedEndDraft(""); setStartsAtDraft(""); }
    setOpenForm(form);
  }

  function discloseEdit(updateId: string, body: string) {
    setMessage(""); setActionError("");
    setOpenForm("none");
    setEditingUpdateId((current) => (current === updateId ? null : updateId));
    setMessageDraft(body);
  }

  function discloseExpectedEnd(current: string | null) {
    setMessage(""); setActionError(""); setEditingUpdateId(null);
    /* datetime-local wants a local wall-clock value, and the stored one is
       UTC; trimming the offset-adjusted ISO string is the inverse of
       localInputToIso. */
    setExpectedEndDraft(current ? new Date(new Date(current).getTime() - new Date(current).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");
    setOpenForm(openForm === "expected-end" ? "none" : "expected-end");
  }

  async function submitActivate(event: React.FormEvent) {
    event.preventDefault();
    const problem = messageProblem(messageDraft);
    if (problem) { setActionError(problem); return; }
    if (!window.confirm(CONFIRM_ACTIVATE)) return;
    await mutate(
      { action: "activate", message: messageDraft, expectedEndAt: localInputToIso(expectedEndDraft) },
      "Maintenance is active.",
      "Maintenance could not be started",
    );
  }

  async function submitSchedule(event: React.FormEvent) {
    event.preventDefault();
    const problem = messageProblem(messageDraft);
    if (problem) { setActionError(problem); return; }
    const startsAt = localInputToIso(startsAtDraft);
    if (!startsAt) { setActionError("Choose when maintenance should start."); return; }
    if (!window.confirm(confirmSchedule(startsAt))) return;
    await mutate(
      { action: "schedule_window", message: messageDraft, startsAt, expectedEndAt: localInputToIso(expectedEndDraft) },
      "Maintenance scheduled.",
      "The maintenance window could not be scheduled",
    );
  }

  /* Publishing a follow-on update is additive and low-consequence — nothing
     already published is touched — so it carries no confirmation (ruling 1). */
  async function submitPublish(event: React.FormEvent) {
    event.preventDefault();
    const problem = messageProblem(messageDraft);
    if (problem) { setActionError(problem); return; }
    await mutate(
      { action: "publish_update", message: messageDraft },
      "Update published.",
      "The update could not be published",
    );
  }

  async function submitEdit(event: React.FormEvent, updateId: string) {
    event.preventDefault();
    const problem = messageProblem(messageDraft);
    if (problem) { setActionError(problem); return; }
    await mutate(
      { action: "edit_update", updateId, message: messageDraft },
      "Entry corrected.",
      "The entry could not be corrected",
    );
  }

  async function submitExpectedEnd(event: React.FormEvent) {
    event.preventDefault();
    await mutate(
      { action: "revise_expected_end", expectedEndAt: localInputToIso(expectedEndDraft) },
      "Expected end updated.",
      "The expected end could not be updated",
    );
  }

  async function endMaintenance() {
    if (!window.confirm(CONFIRM_END)) return;
    await mutate({ action: "end" }, "Maintenance ended.", "Maintenance could not be ended");
  }

  async function cancelWindow(windowId: string, startsAt: string) {
    if (!window.confirm(confirmCancelWindow(startsAt))) return;
    await mutate({ action: "cancel_window", windowId }, "Scheduled maintenance cancelled.", "The scheduled maintenance could not be cancelled");
  }

  const shownError = actionError || loadError;
  const mode = state ? controlMode(state, loadedAt) : "open";
  const facts = state ? maintenanceFacts(state, loadedAt) : null;
  const pending = state ? pendingWindows(state) : [];

  const messageField = <label className="maintenance-field">
    <span>Message shown on the maintenance screen</span>
    <textarea
      required
      rows={4}
      maxLength={MAINTENANCE_MESSAGE_MAX_LENGTH}
      value={messageDraft}
      onChange={(event) => setMessageDraft(event.target.value)}
    />
    <small>{characterCountLabel(messageDraft)} · Up to 8 lines.</small>
  </label>;

  const expectedEndField = <label className="maintenance-field">
    <span>Expected end (optional)</span>
    <input type="datetime-local" value={expectedEndDraft} onChange={(event) => setExpectedEndDraft(event.target.value)} />
    <small>Shown to users, and sent to blocked clients as Retry-After.</small>
  </label>;

  return <section id="maintenance">
    <div className="setting-heading admin-heading"><div><h3>Maintenance</h3><p>Close Orbit to users for planned work. Administrators keep full access.</p></div><button type="button" className="admin-refresh" onClick={() => reload()} disabled={loading || busy}>{loading ? "Refreshing…" : "Refresh"}</button></div>
    {shownError && <p className="admin-health-warning" role="alert">{shownError}</p>}
    {state ? <>
      {mode === "open" ? <>
        <p className="member-message" role="status">Orbit is open to users.</p>
        <div className="admin-operation-actions">
          <button type="button" onClick={() => disclose(openForm === "activate" ? "none" : "activate")} disabled={busy}>Start maintenance…</button>
          <button type="button" onClick={() => disclose(openForm === "schedule" ? "none" : "schedule")} disabled={busy}>Schedule maintenance…</button>
        </div>
        {openForm === "activate" && <form className="maintenance-form" onSubmit={(event) => void submitActivate(event)}>
          {messageField}
          {expectedEndField}
          <div className="admin-operation-actions"><button type="submit" disabled={busy}>{busy ? "Closing Orbit…" : "Close Orbit to users"}</button><button type="button" onClick={() => disclose("none")} disabled={busy}>Cancel</button></div>
        </form>}
        {openForm === "schedule" && <form className="maintenance-form" onSubmit={(event) => void submitSchedule(event)}>
          {messageField}
          <label className="maintenance-field">
            <span>Start time</span>
            <input type="datetime-local" required value={startsAtDraft} onChange={(event) => setStartsAtDraft(event.target.value)} />
            <small>Maintenance starts automatically at this time.</small>
          </label>
          {expectedEndField}
          <div className="admin-operation-actions"><button type="submit" disabled={busy}>{busy ? "Scheduling…" : "Schedule maintenance"}</button><button type="button" onClick={() => disclose("none")} disabled={busy}>Cancel</button></div>
        </form>}
      </> : <>
        <p className="admin-health-warning" role="alert">Maintenance is active. Users see the maintenance screen; administrators keep full access.</p>
        <div className="admin-health-grid">
          <article><span>Started</span><strong>{formatWhen(facts?.startedAt ?? null)}</strong></article>
          <article><span>Last published</span><strong>{formatWhen(facts?.lastPublishedAt ?? null)}</strong></article>
          <article><span>Expected end</span><strong>{formatWhen(facts?.expectedEndAt ?? null)}</strong></article>
        </div>
        {/* Newest first, and only this window's entries (ADR-0013 decision 8). */}
        <ul className="admin-job-list maintenance-timeline">{(facts?.timeline ?? []).map((entry) => <li key={entry.id}>
          <span>
            <strong>{ENTRY_LABELS[entry.kind] ?? "Update"} · {formatWhen(entry.publishedAt)}{entry.editedAt ? " · edited" : ""}</strong>
            <p className="maintenance-published-message">{entry.body}</p>
          </span>
          {mode === "active" && <span className="admin-job-actions">
            <button type="button" onClick={() => discloseEdit(entry.id, entry.body)} disabled={busy}>Correct</button>
          </span>}
          {editingUpdateId === entry.id && <form className="maintenance-form" onSubmit={(event) => void submitEdit(event, entry.id)}>
            {messageField}
            <div className="admin-operation-actions"><button type="submit" disabled={busy}>{busy ? "Correcting…" : "Save correction"}</button><button type="button" onClick={() => setEditingUpdateId(null)} disabled={busy}>Cancel</button></div>
          </form>}
        </li>)}</ul>
        <div className="admin-operation-actions">
          {/* A due scheduled window holds the instance closed before the
              worker opens it, so there is no timeline to publish into yet. */}
          {mode === "active" && <button type="button" onClick={() => disclose(openForm === "publish" ? "none" : "publish")} disabled={busy}>Publish update</button>}
          {mode === "active" && <button type="button" onClick={() => discloseExpectedEnd(facts?.expectedEndAt ?? null)} disabled={busy}>Revise expected end</button>}
          <button type="button" onClick={() => void endMaintenance()} disabled={busy}>{busy ? "Working…" : "End maintenance"}</button>
        </div>
        {openForm === "publish" && <form className="maintenance-form" onSubmit={(event) => void submitPublish(event)}>
          {messageField}
          <div className="admin-operation-actions"><button type="submit" disabled={busy}>{busy ? "Publishing…" : "Publish update"}</button><button type="button" onClick={() => disclose("none")} disabled={busy}>Cancel</button></div>
        </form>}
        {openForm === "expected-end" && <form className="maintenance-form" onSubmit={(event) => void submitExpectedEnd(event)}>
          {expectedEndField}
          <div className="admin-operation-actions"><button type="submit" disabled={busy}>{busy ? "Saving…" : "Save expected end"}</button><button type="button" onClick={() => disclose("none")} disabled={busy}>Cancel</button></div>
        </form>}
      </>}
      <div className="admin-job-group">
        <h4>Scheduled maintenance</h4>
        {pending.length ? <ul className="admin-job-list maintenance-notice-list">{pending.map((entry) => <li key={entry.id}>
          <span>
            <strong>{formatWhen(entry.scheduledStartAt)} → {formatWhen(entry.expectedEndAt)}</strong>
            <small>{entry.updates[0]?.body ?? ""}</small>
          </span>
          <span className="admin-job-actions"><button type="button" onClick={() => void cancelWindow(entry.id, entry.scheduledStartAt ?? "")} disabled={busy}>Cancel</button></span>
        </li>)}</ul> : <p className="member-message">No maintenance is scheduled.</p>}
      </div>
      {message && <p className="member-message" role="status" aria-live="polite">{message}</p>}
    </> : !shownError && <p className="member-message" role="status">Loading maintenance settings…</p>}
  </section>;
}
