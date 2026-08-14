"use client";

import { ShellDrawer } from "@/components/shell-drawer";
import type { WorkspaceSyncStatus } from "@/lib/preview-workspace";

/**
 * CON-7 (left) — system status. The old topbar carried a `.sync-state`
 * pill; v19 turns that pill into the drawer's handle, so the word on the
 * edge of the screen IS both the status and the way to read more about it.
 *
 * Deviation from the mockup, deliberately: the mockup renders nothing on
 * the left when the deployment is healthy. Sync state is live and
 * consequential in the real app — "Saving", "Loading" and "Review" all
 * mean something a household needs to see — so the handle is always
 * present and simply says what the state is.
 *
 * Colour lives in the dot, never in the word. `--degraded` and `--warm`
 * on the panel surfaces of the atlas and dawn packs land around 4.0:1,
 * which clears the 3:1 bar for a non-text indicator but not the 4.5:1 bar
 * for text, so every word here is `--ink` / `--ink-mid`.
 */

export interface StatusDrawerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  syncStatus: WorkspaceSyncStatus;
  syncMessage: string | null;
  householdName: string;
  memberCount: number;
  timezone: string;
}

/** Word-for-word the states the old topbar pill announced (issue #327 era). */
const statusWord: Record<WorkspaceSyncStatus, string> = {
  synced: "Synced",
  "signed-out": "Synced",
  loading: "Loading",
  saving: "Saving",
  error: "Review",
};

const statusDetail: Record<WorkspaceSyncStatus, string> = {
  synced: "Every change is saved to this Orbit.",
  "signed-out": "Every change is saved to this Orbit.",
  loading: "Reading your workspace from this Orbit.",
  saving: "Writing your latest change to this Orbit.",
  error: "The last change could not be confirmed.",
};

export function StatusDrawer({
  open,
  onOpenChange,
  syncStatus,
  syncMessage,
  householdName,
  memberCount,
  timezone,
}: StatusDrawerProps) {
  const word = statusWord[syncStatus];
  return (
    <ShellDrawer
      id="statusdrawer"
      side="left"
      label="System status"
      handleLabel={`System status — ${word}`}
      handleClassName={`sync-state sync-${syncStatus}`}
      open={open}
      onOpenChange={onOpenChange}
      handle={
        <>
          <i aria-hidden="true" />
          <span>{word}</span>
        </>
      }
    >
      <h2 className="drawer-title">System status</h2>

      <h3 className="drawer-heading">Workspace</h3>
      <p className={`svc svc-${syncStatus}`}>
        <i aria-hidden="true" />
        <b>{word}</b>
        <small>{syncMessage ?? statusDetail[syncStatus]}</small>
      </p>

      <h3 className="drawer-heading">This household</h3>
      <p className="svc">
        <i aria-hidden="true" />
        <b>{householdName}</b>
        <small>{memberCount} {memberCount === 1 ? "member" : "members"} · dates in {timezone.replace("_", " ")}</small>
      </p>

      <h3 className="drawer-heading">Full diagnostics</h3>
      <p className="drawer-note">
        Container logs on the machine running this Orbit, or the launcher&apos;s repair flow.
      </p>
    </ShellDrawer>
  );
}
