"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createEmptyWorkspace,
  reduceWorkspace,
  workspaceSchema,
  type WorkspaceCommand,
  type WorkspaceState,
} from "@/lib/workspace";
import { purgeLegacyWorkspaceCache } from "@/lib/private-browser-storage";

export type WorkspaceSyncStatus = "loading" | "signed-out" | "synced" | "saving" | "error";

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
 * Loads authenticated workspace state from the server without retaining
 * private workspace content in durable browser storage.
 */
export function useWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => createEmptyWorkspace());
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [syncStatus, setSyncStatus] = useState<WorkspaceSyncStatus>("loading");
  const [syncMessage, setSyncMessage] = useState("");
  const sessionRef = useRef<WorkspaceSession | null>(null);
  const confirmedWorkspaceRef = useRef<WorkspaceState>(createEmptyWorkspace());
  const commandTailRef = useRef<Promise<void>>(Promise.resolve());
  const operationGenerationRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
        await purgeLegacyWorkspaceCache();
        const activeSession = await fetchSession();
        if (cancelled) return;
        sessionRef.current = activeSession;
        setSession(activeSession);
        if (!activeSession) {
          const emptyWorkspace = createEmptyWorkspace();
          confirmedWorkspaceRef.current = emptyWorkspace;
          setWorkspace(emptyWorkspace);
          setSyncStatus("signed-out");
          return;
        }
        const canonical = await fetchWorkspace();
        if (cancelled) return;
        confirmedWorkspaceRef.current = canonical;
        setWorkspace(canonical);
        setSyncStatus("synced");
        setSyncMessage("");
      } catch {
        if (cancelled) return;
        sessionRef.current = null;
        setSession(null);
        const emptyWorkspace = createEmptyWorkspace();
        confirmedWorkspaceRef.current = emptyWorkspace;
        setWorkspace(emptyWorkspace);
        setSyncStatus("error");
        setSyncMessage("Orbit could not load your private workspace safely. Check your connection, close other Orbit tabs, and try again.");
      }
    }
    void initialize();
    return () => {
      cancelled = true;
    };
  }, []);

  const runWorkspaceCommand = useCallback(async (command: WorkspaceCommand): Promise<WorkspaceState> => {
    const activeSession = sessionRef.current;
    if (!activeSession) {
      throw new WorkspaceCommandError("session_required", "A valid session is required");
    }
    const operationGeneration = operationGenerationRef.current;
    const isCurrentOperation = () => (
      operationGenerationRef.current === operationGeneration
      && sessionRef.current === activeSession
    );
    try {
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
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
      if (isCurrentOperation()) {
        confirmedWorkspaceRef.current = canonical;
        setWorkspace(canonical);
        setSyncStatus("synced");
        setSyncMessage("");
      }
      return canonical;
    } catch (error) {
      const commandError = error instanceof WorkspaceCommandError
        ? error
        : new WorkspaceCommandError(
          "workspace_command_failed",
          "Orbit could not save this change. Check your connection and try again.",
        );
      if (isCurrentOperation()) {
        let canonical: WorkspaceState | undefined;
        try {
          canonical = await fetchWorkspace();
        } catch {
          // The last confirmed state remains the safe fallback.
        }
        if (isCurrentOperation()) {
          if (canonical) confirmedWorkspaceRef.current = canonical;
          setWorkspace(canonical ?? confirmedWorkspaceRef.current);
          setSyncStatus("error");
          setSyncMessage(commandError.message);
        }
      }
      throw commandError;
    }
  }, []);

  const executeCommand = useCallback((command: WorkspaceCommand): Promise<WorkspaceState> => {
    if (!sessionRef.current) {
      return Promise.reject(new WorkspaceCommandError("session_required", "A valid session is required"));
    }
    setSyncStatus("saving");
    setSyncMessage("");
    const result = commandTailRef.current.then(() => runWorkspaceCommand(command));
    commandTailRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, [runWorkspaceCommand]);

  const dispatch = useCallback((command: WorkspaceCommand) => {
    if (!sessionRef.current) return;
    setWorkspace((current) => reduceWorkspace(current, command));
    void executeCommand(command).catch(() => undefined);
  }, [executeCommand]);

  const refreshWorkspace = useCallback(async (): Promise<void> => {
    const activeSession = sessionRef.current;
    if (!activeSession) return;
    const canonical = await fetchWorkspace();
    confirmedWorkspaceRef.current = canonical;
    setWorkspace(canonical);
    setSyncStatus("synced");
    setSyncMessage("");
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    const activeSession = sessionRef.current;
    if (!activeSession) return;
    operationGenerationRef.current += 1;
    sessionRef.current = null;
    setSyncStatus("saving");
    setSyncMessage("");
    try {
      await purgeLegacyWorkspaceCache();
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Accept": "application/json",
          "X-CSRF-Token": activeSession.csrfToken,
        },
      });
      if (!response.ok) throw new Error("The session could not be ended");
      const payload = await response.json() as { redirectTo?: string };
      setSession(null);
      const emptyWorkspace = createEmptyWorkspace();
      confirmedWorkspaceRef.current = emptyWorkspace;
      setWorkspace(emptyWorkspace);
      setSyncStatus("signed-out");
      setSyncMessage("");
      window.location.assign(payload.redirectTo || "/");
    } catch {
      sessionRef.current = activeSession;
      try {
        const canonical = await fetchWorkspace();
        confirmedWorkspaceRef.current = canonical;
        setWorkspace(canonical);
      } catch {
        setWorkspace(confirmedWorkspaceRef.current);
      }
      setSyncStatus("error");
      setSyncMessage("Orbit could not sign you out safely. Close other Orbit tabs and try again.");
      throw new Error("Orbit could not sign you out safely");
    }
  }, []);

  return { workspace, dispatch, executeCommand, refreshWorkspace, signOut, session, syncStatus, syncMessage };
}
