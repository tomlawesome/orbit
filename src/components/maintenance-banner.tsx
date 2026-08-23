"use client";

import { useEffect, useState } from "react";
import type { WorkspaceSession } from "@/lib/preview-workspace";
import { bannerLines, type MaintenanceStateView } from "@/lib/maintenance-view";
import { MAINTENANCE_CHANGED_EVENT } from "./maintenance-control";

/* The administrator's maintenance banner (#524, Fable's ruling 1). It
   is the one signal that stops an administrator forgetting the instance
   is closed to users, so it is deliberately not dismissible: it clears
   when maintenance actually ends and not before. */

export function MaintenanceBanner({ session }: { session: WorkspaceSession }) {
  const [state, setState] = useState<MaintenanceStateView | null>(null);
  const [readAt, setReadAt] = useState<Date>(() => new Date(0));
  const [reloadToken, setReloadToken] = useState(0);
  const isAdministrator = session.user.isInstanceAdmin;

  useEffect(() => {
    if (!isAdministrator) return;
    let cancelled = false;
    fetch("/api/admin/maintenance", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as { maintenance?: MaintenanceStateView };
        if (cancelled || !payload.maintenance) return;
        setState(payload.maintenance);
        setReadAt(new Date());
      })
      .catch(() => {
        /* The banner is a reminder, not a control: a failed read leaves
           it hidden rather than putting an error on every screen. */
      });
    return () => { cancelled = true; };
  }, [isAdministrator, reloadToken]);

  /* The control dispatches this after any accepted mutation, so ending
     maintenance clears the banner without a reload. */
  useEffect(() => {
    const refresh = () => setReloadToken((token) => token + 1);
    window.addEventListener(MAINTENANCE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(MAINTENANCE_CHANGED_EVENT, refresh);
  }, []);

  if (!isAdministrator || !state) return null;
  const lines = bannerLines(state, readAt);
  if (!lines) return null;

  return <p className="maintenance-banner" role="status">
    <strong>{lines.headline}</strong>
    {lines.expected && <span>{lines.expected}</span>}
    <a href="/admin#maintenance">Maintenance control</a>
  </p>;
}
