"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createEmptyWorkspace,
  reduceWorkspace,
  workspaceSchema,
  type WorkspaceCommand,
  type WorkspaceState,
} from "@/lib/workspace";
import {
  enqueueWorkspaceCommand,
  readQueuedWorkspaceCommands,
  readWorkspaceSnapshot,
  removeQueuedWorkspaceCommand,
  writeWorkspaceSnapshot,
} from "@/lib/workspace-cache";

export type WorkspaceSyncStatus = "loading" | "signed-out" | "synced" | "saving" | "offline" | "error";

export interface WorkspaceSession {
  authenticated: true;
  csrfToken: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    isInstanceAdmin: boolean;
    themeMode: "system" | "light" | "dark";
    themeId: string;
    textSize: "standard" | "comfortable" | "large" | "extra-large";
    urgencyPalette: "classic" | "themed";
    emailNotifications: boolean;
    pushNotifications: boolean;
  };
}

/** A safe, actionable failure returned by the workspace command endpoint. */
export class WorkspaceCommandError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceCommandError";
  }
}

async function fetchSession(): Promise<WorkspaceSession | null> {
  const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("The session could not be loaded");
  return response.json() as Promise<WorkspaceSession>;
}

async function fetchWorkspace(): Promise<WorkspaceState> {
  const response = await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("The workspace could not be loaded");
  const payload = await response.json() as { workspace: unknown };
  return workspaceSchema.parse(payload.workspace);
}

/**
 * Loads authenticated workspace state and keeps its offline cache isolated by
 * user. Signed-out visitors never receive a cached or server workspace.
 */
export function useWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => createEmptyWorkspace());
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [syncStatus, setSyncStatus] = useState<WorkspaceSyncStatus>("loading");
  const [syncMessage, setSyncMessage] = useState("");
  const sessionRef = useRef<WorkspaceSession | null>(null);
  const flushingRef = useRef(false);

  const flushQueue = useCallback(async (activeSession: WorkspaceSession) => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      const queued = await readQueuedWorkspaceCommands(activeSession.user.id);
      for (const entry of queued) {
        const response = await fetch("/api/workspace/commands", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": activeSession.csrfToken,
          },
          body: JSON.stringify(entry.command),
        });
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500) {
            await removeQueuedWorkspaceCommand(entry.id);
            const canonical = await fetchWorkspace();
            setWorkspace(canonical);
            await writeWorkspaceSnapshot(activeSession.user.id, canonical);
            setSyncStatus("error");
            setSyncMessage(response.status === 409
              ? "A newer version was found; Orbit refreshed this workspace."
              : "One queued change could not be saved.");
            continue;
          }
          throw new Error("The queued command could not be synchronized");
        }
        const payload = await response.json() as { workspace: unknown };
        const canonical = workspaceSchema.parse(payload.workspace);
        await removeQueuedWorkspaceCommand(entry.id);
        setWorkspace(canonical);
        await writeWorkspaceSnapshot(activeSession.user.id, canonical);
      }
      setSyncStatus("synced");
      setSyncMessage("");
    } catch {
      setSyncStatus("offline");
      setSyncMessage("Changes are safely queued on this device.");
    } finally {
      flushingRef.current = false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
        const activeSession = await fetchSession();
        if (cancelled) return;
        sessionRef.current = activeSession;
        setSession(activeSession);
        if (!activeSession) {
          setWorkspace(createEmptyWorkspace());
          setSyncStatus("signed-out");
          return;
        }
        const cached = await readWorkspaceSnapshot(activeSession.user.id).catch(() => undefined);
        if (!cancelled && cached) setWorkspace(cached);
        try {
          const canonical = await fetchWorkspace();
          if (cancelled) return;
          setWorkspace(canonical);
          await writeWorkspaceSnapshot(activeSession.user.id, canonical);
          setSyncStatus("synced");
          void flushQueue(activeSession);
        } catch {
          if (cancelled) return;
          if (cached) {
            setSyncStatus("offline");
            setSyncMessage("Showing your saved workspace while Orbit reconnects.");
            return;
          }
          throw new Error("No authenticated workspace is available");
        }
      } catch {
        if (cancelled) return;
        sessionRef.current = null;
        setSession(null);
        setWorkspace(createEmptyWorkspace());
        setSyncStatus("signed-out");
        setSyncMessage("");
      }
    }
    void initialize();
    const synchronize = async () => {
      const activeSession = sessionRef.current;
      if (!activeSession) return;
      await flushQueue(activeSession);
      try {
        const canonical = await fetchWorkspace();
        if (cancelled) return;
        setWorkspace(canonical);
        await writeWorkspaceSnapshot(activeSession.user.id, canonical);
        setSyncStatus("synced");
        setSyncMessage("");
      } catch {
        if (cancelled) return;
        setSyncStatus("offline");
        setSyncMessage("Showing your saved workspace while Orbit reconnects.");
      }
    };
    window.addEventListener("online", synchronize);
    return () => {
      cancelled = true;
      window.removeEventListener("online", synchronize);
    };
  }, [flushQueue]);

  const dispatch = useCallback((command: WorkspaceCommand) => {
    setWorkspace((current) => {
      const next = reduceWorkspace(current, command);
      const activeSession = sessionRef.current;
      if (activeSession) void writeWorkspaceSnapshot(activeSession.user.id, next);
      return next;
    });

    const activeSession = sessionRef.current;
    if (!activeSession) return;
    setSyncStatus("saving");
    void enqueueWorkspaceCommand(activeSession.user.id, command)
      .then(() => flushQueue(activeSession))
      .catch(() => {
        setSyncStatus("offline");
        setSyncMessage("Changes are safely queued on this device.");
      });
  }, [flushQueue]);

  const executeCommand = useCallback(async (command: WorkspaceCommand): Promise<WorkspaceState> => {
    const activeSession = sessionRef.current;
    if (!activeSession) throw new Error("A valid session is required");
    const response = await fetch("/api/workspace/commands", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": activeSession.csrfToken },
      body: JSON.stringify(command),
    });
    const payload = await response.json() as { workspace?: unknown; error?: { code?: string; message?: string } };
    if (!response.ok) {
      throw new WorkspaceCommandError(
        payload.error?.code ?? "workspace_command_failed",
        payload.error?.message ?? "Orbit could not save this change",
      );
    }
    const canonical = workspaceSchema.parse(payload.workspace);
    setWorkspace(canonical);
    await writeWorkspaceSnapshot(activeSession.user.id, canonical);
    setSyncStatus("synced");
    setSyncMessage("");
    return canonical;
  }, []);

  return { workspace, dispatch, executeCommand, session, syncStatus, syncMessage };
}
