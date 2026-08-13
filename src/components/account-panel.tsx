"use client";

import { useCallback, useRef, useState } from "react";
import { FocusDialog } from "@/components/focus-dialog";
import { householdInitials } from "@/components/dashboard-utils";
import { Icon, type IconName } from "@/components/icons";
import { themePackInfo, themePacks, type ThemePack } from "@/lib/preferences";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

/**
 * The v19 account orb and its slide-out panel (design/v19/home.html).
 *
 * v19 deletes the sidebar and the topbar: the only persistent chrome is
 * this one floating orb, and everything the old rails carried now lives
 * behind it. The ratified mockup's panel shows identity, a short nav,
 * theme swatches and sign out — it does NOT show the household switcher
 * or the per-section counts, because the mockup was drawn for a single
 * demo household. That is a gap in the mockup, not a decision to drop
 * working features, so this panel also carries:
 *
 *  - "Your things": every visible section with its live item count, plus
 *    the archive — the old sidebar's section rail;
 *  - "Households": the switcher and "Add a household" — the old sidebar's
 *    household picker;
 *  - Notifications with its unread count — the old topbar bell.
 *
 * The panel is modal (scrim, focus trap, Escape, focus returned to the
 * orb) via the shared FocusDialog, so it behaves identically on a phone,
 * where it becomes a full-height sheet, and on a desktop.
 *
 * Every action that leaves the panel first moves focus back to the orb
 * *synchronously*, before React unmounts the panel. That is what lets the
 * surface being opened (the notification centre, the item detail) capture
 * a real, still-connected return-focus target instead of `document.body`.
 */

export interface AccountPanelHousehold {
  id: string;
  name: string;
  itemCount: number;
}

export interface AccountPanelSection {
  id: string;
  name: string;
  icon: IconName;
  itemCount: number;
}

export interface AccountPanelProps {
  displayName: string;
  initials: string;
  isInstanceAdmin: boolean;
  households: AccountPanelHousehold[];
  activeHouseholdId: string;
  householdName: string;
  /** "owner" when this member can manage the household, otherwise "member". */
  householdRole: string;
  sections: AccountPanelSection[];
  /** The selected list: a section id, "all" (Due next) or "archive". */
  activeSection: string;
  dueNextCount: number;
  archiveCount: number;
  unreadNotificationCount: number;
  theme: ThemePack;
  signOutBusy: boolean;
  onSelectHousehold(householdId: string): void;
  onAddHousehold(): void;
  onSelectSection(sectionId: string): void;
  onSelectDueNext(): void;
  onSelectArchive(): void;
  onNotifications(): void;
  onInbox(): void;
  onSettings(): void;
  onAdministration(): void;
  onThemeChange(pack: ThemePack): void;
  onSignOut(): void;
}

const PANEL_ID = "account-panel";

