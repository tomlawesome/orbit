"use client";

import { useEffect, useState } from "react";
import type { WorkspaceSession } from "@/lib/preview-workspace";

interface InstanceUser {
  id: string;
  displayName: string;
  email: string;
  isInstanceAdmin: boolean;
}

interface AdminManagerProps {
  session: WorkspaceSession;
}

interface DocumentHealth {
  overall: "healthy" | "degraded";
  encryption: { status: "ready" | "unavailable"; keyId: string | null };
  storage: { status: "ready" | "unavailable" };
  scanner: { status: "ready" | "disabled" | "unavailable"; mode: "required" | "disabled" | "unknown" };
  quota: { usedBytes: number; limitBytes: number };
  worker: {
    started: boolean;
    running: boolean;
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    lastErrorCode: string | null;
    lastReconciliationAt: string | null;
  };
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

export function AdminManager({ session }: AdminManagerProps) {
  const [users, setUsers] = useState<InstanceUser[]>([]);
  const [message, setMessage] = useState("");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [documentHealth, setDocumentHealth] = useState<DocumentHealth | null>(null);
  const [healthError, setHealthError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/users", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { users?: InstanceUser[]; error?: { message?: string } };
        if (!response.ok || !payload.users) throw new Error(payload.error?.message || "Users could not be loaded");
        if (!cancelled) setUsers(payload.users);
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Users could not be loaded");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/documents/health", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { health?: DocumentHealth };
        if (!response.ok || !payload.health) throw new Error("Document health could not be loaded");
        if (!cancelled) setDocumentHealth(payload.health);
      })
      .catch(() => {
        if (!cancelled) setHealthError("Document health could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function updateAdministrator(user: InstanceUser) {
    setBusyUserId(user.id);
    setMessage("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ userId: user.id, administrator: !user.isInstanceAdmin }),
      });
      const payload = await response.json() as { users?: InstanceUser[]; error?: { message?: string } };
      if (!response.ok || !payload.users) {
        throw new Error(payload.error?.message || "Administrator access could not be updated");
      }
      setUsers(payload.users);
      setMessage(`${user.displayName} ${user.isInstanceAdmin ? "is no longer" : "is now"} an Orbit administrator.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Administrator access could not be updated");
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div className="settings-content">
      <section>
        <div className="setting-heading">
          <h3>Document protection</h3>
          <p>Encryption, storage, malware scanning and retention-worker status.</p>
        </div>
        {documentHealth ? (
          <>
            {documentHealth.scanner.status === "disabled" && (
              <p className="admin-health-warning" role="alert">
                Malware scanning is disabled. New files are accepted without a virus scan.
              </p>
            )}
            {documentHealth.overall === "degraded" && documentHealth.scanner.status !== "disabled" && (
              <p className="admin-health-warning" role="alert">
                Document protection needs attention. Uploads fail closed while required protection is unavailable.
              </p>
            )}
            <div className="admin-health-grid">
              <article><span>Encryption key</span><strong data-status={documentHealth.encryption.status}>{documentHealth.encryption.status}</strong></article>
              <article><span>Encrypted storage</span><strong data-status={documentHealth.storage.status}>{documentHealth.storage.status}</strong></article>
              <article><span>Malware scanner</span><strong data-status={documentHealth.scanner.status}>{documentHealth.scanner.status}</strong></article>
              <article><span>Retention worker</span><strong data-status={documentHealth.worker.started ? "ready" : "unavailable"}>{documentHealth.worker.started ? "ready" : "unavailable"}</strong></article>
              <article><span>Storage quota</span><strong>{formatBytes(documentHealth.quota.usedBytes)} / {formatBytes(documentHealth.quota.limitBytes)}</strong></article>
              <article><span>Reconciliation</span><strong data-status={documentHealth.worker.lastReconciliationAt ? "ready" : "unavailable"}>{documentHealth.worker.lastReconciliationAt ? "complete" : "waiting"}</strong></article>
            </div>
          </>
        ) : <p className="member-message" role={healthError ? "alert" : "status"}>{healthError || "Checking document protection…"}</p>}
      </section>
      <section>
        <div className="setting-heading">
          <h3>Instance administrators</h3>
          <p>Administrators can manage every user, household, section, and item in this Orbit instance.</p>
        </div>
        <div className="admin-list">
          {users.map((user) => (
            <article key={user.id}>
              <span className="member-avatar">{initials(user.displayName)}</span>
              <span>
                <strong>{user.displayName}</strong>
                <small>{user.email}{user.id === session.user.id ? " · You" : ""}</small>
              </span>
              <b>{user.isInstanceAdmin ? "Administrator" : "User"}</b>
              <button
                type="button"
                disabled={busyUserId !== null || (user.id === session.user.id && user.isInstanceAdmin)}
                title={user.id === session.user.id && user.isInstanceAdmin
                  ? "Another administrator must remove your access"
                  : undefined}
                onClick={() => updateAdministrator(user)}
              >
                {busyUserId === user.id
                  ? "Saving…"
                  : user.id === session.user.id && user.isInstanceAdmin
                    ? "Current admin"
                  : user.isInstanceAdmin
                    ? "Remove admin"
                    : "Make admin"}
              </button>
            </article>
          ))}
        </div>
        {message && <p className="member-message" role="status">{message}</p>}
      </section>
    </div>
  );
}
