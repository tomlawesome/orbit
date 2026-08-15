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

export type WorkspaceFailureCategory =
  | "legacy_storage_cleanup"
  | "auth_not_configured"
  | "session"
  | "workspace"
  | "network"
  | "schema"
  | "startup_unavailable";

export const STARTUP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
export const WORKSPACE_STARTUP_MESSAGE = "Orbit is starting. Please wait while the service becomes ready.";

const WORKSPACE_FAILURE_MESSAGES: Record<WorkspaceFailureCategory, string> = {
  legacy_storage_cleanup: "Orbit could not clear private browser data safely. Close other Orbit tabs and try again.",
  auth_not_configured: "Orbit sign-in is not configured. Ask your administrator to configure authentication, then try again.",
  session: "Orbit could not confirm your session. Check your connection and try again.",
  workspace: "Orbit could not load your private workspace safely. Check your connection and try again.",
  network: "Orbit could not connect safely. Check your connection and try again.",
  schema: "Orbit received an invalid response. Check your connection and try again.",
  startup_unavailable: "Orbit is temporarily unavailable. Ask your administrator to check the service, then try again.",
};

/**
 * Whether a command's response may still be applied to local state (#388).
 *
 * A command's response carries the whole canonical workspace, so applying a
 * stale one overwrites everything the reader has done since — including
 * keystrokes typed while the request was in flight. Three things can make a
 * response stale, and only the first was previously checked:
 *
 *   - the session ended, or the workspace was re-initialised (generation)
 *   - a NEWER command has since been sent, whose own response will carry the
 *     newer truth; applying this older one would undo it
 *
 * Last write wins by send order, which is the order the server applied them.
 */
export function canApplyCanonicalState(state: {
  generation: number;
  latestGeneration: number;
  sequence: number;
  latestSequence: number;
  sessionMatches: boolean;
}): boolean {
  return state.sessionMatches
    && state.generation === state.latestGeneration
    && state.sequence === state.latestSequence;
}

export function getWorkspaceFailureMessage(category: WorkspaceFailureCategory): string {
  return WORKSPACE_FAILURE_MESSAGES[category];
}

export class WorkspaceInitializationError extends Error {
  constructor(public readonly category: WorkspaceFailureCategory) {
    super(getWorkspaceFailureMessage(category));
    this.name = "WorkspaceInitializationError";
  }
}

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

type PublicReadinessStatus = "ready" | "degraded";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new WorkspaceInitializationError("schema");
  }
}

function isOneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function isWorkspaceSession(value: unknown): value is WorkspaceSession {
  if (!isRecord(value) || value.authenticated !== true || typeof value.csrfToken !== "string" || value.csrfToken.length === 0 || !isRecord(value.user)) {
    return false;
  }
  const user = value.user;
  return typeof user.id === "string"
    && typeof user.email === "string"
    && typeof user.displayName === "string"
    && (typeof user.avatarUrl === "string" || user.avatarUrl === null)
    && typeof user.isInstanceAdmin === "boolean"
    && isOneOf(user.themeMode, ["system", "light", "dark"])
    && typeof user.themeId === "string"
    && isOneOf(user.textSize, ["standard", "comfortable", "large", "extra-large"])
    && isOneOf(user.urgencyPalette, ["classic", "themed"])
    && typeof user.emailNotifications === "boolean"
    && typeof user.pushNotifications === "boolean";
}

export async function fetchPublicReadiness(signal?: AbortSignal): Promise<PublicReadinessStatus> {
  let response: Response;
  try {
    response = await fetch("/api/health", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      signal,
    });
  } catch {
    throw new WorkspaceInitializationError("network");
  }
  const payload = await readResponseJson(response);
  if (response.status === 200 && isRecord(payload) && payload.status === "ready") return "ready";
  if (response.status === 503 && isRecord(payload) && payload.status === "degraded") return "degraded";
  throw new WorkspaceInitializationError("schema");
}

async function readResponseErrorCode(response: Response): Promise<string | undefined> {
  const payload = await readResponseJson(response);
  if (!isRecord(payload) || !isRecord(payload.error) || typeof payload.error.code !== "string") return undefined;
  return payload.error.code;
}

export async function fetchSession(signal?: AbortSignal): Promise<WorkspaceSession | null> {
  let response: Response;
  try {
    response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", signal });
  } catch {
    throw new WorkspaceInitializationError("network");
  }
  if (response.status === 401) return null;
  if (!response.ok) {
    const code = await readResponseErrorCode(response);
    if (code === "auth_not_configured") throw new WorkspaceInitializationError("auth_not_configured");
    throw new WorkspaceInitializationError("session");
  }
  const payload = await readResponseJson(response);
  if (!isWorkspaceSession(payload)) throw new WorkspaceInitializationError("schema");
  return payload;
}

export async function fetchWorkspace(signal?: AbortSignal): Promise<WorkspaceState> {
  let response: Response;
  try {
    response = await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store", signal });
  } catch {
    throw new WorkspaceInitializationError("network");
  }
  if (!response.ok) {
    throw new WorkspaceInitializationError(response.status === 401 ? "session" : "workspace");
  }
  const payload = await readResponseJson(response);
  if (!isRecord(payload) || !("workspace" in payload)) throw new WorkspaceInitializationError("schema");
  try {
    return workspaceSchema.parse(payload.workspace);
  } catch {
    throw new WorkspaceInitializationError("schema");
  }
}

