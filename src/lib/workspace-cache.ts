"use client";

import { workspaceCommandSchema, workspaceSchema, type WorkspaceCommand, type WorkspaceState } from "@/lib/workspace";

const DATABASE_NAME = "orbit-workspace";
const DATABASE_VERSION = 1;
const SNAPSHOT_STORE = "snapshots";
const QUEUE_STORE = "commands";

interface QueuedCommand {
  id?: number;
  userId: string;
  command: WorkspaceCommand;
  createdAt: string;
}

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE);
      }
      if (!database.objectStoreNames.contains(QUEUE_STORE)) {
        database.createObjectStore(QUEUE_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB operation failed"));
  });
}

export async function readWorkspaceSnapshot(userId: string): Promise<WorkspaceState | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const database = await openCache();
  try {
    const value = await requestResult(database.transaction(SNAPSHOT_STORE).objectStore(SNAPSHOT_STORE).get(`user:${userId}`));
    const parsed = workspaceSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } finally {
    database.close();
  }
}

export async function writeWorkspaceSnapshot(userId: string, workspace: WorkspaceState): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await openCache();
  try {
    await requestResult(database.transaction(SNAPSHOT_STORE, "readwrite").objectStore(SNAPSHOT_STORE).put(
      workspaceSchema.parse(workspace),
      `user:${userId}`,
    ));
  } finally {
    database.close();
  }
}

export async function enqueueWorkspaceCommand(userId: string, command: WorkspaceCommand): Promise<number> {
  const database = await openCache();
  try {
    const id = await requestResult(database.transaction(QUEUE_STORE, "readwrite").objectStore(QUEUE_STORE).add({
      userId,
      command: workspaceCommandSchema.parse(command),
      createdAt: new Date().toISOString(),
    } satisfies QueuedCommand));
    return Number(id);
  } finally {
    database.close();
  }
}

export async function readQueuedWorkspaceCommands(
  userId: string,
): Promise<Array<Required<Pick<QueuedCommand, "id">> & QueuedCommand>> {
  if (typeof indexedDB === "undefined") return [];
  const database = await openCache();
  try {
    const rows = await requestResult(database.transaction(QUEUE_STORE).objectStore(QUEUE_STORE).getAll()) as QueuedCommand[];
    return rows.flatMap((row) => {
      const parsed = workspaceCommandSchema.safeParse(row.command);
      return row.id != null && row.userId === userId && parsed.success
        ? [{ id: row.id, userId: row.userId, command: parsed.data, createdAt: row.createdAt }]
        : [];
    });
  } finally {
    database.close();
  }
}

export async function removeQueuedWorkspaceCommand(id: number): Promise<void> {
  const database = await openCache();
  try {
    await requestResult(database.transaction(QUEUE_STORE, "readwrite").objectStore(QUEUE_STORE).delete(id));
  } finally {
    database.close();
  }
}
