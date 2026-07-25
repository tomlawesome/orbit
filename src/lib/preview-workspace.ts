"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sectionPreferenceSchema } from "@/lib/preferences";
import {
  createDemoWorkspace,
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

const WORKSPACE_STORAGE_KEY = "homesee:workspace:v1";
const LEGACY_SECTION_STORAGE_KEY = "homesee:sections:v1";

export type WorkspaceSyncStatus = "loading" | "preview" | "synced" | "saving" | "offline" | "error";

export interface WorkspaceSession {
  authenticated: true;
  csrfToken: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    themeMode: "system" | "light" | "dark";
    themeId: string;
  };
}

function parseStoredPreview(): WorkspaceState {
  try {
    const current = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    const parsed = current ? workspaceSchema.safeParse(JSON.parse(current)) : undefined;
    if (parsed?.success) return parsed.data;

    const legacySections = window.localStorage.getItem(LEGACY_SECTION_STORAGE_KEY);
    const legacy = legacySections ? sectionPreferenceSchema.safeParse(JSON.parse(legacySections)) : undefined;
    if (legacy?.success) return createDemoWorkspace(legacy.data);
  } catch {
    // Invalid legacy browser data safely falls back to the demonstration workspace.
  }
  return createDemoWorkspace();
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
 * Provides a preview workspace without infrastructure, then transparently
 * upgrades to authenticated API persistence when a valid session is present.
 */
export function useWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => createDemoWorkspace());
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [syncStatus, setSyncStatus] = useState<WorkspaceSyncStatus>("loading");
  const [syncMessage, setSyncMessage] = useState("");
  const sessionRef = useRef<WorkspaceSession | null>(null);
  const flushingRef = useRef(false);

  const flushQueue = useCallback(async (activeSession: WorkspaceSession) => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      const queued = await readQueuedWorkspaceCommands();
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
            await writeWorkspaceSnapshot(canonical);
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
        await writeWorkspaceSnapshot(canonical);
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
      const cached = await readWorkspaceSnapshot().catch(() => undefined);
      if (!cancelled && cached) setWorkspace(cached);
      try {
        const activeSession = await fetchSession();
        if (cancelled) return;
        sessionRef.current = activeSession;
        setSession(activeSession);
        if (!activeSession) {
          const preview = cached ?? parseStoredPreview();
          setWorkspace(preview);
          await writeWorkspaceSnapshot(preview).catch(() => undefined);
          setSyncStatus("preview");
          return;
        }
        const canonical = await fetchWorkspace();
        if (cancelled) return;
        setWorkspace(canonical);
        await writeWorkspaceSnapshot(canonical);
        setSyncStatus("synced");
        void flushQueue(activeSession);
      } catch {
        if (cancelled) return;
        setWorkspace(cached ?? parseStoredPreview());
        setSyncStatus(cached ? "offline" : "preview");
        setSyncMessage(cached ? "Showing the latest saved device snapshot." : "");
      }
    }
    void initialize();
    const synchronize = () => {
      if (sessionRef.current) void flushQueue(sessionRef.current);
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
      void writeWorkspaceSnapshot(next);
      if (!sessionRef.current) {
        window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });

    const activeSession = sessionRef.current;
    if (!activeSession) return;
    setSyncStatus("saving");
    void enqueueWorkspaceCommand(command)
      .then(() => flushQueue(activeSession))
      .catch(() => {
        setSyncStatus("offline");
        setSyncMessage("Changes are safely queued on this device.");
      });
  }, [flushQueue]);

  return { workspace, dispatch, session, syncStatus, syncMessage };
}
