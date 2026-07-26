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

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export function AdminManager({ session }: AdminManagerProps) {
  const [users, setUsers] = useState<InstanceUser[]>([]);
  const [message, setMessage] = useState("");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

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
