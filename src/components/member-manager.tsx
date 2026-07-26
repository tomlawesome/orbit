"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { WorkspaceSession } from "@/lib/preview-workspace";

interface Member {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: "owner" | "member";
}

interface Candidate {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

interface MemberManagerProps {
  householdId: string;
  session: WorkspaceSession;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

export function MemberManager({ householdId, session }: MemberManagerProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/households/${householdId}/members`, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Members could not be loaded");
        return response.json() as Promise<{ members: Member[]; candidates: Candidate[] }>;
      })
      .then((payload) => {
        if (!cancelled) {
          setMembers(payload.members);
          setCandidates(payload.candidates);
        }
      })
      .catch(() => {
        if (!cancelled) setMessage("Members could not be loaded right now.");
      });
    return () => {
      cancelled = true;
    };
  }, [householdId, session]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = event.currentTarget;
    const userId = String(new FormData(form).get("userId") ?? "");
    const selected = candidates.find((candidate) => candidate.id === userId);
    try {
      const response = await fetch(`/api/households/${householdId}/members`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ userId }),
      });
      const payload = await response.json() as { members?: Member[]; candidates?: Candidate[]; error?: { message?: string } };
      if (!response.ok || !payload.members) throw new Error(payload.error?.message || "Member could not be added");
      setMembers(payload.members);
      setCandidates(payload.candidates ?? []);
      setMessage(`${selected?.displayName ?? "That user"} can now access this household.`);
      form.reset();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Member could not be added");
    } finally {
      setBusy(false);
    }
  }

  async function remove(member: Member) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/households/${householdId}/members`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ userId: member.id }),
      });
      const payload = await response.json() as { members?: Member[]; candidates?: Candidate[]; error?: { message?: string } };
      if (!response.ok || !payload.members) throw new Error(payload.error?.message || "Member could not be removed");
      setMembers(payload.members);
      setCandidates(payload.candidates ?? []);
      setMessage(`${member.displayName} was removed from this household.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Member could not be removed");
    } finally {
      setBusy(false);
    }
  }

  async function transferOwnership(member: Member) {
    if (!window.confirm(`Transfer ownership of this household to ${member.displayName}? You will remain a member.`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/households/${householdId}/members`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ userId: member.id }),
      });
      const payload = await response.json() as { members?: Member[]; candidates?: Candidate[]; error?: { message?: string } };
      if (!response.ok || !payload.members) throw new Error(payload.error?.message || "Ownership could not be transferred");
      setMembers(payload.members);
      setCandidates(payload.candidates ?? []);
      setMessage(`${member.displayName} is now the household owner.`);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ownership could not be transferred");
    } finally {
      setBusy(false);
    }
  }

  const currentUser = members.find((member) => member.id === session.user.id);
  const isOwner = session.user.isInstanceAdmin || currentUser?.role === "owner";

  return (
    <div className="settings-content">
      <section>
        <div className="setting-heading">
          <h3>Household access</h3>
          <p>Household owners and Orbit administrators can add people who already have an account.</p>
        </div>
        <div className="member-list">
          {members.map((member) => (
            <article key={member.id}>
              <span className="member-avatar">{initials(member.displayName)}</span>
              <span><strong>{member.displayName}</strong><small>{member.role === "owner" ? "Household owner" : "Household member"}</small></span>
              <b>{member.role}</b>
              {isOwner && member.role !== "owner" && (
                <span className="member-actions">
                  <button type="button" disabled={busy} onClick={() => transferOwnership(member)}>Make owner</button>
                  <button type="button" disabled={busy} onClick={() => remove(member)}>Remove</button>
                </span>
              )}
            </article>
          ))}
        </div>
      </section>
      {isOwner && (
        <section>
          <div className="setting-heading">
            <h3>Add an existing user</h3>
            <p>Select a registered Orbit user by name.</p>
          </div>
          <form className="member-form" onSubmit={submit}>
            <label className="field">
              <span>Registered user</span>
              <select name="userId" required defaultValue="">
                <option value="" disabled>{candidates.length ? "Choose a person…" : "No other registered users"}</option>
                {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}
              </select>
            </label>
            <button type="submit" disabled={busy || !candidates.length}>{busy ? "Adding…" : "Add member"}</button>
          </form>
          {message && <p className="member-message" role="status">{message}</p>}
        </section>
      )}
    </div>
  );
}
