"use client";

import Link from "next/link";
import { AdminManager, adminSectionHeadingIds } from "@/components/admin-manager";
import { usePersistedThemePreference } from "@/components/appearance-preference";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";
import { useWorkspace } from "@/lib/preview-workspace";

/**
 * Administration, as a page rather than a tab inside a settings dialog.
 *
 * Authority is enforced by the administration APIs themselves, every one of
 * which requires an instance administrator. This route does not re-implement
 * that check as a security boundary; it explains the refusal so a legitimate
 * user who simply is not an administrator sees a reason rather than a dead end.
 *
 * The surface is design/family/admin.html — "the observatory": the same v19
 * star-chart sky as everywhere else, instrumented with a slowly precessing
 * chart grid, a rail of the sections AdminManager renders and one glass pane
 * holding them. Styles live in src/app/screens.css.
 */

/**
 * Mirrors dashboard.tsx's `focusSettingsSection`: the browser already moves
 * focus to a `tabindex="-1"` fragment target, but administration's rail does
 * it explicitly so both screens behave identically and the behaviour does not
 * depend on the engine's fragment-navigation rules.
 */
function focusAdminSection(headingId: string) {
  window.setTimeout(() => {
    const heading = document.getElementById(headingId);
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "start" });
  }, 0);
}

/** The rail's labels, paired with the headings AdminManager renders. */
const adminSections = [
  { label: "Operations", target: adminSectionHeadingIds.operations },
  { label: "Audit history", target: adminSectionHeadingIds.audit },
  { label: "Documents", target: adminSectionHeadingIds.documents },
  { label: "Administrators", target: adminSectionHeadingIds.administrators },
] as const;

/**
 * The chart grid from design/family/admin.html, drawn behind the page. It is
 * decorative and announced to nobody; `data-motion` is the same switch the
 * shell's drawers use, so the precession stops the moment the reader has asked
 * for reduced motion (screens.css also stills it via the media query, which
 * covers the frames before this component mounts).
 */
function ObservatoryChart({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <div className="admin-chart" aria-hidden="true">
      <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
        <g className="admin-chart-grid" data-motion={reducedMotion ? "reduced" : "full"}>
          <circle cx="800" cy="500" r="330" />
          <circle cx="800" cy="500" r="470" />
          <circle cx="800" cy="500" r="610" />
          <line x1="800" y1="30" x2="800" y2="970" />
          <line x1="330" y1="500" x2="1270" y2="500" />
          <line x1="468" y1="168" x2="1132" y2="832" />
          <line x1="1132" y1="168" x2="468" y2="832" />
        </g>
      </svg>
    </div>
  );
}

export default function AdminPage() {
  const { session, syncStatus, syncMessage } = useWorkspace();
  const themePreference = usePersistedThemePreference(session?.user);
  const reducedMotion = usePrefersReducedMotion();
  const appearanceAttributes = {
    "data-theme": themePreference.theme,
    "data-text-size": themePreference.textSize,
  };

  if (!session) {
    return (
      <main className="admin-page" {...appearanceAttributes}>
        <ObservatoryChart reducedMotion={reducedMotion} />
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
        <ObservatoryChart reducedMotion={reducedMotion} />
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
      <ObservatoryChart reducedMotion={reducedMotion} />
      <div className="admin-page-inner">
        {/* This heading must not contain, or be contained by, any heading
            rendered inside AdminManager. Playwright matches accessible names by
            substring, so an overlap makes every existing administration
            assertion ambiguous. */}
        <header className="admin-page-header">
          <p>Administration</p>
          <h1 className="page-heading">Manage this Orbit instance</h1>
        </header>
        <div className="admin-layout">
          <aside className="admin-section-nav-column">
            {/* In-page anchors onto AdminManager's own headings, each of which
                carries tabIndex={-1} and labels its section — the same shape
                as the settings rail. */}
            <nav className="admin-section-nav" aria-label="Administration sections">
              {adminSections.map((section) => (
                <a
                  key={section.target}
                  href={`#${section.target}`}
                  onClick={() => focusAdminSection(section.target)}
                >
                  {section.label}
                </a>
              ))}
            </nav>
          </aside>
          <AdminManager session={session} />
        </div>
        <Link className="admin-page-back" href="/">Return to Orbit</Link>
      </div>
    </main>
  );
}
