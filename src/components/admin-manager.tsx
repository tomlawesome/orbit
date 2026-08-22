"use client";

import { useEffect, useState } from "react";
import type { WorkspaceSession } from "@/lib/preview-workspace";

interface InstanceUser {
  id: string;
  displayName: string;
  email: string;
  isInstanceAdmin: boolean;
  isPrimaryAdministrator: boolean;
  disabledAt: string | null;
}

interface AdminManagerProps {
  session: WorkspaceSession;
}

interface DocumentHealth {
  overall: "healthy" | "degraded";
  encryption: { status: "ready" | "unavailable" };
  storage: { status: "ready" | "unavailable" };
  scanner: { status: "ready" | "disabled" | "unavailable"; mode: "required" | "disabled" | "unknown" };
  quota: { usedBytes: number; limitBytes: number };
  worker: { started: boolean; running: boolean; lastSuccessAt: string | null; lastErrorAt: string | null; lastErrorCode: string | null; lastReconciliationAt: string | null };
  scanRecovery: { retrying: number; failed: number; purgePending: number; nextExpiryAt: string | null };
}

type JobAction = "retry" | "discard";
type ProviderState = "configured" | "unconfigured";
type MailProviderStatus = "not_configured" | "disabled" | "verification_pending" | "available" | "provider_unavailable" | "unsafe_input" | "retrying" | "exhausted" | "retention_backlog";
type DeliveryStatus = "pending" | "processing" | "sent" | "retry" | "failed" | "cancelled";
type DocumentJobStatus = "pending" | "processing" | "retry" | "completed" | "failed" | "cancelled";

interface Operations {
  configurationProblems: Array<{
    code: "configuration_version" | "configuration_core" | "configuration_optional";
    severity: "error" | "warning";
    setting: string;
    fallback: "startup_blocked" | "feature_disabled";
    remediation: "check_configuration" | "repair_configuration";
  }>;
  notificationWorker: { started: boolean; running: boolean; lastSuccessAt: string | null; lastErrorAt: string | null; lastErrorCode: string | null };
  providers: { smtp: ProviderState; push: ProviderState };
  mailboxIngestion: {
    enabled: boolean;
    configured: boolean;
    status: MailProviderStatus;
    smtp: Exclude<MailProviderStatus, "disabled" | "verification_pending" | "available" | "retrying" | "exhausted" | "retention_backlog">;
    imap: Exclude<MailProviderStatus, "disabled" | "verification_pending" | "available" | "retrying" | "exhausted" | "retention_backlog">;
    worker: { started: boolean; running: boolean; lastSuccessAt: string | null; lastErrorAt: string | null; lastErrorCode: string | null };
  };
  deliveryCounts: Record<string, number>;
  mailboxNotifications: { status: MailProviderStatus };
  documentJobCounts: Record<string, number>;
  deliveries: Array<{ id: string; channel: string; status: DeliveryStatus; attempts: number; scheduledFor: string; lastErrorCode: string | null; updatedAt: string }>;
  documentJobs: Array<{ id: string; kind: string; status: DocumentJobStatus; attempts: number; lastErrorCode: string | null; nextAttemptAt: string; createdAt: string; updatedAt: string }>;
  audit: Array<{ id: string; actorName: string; householdName: string; actionLabel: string; createdAt: string }>;
  nextCursor: string | null;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return new Error(payload?.error?.message || fallback);
}