export async function waitForStartupReadiness(
  check: () => Promise<PublicReadinessStatus>,
  wait: (delayMs: number) => Promise<void>,
): Promise<void> {
  for (let retry = 0; ; retry += 1) {
    const readiness = await check();
    if (readiness === "ready") return;
    if (readiness !== "degraded") throw new WorkspaceInitializationError("schema");
    if (retry >= STARTUP_RETRY_DELAYS_MS.length) {
      throw new WorkspaceInitializationError("startup_unavailable");
    }
    await wait(STARTUP_RETRY_DELAYS_MS[retry]);
  }
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
  /* Bumped per command, so a response that has been overtaken by a newer
     command is not applied over it (#388). */
  const commandSequenceRef = useRef(0);
  const startupRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [initializationAttempt, setInitializationAttempt] = useState(0);

  const retryInitialization = useCallback(() => {
    setInitializationAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const emptyWorkspace = createEmptyWorkspace();

    if (startupRetryTimerRef.current !== null) {
      clearTimeout(startupRetryTimerRef.current);
      startupRetryTimerRef.current = null;
    }
    operationGenerationRef.current += 1;
    sessionRef.current = null;

    const waitForRetry = (delayMs: number): Promise<void> => new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cancel = () => {
        if (timer !== null) clearTimeout(timer);
        if (startupRetryTimerRef.current === timer) startupRetryTimerRef.current = null;
        reject(new Error("Startup retry cancelled"));
      };
      timer = setTimeout(() => {
        startupRetryTimerRef.current = null;
        controller.signal.removeEventListener("abort", cancel);
        resolve();
      }, delayMs);
      startupRetryTimerRef.current = timer;
      if (controller.signal.aborted) {
        cancel();
      } else {
        controller.signal.addEventListener("abort", cancel, { once: true });
      }
    });

    async function initialize() {
      await Promise.resolve();
      if (cancelled) return;
      setSession(null);
      confirmedWorkspaceRef.current = emptyWorkspace;
      setWorkspace(emptyWorkspace);
      setSyncStatus("loading");
      setSyncMessage("");
      try {
        await waitForStartupReadiness(
          async () => {
            const readiness = await fetchPublicReadiness(controller.signal);
            if (!cancelled && readiness === "degraded") setSyncMessage(WORKSPACE_STARTUP_MESSAGE);
            return readiness;
          },
          waitForRetry,
        );
        if (cancelled) return;
        setSyncMessage("");
        try {
          await purgeLegacyWorkspaceCache();
        } catch {
          throw new WorkspaceInitializationError("legacy_storage_cleanup");
        }
        const activeSession = await fetchSession(controller.signal);
        if (cancelled) return;
        if (!activeSession) {
          confirmedWorkspaceRef.current = emptyWorkspace;
          setWorkspace(emptyWorkspace);
          setSyncStatus("signed-out");
          return;
        }
        const canonical = await fetchWorkspace(controller.signal);
        if (cancelled) return;
        sessionRef.current = activeSession;
        setSession(activeSession);
        confirmedWorkspaceRef.current = canonical;
        setWorkspace(canonical);
        setSyncStatus("synced");
        setSyncMessage("");
      } catch (error) {
        if (cancelled) return;
        sessionRef.current = null;
        setSession(null);
        confirmedWorkspaceRef.current = emptyWorkspace;
        setWorkspace(emptyWorkspace);
        setSyncStatus("error");
        setSyncMessage(error instanceof WorkspaceInitializationError
          ? error.message
          : getWorkspaceFailureMessage("network"));
      }
    }
    void initialize();
    return () => {
      cancelled = true;
      controller.abort();
      if (startupRetryTimerRef.current !== null) {
        clearTimeout(startupRetryTimerRef.current);
        startupRetryTimerRef.current = null;
      }
    };
  }, [initializationAttempt]);

  const runWorkspaceCommand = useCallback(async (command: WorkspaceCommand): Promise<WorkspaceState> => {
    const activeSession = sessionRef.current;
    if (!activeSession) {
      throw new WorkspaceCommandError("session_required", "A valid session is required");
    }
    const operationGeneration = operationGenerationRef.current;
    const commandSequence = (commandSequenceRef.current += 1);
    const isCurrentOperation = () => canApplyCanonicalState({
      generation: operationGeneration,
      latestGeneration: operationGenerationRef.current,
      sequence: commandSequence,
      latestSequence: commandSequenceRef.current,
      sessionMatches: sessionRef.current === activeSession,
    });
    try {
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": activeSession.csrfToken },
        body: JSON.stringify(command),
      });
      const payload = await response.json() as { workspace?: unknown; error?: { code?: string } };
      if (!response.ok) {
        throw new WorkspaceCommandError(
          payload.error?.code ?? "workspace_command_failed",
          "Orbit could not save this change. Check your connection and try again.",
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

  return { workspace, dispatch, executeCommand, refreshWorkspace, retryInitialization, signOut, session, syncStatus, syncMessage };
}