export function AccountPanel({
  displayName,
  initials,
  isInstanceAdmin,
  households,
  activeHouseholdId,
  householdName,
  householdRole,
  sections,
  activeSection,
  dueNextCount,
  archiveCount,
  unreadNotificationCount,
  theme,
  signOutBusy,
  onSelectHousehold,
  onAddHousehold,
  onSelectSection,
  onSelectDueNext,
  onSelectArchive,
  onNotifications,
  onInbox,
  onSettings,
  onAdministration,
  onThemeChange,
  onSignOut,
}: AccountPanelProps) {
  const [open, setOpen] = useState(false);
  const orbRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  const close = useCallback(() => setOpen(false), []);

  /**
   * Runs a panel action and shuts the panel. The orb is focused first and
   * synchronously, so the next surface to mount inherits a live return
   * target — see the component note above.
   */
  const runAndClose = useCallback((action: () => void) => {
    orbRef.current?.focus();
    setOpen(false);
    action();
  }, []);

  return (
    <>
      <button
        ref={orbRef}
        type="button"
        className="orb"
        data-settings-return-focus
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label="Open account menu"
        aria-describedby={unreadNotificationCount > 0 ? "orb-unread-hint" : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">{initials}</span>
        {unreadNotificationCount > 0 && <i className="orb-unread" aria-hidden="true" />}
      </button>
      {unreadNotificationCount > 0 && (
        <span id="orb-unread-hint" className="visually-hidden">
          {unreadNotificationCount} unread {unreadNotificationCount === 1 ? "notification" : "notifications"}
        </span>
      )}

      {open && (
        <>
          <button className="scrim shell-scrim shell-scrim-account" type="button" aria-label="Close account menu" onClick={close} />
          <FocusDialog
            id={PANEL_ID}
            className="account"
            data-motion={reducedMotion ? "reduced" : "full"}
            aria-label="Account and menu"
            onDismiss={close}
            returnFocusFallback="button.orb"
          >
            <div className="account-who">
              <div>
                <h2 className="account-name" tabIndex={-1} data-dialog-initial-focus>{displayName}</h2>
                <span>{householdName} · {householdRole}</span>
              </div>
              <button type="button" className="account-close" aria-label="Close account menu" onClick={close}>×</button>
            </div>

            <nav className="account-block" aria-label="Orbit navigation">
              <h3 className="account-block-title">Go to</h3>
              <button
                type="button"
                className={`account-item${activeSection === "all" ? " active" : ""}`}
                aria-current={activeSection === "all" ? "page" : undefined}
                onClick={() => runAndClose(onSelectDueNext)}
              >
                <Icon name="calendar" /><span>Due next</span><b>{dueNextCount}</b>
              </button>
              <button type="button" className="account-item" onClick={() => runAndClose(onNotifications)}>
                <Icon name="bell" /><span>Notifications</span>
                {unreadNotificationCount > 0 && <b>{unreadNotificationCount}</b>}
              </button>
              <button type="button" className="account-item" onClick={() => runAndClose(onInbox)}>
                <Icon name="archive" /><span>Inbox</span>
              </button>
              <button type="button" className="account-item" onClick={() => runAndClose(onSettings)}>
                <Icon name="settings" /><span>Settings</span>
              </button>
              {isInstanceAdmin && (
                <button type="button" className="account-item" onClick={() => runAndClose(onAdministration)}>
                  <Icon name="more" /><span>Administration</span>
                </button>
              )}
            </nav>

            <nav className="account-block" aria-label="Your things">
              <h3 className="account-block-title">Your things</h3>
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={`account-item${activeSection === section.id ? " active" : ""}`}
                  aria-current={activeSection === section.id ? "page" : undefined}
                  onClick={() => runAndClose(() => onSelectSection(section.id))}
                >
                  <Icon name={section.icon} /><span>{section.name}</span><b>{section.itemCount}</b>
                </button>
              ))}
              <button
                type="button"
                className={`account-item${activeSection === "archive" ? " active" : ""}`}
                aria-current={activeSection === "archive" ? "page" : undefined}
                onClick={() => runAndClose(onSelectArchive)}
              >
                <Icon name="archive" /><span>Archive</span><b>{archiveCount}</b>
              </button>
            </nav>

            <div className="account-block">
              <h3 className="account-block-title" id="account-households-title">Households</h3>
              <ul className="account-households" aria-labelledby="account-households-title">
                {households.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`account-household${entry.id === activeHouseholdId ? " active" : ""}`}
                      aria-current={entry.id === activeHouseholdId ? "true" : undefined}
                      onClick={() => runAndClose(() => onSelectHousehold(entry.id))}
                    >
                      <span className="account-household-mark" aria-hidden="true">{householdInitials(entry.name)}</span>
                      <span className="account-household-label">
                        <strong>{entry.name}</strong>
                        <small>{entry.itemCount} {entry.itemCount === 1 ? "item" : "items"}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="account-add-household" onClick={() => runAndClose(onAddHousehold)}>
                <Icon name="plus" /> Add a household
              </button>
            </div>

            <div className="account-block account-themes" role="group" aria-label="Theme">
              <h3 className="account-block-title">Theme</h3>
              <div className="account-swatches">
                {themePacks.map((pack) => (
                  <button
                    key={pack}
                    type="button"
                    className="account-swatch"
                    aria-pressed={theme === pack}
                    aria-label={themePackInfo[pack].name}
                    title={themePackInfo[pack].name}
                    style={{ background: themePackInfo[pack].swatches[0] }}
                    onClick={() => onThemeChange(pack)}
                  >
                    <i aria-hidden="true" style={{ background: themePackInfo[pack].swatches[1] }} />
                  </button>
                ))}
              </div>
            </div>

            <button type="button" className="account-signout" disabled={signOutBusy} onClick={onSignOut}>
              {signOutBusy ? "Signing out…" : "Sign out"}
            </button>
          </FocusDialog>
        </>
      )}
    </>
  );
}