export function AdminManager({ session }: AdminManagerProps) {
  const [users, setUsers] = useState<InstanceUser[]>([]);
  const [message, setMessage] = useState("");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [documentHealth, setDocumentHealth] = useState<DocumentHealth | null>(null);
  const [healthError, setHealthError] = useState("");
  const [operations, setOperations] = useState<Operations | null>(null);
  const [operationsError, setOperationsError] = useState("");
  const [operationsLoading, setOperationsLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(false);
  const [operationsBusy, setOperationsBusy] = useState<string | null>(null);
  const [smtpTestState, setSmtpTestState] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [imapTestState, setImapTestState] = useState<"idle" | "sending" | "success" | "error">("idle");

  async function loadOperations() {
    setOperationsLoading(true);
    setOperationsError("");
    try {
      const response = await fetch("/api/admin/operations", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw await responseError(response, "Operations could not be loaded");
      const payload = await response.json() as { operations?: Operations };
      if (!payload.operations) throw new Error("Operations could not be loaded");
      setOperations(payload.operations);
    } catch (error) {
      setOperationsError(error instanceof Error ? error.message : "Operations could not be loaded");
    } finally {
      setOperationsLoading(false);
    }
  }

  async function loadOlderAudit() {
    if (!operations?.nextCursor || auditLoading) return;
    setAuditLoading(true);
    setOperationsError("");
    try {
      const response = await fetch(`/api/admin/operations?auditCursor=${encodeURIComponent(operations.nextCursor)}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw await responseError(response, "Older audit history could not be loaded");
      const payload = await response.json() as { operations?: Operations };
      if (!payload.operations) throw new Error("Older audit history could not be loaded");
      setOperations((current) => current ? {
        ...current,
        audit: [...current.audit, ...payload.operations!.audit],
        nextCursor: payload.operations!.nextCursor,
      } : payload.operations!);
    } catch (error) {
      setOperationsError(error instanceof Error ? error.message : "Older audit history could not be loaded");
    } finally {
      setAuditLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/users", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw await responseError(response, "Users could not be loaded");
        const payload = await response.json() as { users?: InstanceUser[] };
        if (!payload.users) throw new Error("Users could not be loaded");
        if (!cancelled) setUsers(payload.users);
      })
      .catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "Users could not be loaded"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/documents/health", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Document health could not be loaded");
        const payload = await response.json() as { health?: DocumentHealth };
        if (!payload.health) throw new Error("Document health could not be loaded");
        if (!cancelled) setDocumentHealth(payload.health);
      })
      .catch(() => { if (!cancelled) setHealthError("Document health could not be loaded."); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/operations", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw await responseError(response, "Operations could not be loaded");
        const payload = await response.json() as { operations?: Operations };
        if (!payload.operations) throw new Error("Operations could not be loaded");
        if (!cancelled) setOperations(payload.operations);
      })
      .catch((error) => {
        if (!cancelled) setOperationsError(error instanceof Error ? error.message : "Operations could not be loaded");
      })
      .finally(() => {
        if (!cancelled) setOperationsLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function updateAdministrator(user: InstanceUser) {
    setBusyUserId(user.id); setMessage("");
    try {
      const response = await fetch("/api/admin/users", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ userId: user.id, administrator: !user.isInstanceAdmin }) });
      if (!response.ok) throw await responseError(response, "Administrator access could not be updated");
      const payload = await response.json() as { users?: InstanceUser[] };
      if (!payload.users) throw new Error("Administrator access could not be updated");
      setUsers(payload.users);
      setMessage(`${user.displayName} ${user.isInstanceAdmin ? "is no longer" : "is now"} an Orbit administrator.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Administrator access could not be updated"); }
    finally { setBusyUserId(null); }
  }

  async function updateAccountStatus(user: InstanceUser) {
    const disabling = !user.disabledAt;
    const confirmation = disabling
      ? `Disable ${user.displayName}'s Orbit account? All of their active Orbit sessions will be revoked immediately.`
      : `Enable ${user.displayName}'s Orbit account? They will be able to sign in again.`;
    if (!window.confirm(confirmation)) return;
    setBusyUserId(user.id); setMessage("");
    try {
      const response = await fetch("/api/admin/users", { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ userId: user.id, disabled: disabling }) });
      if (!response.ok) throw await responseError(response, "Account status could not be updated");
      const payload = await response.json() as { users?: InstanceUser[] };
      if (!payload.users) throw new Error("Account status could not be updated");
      setUsers(payload.users);
      setMessage(`${user.displayName}'s account is now ${disabling ? "disabled" : "enabled"}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Account status could not be updated"); }
    finally { setBusyUserId(null); }
  }

  async function transferPrimary(target: InstanceUser) {
    const confirmation =
      `Transfer primary administrator authority to ${target.displayName} (${target.email})? ` +
      `You will remain an ordinary administrator, and only ${target.displayName} will hold final authority over this Orbit.`;
    if (!window.confirm(confirmation)) return;
    setBusyUserId(target.id); setMessage("");
    try {
      const response = await fetch("/api/admin/primary", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ targetUserId: target.id }) });
      if (!response.ok) throw await responseError(response, "Primary authority could not be transferred");
      const payload = await response.json() as { users?: InstanceUser[] };
      if (!payload.users) throw new Error("Primary authority could not be transferred");
      setUsers(payload.users);
      setMessage(`${target.displayName} is now the primary administrator.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Primary authority could not be transferred"); }
    finally { setBusyUserId(null); }
  }

  async function mutateJob(
    kind: "deliveries" | "document-jobs",
    id: string,
    action: JobAction,
    expectedStatus: DeliveryStatus | DocumentJobStatus,
  ) {
    const actionName = action === "retry" ? "retry" : "discard";
    const warning = action === "retry"
      ? kind === "deliveries"
        ? "Retrying can create a duplicate delivery if the previous attempt reached its provider. Continue?"
        : "Retry this failed document maintenance job?"
      : "Discard this job? It will not run again.";
    if (!window.confirm(warning)) return;
    const busyKey = `${kind}:${id}`;
    setOperationsBusy(busyKey); setOperationsError("");
    try {
      const response = await fetch(`/api/admin/operations/${kind}/${id}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ action, expectedStatus }) });
      if (!response.ok) throw await responseError(response, `Job could not be ${actionName}ed`);
      setMessage(`Job ${actionName === "retry" ? "queued for retry" : "discarded"}.`);
      await loadOperations();
    } catch (error) { setOperationsError(error instanceof Error ? error.message : `Job could not be ${actionName}ed`); }
    finally { setOperationsBusy(null); }
  }

  async function testSmtp() {
    setSmtpTestState("sending"); setOperationsError("");
    try {
      const response = await fetch("/api/admin/operations/smtp-test", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": session.csrfToken } });
      if (!response.ok) throw await responseError(response, "SMTP test could not be started");
      const payload = await response.json() as { result?: string };
      if (payload.result !== "ready") throw new Error(`SMTP test: ${payload.result ?? "unknown"}`);
      setSmtpTestState("success"); setMessage("SMTP connection and authentication succeeded.");
    } catch (error) { setSmtpTestState("error"); setOperationsError(error instanceof Error ? error.message : "SMTP test could not be started"); }
  }

  async function testImap() {
    setImapTestState("sending"); setOperationsError("");
    try {
      const response = await fetch("/api/admin/operations/imap-test", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": session.csrfToken } });
      if (!response.ok) throw await responseError(response, "Inbound mail verification could not be started");
      const payload = await response.json() as { result?: string };
      if (payload.result !== "available") throw new Error(`Inbound mail verification: ${payload.result ?? "unknown"}`);
      setImapTestState("success"); setMessage("Inbound mail providers are available; mailbox polling may run.");
      await loadOperations();
    } catch (error) { setImapTestState("error"); setOperationsError(error instanceof Error ? error.message : "Inbound mail verification could not be started"); }
  }

  async function retryMailboxNotifications() {
    if (!window.confirm("Retry exhausted mailbox notifications? A provider may have accepted an earlier attempt.")) return;
    setOperationsBusy("mailbox-notifications"); setOperationsError("");
    try {
      const response = await fetch("/api/admin/operations/mailbox-notifications", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify({ action: "retry_exhausted" }) });
      if (!response.ok) throw await responseError(response, "Mailbox notifications could not be queued");
      setMessage("Exhausted mailbox notifications queued for bounded retry.");
      await loadOperations();
    } catch (error) { setOperationsError(error instanceof Error ? error.message : "Mailbox notifications could not be queued"); }
    finally { setOperationsBusy(null); }
  }

  return <div className="settings-content">
    <section>
      <div className="setting-heading admin-heading"><div><h3>Operations</h3><p>Safe status for delivery, jobs and configured providers.</p></div><button type="button" className="admin-refresh" onClick={() => void loadOperations()} disabled={operationsLoading}>{operationsLoading ? "Refreshing…" : "Refresh"}</button></div>
      {operationsError && <p className="admin-health-warning" role="alert">{operationsError}</p>}
      {operations ? <>
        <div className="admin-health-grid admin-operations-grid">
          <article><span>Notification worker</span><strong data-status={operations.notificationWorker.started ? "ready" : "unavailable"}>{operations.notificationWorker.running ? "running" : operations.notificationWorker.started ? "idle" : "unavailable"}</strong></article>
          <article><span>SMTP</span><strong data-status={operations.providers.smtp === "configured" ? "ready" : "unavailable"}>{operations.providers.smtp}</strong></article>
          <article><span>Mailbox ingestion</span><strong data-status={operations.mailboxIngestion.status === "available" ? "ready" : "unavailable"}>{operations.mailboxIngestion.status}</strong></article>
          <article><span>Web Push</span><strong data-status={operations.providers.push === "configured" ? "ready" : "unavailable"}>{operations.providers.push}</strong></article>
          <article><span>Worker success</span><strong>{formatDate(operations.notificationWorker.lastSuccessAt)}</strong></article>
        </div>
        <div className="admin-operation-detail" aria-live="polite">
          <strong>Configuration</strong>
          {operations.configurationProblems.length === 0
            ? <p>No current configuration problems.</p>
            : <ul>{operations.configurationProblems.map((problem) => <li key={`${problem.setting}:${problem.code}`}><strong>{problem.severity}</strong> · {problem.setting} · {problem.code} · fallback: {problem.fallback} · action: {problem.remediation}</li>)}</ul>}
        </div>
        {operations.notificationWorker.lastErrorCode && <p className="admin-operation-detail" role="status">Latest worker error: {operations.notificationWorker.lastErrorCode}</p>}
        <div className="admin-operation-actions"><button type="button" onClick={() => void testSmtp()} disabled={smtpTestState === "sending" || operations.providers.smtp !== "configured"}>{smtpTestState === "sending" ? "Testing SMTP…" : "Test SMTP"}</button>{smtpTestState === "success" && <span role="status">SMTP test passed.</span>}<button type="button" onClick={() => void testImap()} disabled={imapTestState === "sending" || !operations.mailboxIngestion.configured}>{imapTestState === "sending" ? "Verifying inbound mail…" : "Verify inbound mail"}</button>{imapTestState === "success" && <span role="status">Inbound mail verification passed.</span>}</div>
        <div className="admin-counts" aria-label="Queue counts">
          <article><strong>Delivery queue</strong>{Object.entries(operations.deliveryCounts).map(([status, count]) => <span key={status}>{status}: {count}</span>)}</article>
          <article><strong>Mailbox notifications</strong><span>{operations.mailboxNotifications.status}</span>{operations.mailboxNotifications.status === "exhausted" && <button type="button" disabled={operationsBusy !== null} onClick={() => void retryMailboxNotifications()}>{operationsBusy === "mailbox-notifications" ? "Queueing…" : "Retry exhausted"}</button>}</article>
          <article><strong>Document jobs</strong>{Object.entries(operations.documentJobCounts).map(([status, count]) => <span key={status}>{status}: {count}</span>)}</article>
        </div>
        <JobList title="Delivery jobs" empty="No delivery jobs need attention." jobs={operations.deliveries} busy={operationsBusy} onAction={(id, action, status) => void mutateJob("deliveries", id, action, status)} />
        <JobList title="Document jobs" empty="No document jobs need attention." jobs={operations.documentJobs} busy={operationsBusy} onAction={(id, action, status) => void mutateJob("document-jobs", id, action, status)} />
      </> : !operationsError && <p className="member-message" role="status">Loading operations…</p>}
    </section>

    <section>
      <div className="setting-heading"><h3>Recent audit history</h3><p>Security and data actions only. Content and credentials are never shown.</p></div>
      {operations?.audit.length ? <><ol className="admin-audit-list">{operations.audit.map((entry) => <li key={entry.id}><strong>{entry.actionLabel}</strong><span>{entry.actorName} · {entry.householdName}</span><time dateTime={entry.createdAt}>{formatDate(entry.createdAt)}</time></li>)}</ol>{operations.nextCursor && <button type="button" className="admin-refresh" onClick={() => void loadOlderAudit()} disabled={auditLoading}>{auditLoading ? "Loading older history…" : "Load older history"}</button>}</> : <p className="member-message">No recent audit events.</p>}
    </section>

    <section>
      <div className="setting-heading"><h3>Document protection</h3><p>Encryption, storage, malware scanning and retention-worker status.</p></div>
      {documentHealth ? <><>{documentHealth.scanner.status === "disabled" && <p className="admin-health-warning" role="alert">Malware scanning is disabled. New files are accepted without a virus scan.</p>}{documentHealth.overall === "degraded" && documentHealth.scanner.status !== "disabled" && <p className="admin-health-warning" role="alert">Document protection needs attention. Uploads fail closed while required protection is unavailable.</p>}</><div className="admin-health-grid"><article><span>Encryption key</span><strong data-status={documentHealth.encryption.status}>{documentHealth.encryption.status}</strong></article><article><span>Encrypted storage</span><strong data-status={documentHealth.storage.status}>{documentHealth.storage.status}</strong></article><article><span>Malware scanner</span><strong data-status={documentHealth.scanner.status}>{documentHealth.scanner.status}</strong></article><article><span>Retention worker</span><strong data-status={documentHealth.worker.started ? "ready" : "unavailable"}>{documentHealth.worker.started ? "ready" : "unavailable"}</strong></article><article><span>Storage quota</span><strong>{formatBytes(documentHealth.quota.usedBytes)} / {formatBytes(documentHealth.quota.limitBytes)}</strong></article><article><span>Reconciliation</span><strong data-status={documentHealth.worker.lastReconciliationAt ? "ready" : "unavailable"}>{documentHealth.worker.lastReconciliationAt ? "complete" : "waiting"}</strong></article><article><span>Scanner recovery</span><strong data-status={documentHealth.scanRecovery.failed || documentHealth.scanRecovery.purgePending ? "unavailable" : "ready"}>{documentHealth.scanRecovery.retrying} retrying · {documentHealth.scanRecovery.failed} failed</strong></article><article><span>Recovery purge</span><strong>{documentHealth.scanRecovery.purgePending} pending</strong></article></div></> : <p className="member-message" role={healthError ? "alert" : "status"}>{healthError || "Checking document protection…"}</p>}
    </section>

    <section>
      <div className="setting-heading"><h3>Instance administrators</h3><p>Administrators can manage every user, household, section, and item in this Orbit instance.</p></div>
      <div className="admin-list">{users.map((user) => {
        const self = user.id === session.user.id;
        const viewerIsPrimary = users.some((candidate) => candidate.id === session.user.id && candidate.isPrimaryAdministrator);
        const transferable = viewerIsPrimary && !self && user.isInstanceAdmin && !user.disabledAt;
        /* Protected actions are absent rather than deceptively disabled
           (#263): nothing here may disable, demote or delete the primary
           administrator or the viewer's own account. Authority moves first,
           by explicit transfer, and only the primary sees that action. */
        return <article key={user.id}><span className="member-avatar">{initials(user.displayName)}</span><span><strong>{user.displayName}</strong><small>{user.email}{self ? " · You" : ""}{user.disabledAt ? " · Account disabled" : ""}</small></span><b>{user.disabledAt ? "Disabled" : user.isPrimaryAdministrator ? "Primary administrator" : user.isInstanceAdmin ? "Administrator" : "User"}</b><span className="admin-user-actions">{user.isPrimaryAdministrator
          ? <small className="admin-primary-note">Authority must be transferred before this account can be changed.</small>
          : <>
              {!self && !user.disabledAt && <button type="button" disabled={busyUserId !== null} onClick={() => void updateAdministrator(user)}>{busyUserId === user.id ? "Saving…" : user.isInstanceAdmin ? "Remove admin" : "Make admin"}</button>}
              {!self && <button type="button" disabled={busyUserId !== null} onClick={() => void updateAccountStatus(user)}>{busyUserId === user.id ? "Saving…" : user.disabledAt ? "Enable account" : "Disable account"}</button>}
            </>}{transferable && <button type="button" disabled={busyUserId !== null} onClick={() => void transferPrimary(user)}>{busyUserId === user.id ? "Saving…" : "Make primary"}</button>}</span></article>;
      })}</div>
      {message && <p className="member-message" role="status" aria-live="polite">{message}</p>}
    </section>
  </div>;
}

function JobList({ title, empty, jobs, busy, onAction }: { title: string; empty: string; jobs: Array<{ id: string; status: DeliveryStatus | DocumentJobStatus; attempts: number; lastErrorCode: string | null; updatedAt: string; nextAttemptAt?: string; channel?: string; kind?: string }>; busy: string | null; onAction: (id: string, action: JobAction, status: DeliveryStatus | DocumentJobStatus) => void }) {
  return <div className="admin-job-group"><h4>{title}</h4>{jobs.length ? <ul className="admin-job-list">{jobs.map((job) => { const isDelivery = Boolean(job.channel); const busyKey = `${isDelivery ? "deliveries" : "document-jobs"}:${job.id}`; const canRetry = isDelivery ? ["failed", "cancelled"].includes(job.status) : job.status === "failed"; const canDiscard = isDelivery ? ["pending", "retry", "failed"].includes(job.status) : job.status === "failed"; return <li key={job.id}><span><strong>{job.channel ?? job.kind} · {job.status}</strong><small>{job.attempts} attempt{job.attempts === 1 ? "" : "s"} · {formatDate(job.updatedAt)}{job.nextAttemptAt ? ` · next ${formatDate(job.nextAttemptAt)}` : ""}{job.lastErrorCode ? ` · ${job.lastErrorCode}` : ""}</small></span>{(canRetry || canDiscard) && <span className="admin-job-actions">{canRetry && <button type="button" disabled={busy !== null} onClick={() => onAction(job.id, "retry", job.status)}>{busy === busyKey ? "Working…" : "Retry"}</button>}{canDiscard && <button type="button" disabled={busy !== null} onClick={() => onAction(job.id, "discard", job.status)}>Discard</button>}</span>}</li>; })}</ul> : <p className="member-message">{empty}</p>}</div>;
}
