export const LEGACY_WORKSPACE_DATABASE = "orbit-workspace";

const PRIVATE_STORAGE_ERROR = "Private browser data could not be cleared";

/**
 * Removes the IndexedDB database used by pre-v1 preview builds for private
 * workspace snapshots and queued commands.
 */
export async function purgeLegacyWorkspaceCache(): Promise<void> {
  if (typeof indexedDB === "undefined") return;

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LEGACY_WORKSPACE_DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error(PRIVATE_STORAGE_ERROR));
    request.onblocked = () => reject(new Error(PRIVATE_STORAGE_ERROR));
  });
}
