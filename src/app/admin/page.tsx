"use client";

import Link from "next/link";
import { AdminManager } from "@/components/admin-manager";
import { MaintenanceBanner } from "@/components/maintenance-banner";
import { usePersistedThemePreference } from "@/components/appearance-preference";
import { useWorkspace } from "@/lib/preview-workspace";

/**
 * Administration, as a page rather than a tab inside a settings dialog.
 *
 * Authority is enforced by the administration APIs themselves, every one of
 * which requires an instance administrator. This route does not re-implement
 * that check as a security boundary; it explains the refusal so a legitimate
 * user who simply is not an administrator sees a reason rather than a dead end.
 */
export default function AdminPage() {
  const { session, syncStatus, syncMessage } = useWorkspace();
  const themePreference = usePersistedThemePreference(session?.user);
  const appearanceAttributes = {
    "data-theme": themePreference.theme,
    "data-text-size": themePreference.textSize,
  };

  if (!session) {
    return (
      <main className="admin-page" {...appearanceAttributes}>
        <div className="admin-page-inner">
          <p className="admin-page-status" role="status">
            {syncStatus === "error" ? syncMessage ?? "Orbit could not confirm your session." : "Checking your session…"}
          </p>
          <Link className="admin-page-back" href="/">Return to Orbit</Link>
        </div>
      </main>
    );
  }

  if (!session.user.isInstanceAdmin) {
    return (
      <main className="admin-page" {...appearanceAttributes}>
        <div className="admin-page-inner">
          <header className="admin-page-header">
            <p>Administration</p>
            <h1 className="page-heading">You do not have administrator privileges</h1>
          </header>
          <p className="admin-page-refusal">
            Administration is limited to instance administrators. Your household
            settings and documents are unaffected, and no action is needed.
          </p>
          <Link className="admin-page-back" href="/">Return to Orbit</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="admin-page" {...appearanceAttributes}>
      <MaintenanceBanner session={session} />
      <div className="admin-page-inner">
        {/* This heading must not contain, or be contained by, any heading
            rendered inside AdminManager. Playwright matches accessible names by
            substring, so an overlap makes every existing administration
            assertion ambiguous. Guarded by admin-page-headings.test.mjs. */}
        <header className="admin-page-header">
          <p>Administration</p>
          <h1 className="page-heading">Manage this Orbit instance</h1>
        </header>
        <AdminManager session={session} />
        <Link className="admin-page-back" href="/">Return to Orbit</Link>
      </div>
    </main>
  );
}
