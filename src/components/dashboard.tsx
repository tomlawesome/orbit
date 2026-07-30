"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AdminManager } from "@/components/admin-manager";
import { FirstRunWizard, type HouseholdSetupInput } from "@/components/first-run-wizard";
import { FocusDialog } from "@/components/focus-dialog";
import { HouseholdOnboarding, type HouseholdInput } from "@/components/household-onboarding";
import { HouseholdSettings, type HouseholdSettingsInput } from "@/components/household-settings";
import { HouseholdRecovery, HouseholdRecoveryPrompt } from "@/components/household-recovery";
import { Icon } from "@/components/icons";
import { ItemDetail, type CompletionInput } from "@/components/item-detail";
import { ItemEditor } from "@/components/item-editor";
import { NotificationCenter } from "@/components/notification-center";
import { MemberManager } from "@/components/member-manager";
import { PortableArchiveManager } from "@/components/portable-archive-manager";
import { ImapInbox } from "@/components/imap-inbox";
import { calendarDateInTimeZone, dueCopy as dashboardDueCopy, formatCost, formatHeadingDate, formatLongDate, householdInitials, PREFERENCE_EVENT, storePreference, THEME_STORAGE_KEY } from "@/components/dashboard-utils";
import {
  daysUntil,
  getDueBand,
  getDueState,
  sortByDueDate,
  type HomeItem,
  type HouseholdSection,
  type SectionAccent,
  type SectionIcon,
} from "@/lib/domain";
import { householdNotifications, type HouseholdNotification } from "@/lib/notifications";
import {
  colourways,
  textSizes,
  themeModes,
  themePreferenceSchema,
  urgencyPalettes,
  type ThemePreference,
} from "@/lib/preferences";
import { useWorkspace } from "@/lib/preview-workspace";
import { activeHousehold, cloneSections, createEmptyWorkspace, createHousehold, type ItemActivity } from "@/lib/workspace";

const DEFAULT_THEME: ThemePreference = {
  mode: "system",
  colourway: "after-dark",
  textSize: "comfortable",
  urgencyPalette: "themed",
  emailNotifications: true,
  pushNotifications: true,
};
const DEFAULT_THEME_JSON = JSON.stringify(DEFAULT_THEME);
const NOTICE_DURATION_MS = 10_000;

type SettingsView = "appearance" | "data" | "inbox" | "household" | "sections" | "members" | "recovery" | "administration";
type ItemFilter = "all" | "attention" | "unscheduled";
type Notice = { message: string; undoItem?: HomeItem };

const customSectionAccents: SectionAccent[] = ["coral", "sage", "blue", "sand", "plum"];
const customSectionIcons: SectionIcon[] = ["home", "vehicle", "device", "service", "calendar"];
const textSizeLabels = {
  standard: { name: "Standard", detail: "Original compact sizing" },
  comfortable: { name: "Comfortable", detail: "Larger and easier to scan" },
  large: { name: "Large", detail: "Maximum in-app text size" },
  "extra-large": { name: "Extra large", detail: "Maximum readability without browser zoom" },
} as const;
const urgencyPaletteLabels = {
  classic: { name: "Traditional", detail: "Red, orange, yellow and green" },
  themed: { name: "Theme matched", detail: "Urgency colours adapt to your colourway" },
} as const;

function AuthenticationGate({ loading, error }: { loading: boolean; error?: string }) {
  return (
    <main className="authentication-gate">
      <section>
        <Image src="/orbit-mark.svg" alt="" width={112} height={112} priority />
        <p className="eyebrow">Everything in your orbit, on track</p>
        <h1>{loading ? "Checking access…" : error ? "Orbit could not open safely." : "Sign in to Orbit."}</h1>
        <p role={error ? "alert" : undefined}>
          {loading
            ? "Orbit is confirming your session."
            : error ?? "Your household information is private and is only available after authentication."}
        </p>
        {!loading && !error && <a className="wizard-primary" href="/api/auth/login">Sign in securely <Icon name="chevron" /></a>}
      </section>
    </main>
  );
}

function useLocalStorageValue(key: string, fallback: string): string {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === key) onStoreChange();
    };
    const handlePreference = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) onStoreChange();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(PREFERENCE_EVENT, handlePreference);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(PREFERENCE_EVENT, handlePreference);
    };
  }, [key]);
  const getSnapshot = useCallback(() => window.localStorage.getItem(key) ?? fallback, [fallback, key]);
  const getServerSnapshot = useCallback(() => fallback, [fallback]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

type AuthenticatedWorkspace = Omit<ReturnType<typeof useWorkspace>, "session">;

/** Keeps signed-out/loading state outside the authenticated dashboard tree. */
export function Dashboard() {
  const { session, ...workspaceState } = useWorkspace();
  if (!session) {
    return (
      <AuthenticationGate
        loading={workspaceState.syncStatus === "loading"}
        error={workspaceState.syncStatus === "error" ? workspaceState.syncMessage : undefined}
      />
    );
  }
  return <AuthenticatedDashboard session={session} workspaceState={workspaceState} />;
}

function AuthenticatedDashboard({ session, workspaceState }: { session: NonNullable<ReturnType<typeof useWorkspace>["session"]>; workspaceState: AuthenticatedWorkspace }) {
  const { workspace, dispatch, executeCommand, refreshWorkspace, signOut, syncStatus, syncMessage } = workspaceState;
  const hasActiveHousehold = workspace.households.length > 0;
  const household = activeHousehold(workspace) ?? createEmptyWorkspace().households[0];
  // Legacy placeholder households may already exist from releases that created
  // one during a workspace read. Give recovery choices precedence over that
  // unfinished setup, but never create another household from this view.
  const householdChoiceRequired = workspace.householdLanding === "choose"
    || (workspace.recoverableHouseholds.length > 0 && (!hasActiveHousehold || !household.onboardingComplete));
  const sections = household.sections;
  const today = calendarDateInTimeZone(household.timezone);
  const [activeSection, setActiveSection] = useState<string | "all">("all");
  const [settingsView, setSettingsView] = useState<SettingsView | null>(null);
  const [query, setQuery] = useState("");
  const [itemFilter, setItemFilter] = useState<ItemFilter>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [householdMenuOpen, setHouseholdMenuOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [itemEditorOpen, setItemEditorOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<HomeItem | undefined>();
  const [detailItemId, setDetailItemId] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const storedTheme = useLocalStorageValue(THEME_STORAGE_KEY, DEFAULT_THEME_JSON);
  const themePreference = useMemo(() => {
    try {
      const parsed = themePreferenceSchema.safeParse(JSON.parse(storedTheme));
      return parsed.success ? parsed.data : DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  }, [storedTheme]);
  const themeMode = themePreference.mode;
  const colourway = themePreference.colourway;
  const textSize = themePreference.textSize;
  const urgencyPalette = themePreference.urgencyPalette;
  const emailNotifications = themePreference.emailNotifications;
  const pushNotifications = themePreference.pushNotifications;
  const activeItems = household.items.filter((item) => item.status === "active");
  const inactiveItems = household.items.filter((item) => ["archived", "cancelled"].includes(item.status));
  const archiveMode = activeSection === "archive";
  const listedItems = archiveMode ? inactiveItems : activeItems;
  const notifications = householdNotifications(household, today);
  const unreadNotificationCount = notifications.filter((notification) => !notification.read).length;
  const detailItem = household.items.find((item) => item.id === detailItemId);

  const visibleItems = sortByDueDate(listedItems.filter((item) => {
    const matchesSection = archiveMode || activeSection === "all" || item.sectionId === activeSection;
    const haystack = `${item.title} ${item.provider ?? ""} ${item.subtype ?? ""} ${item.reference ?? ""}`.toLowerCase();
    const matchesSearch = haystack.includes(query.trim().toLowerCase());
    const dueState = getDueState(item.dueDate, today);
    const matchesFilter = archiveMode || itemFilter === "all"
      || (itemFilter === "attention" && ["overdue", "due-soon"].includes(dueState))
      || (itemFilter === "unscheduled" && dueState === "unscheduled");
    return matchesSection && matchesSearch && matchesFilter;
  }), today);

  const sortedItems = sortByDueDate(activeItems, today);
  const urgentItems = sortedItems.filter((item) => ["overdue", "due-soon"].includes(getDueState(item.dueDate, today)));
  const mostUrgent = urgentItems[0] ?? sortedItems.find((item) => item.dueDate);
  const urgentCount = urgentItems.length;
  const dueSoonCount = activeItems.filter((item) => getDueState(item.dueDate, today) === "due-soon").length;
  const onTrackCount = activeItems.filter((item) => getDueState(item.dueDate, today) === "upcoming").length;
  const currentSection = sections.find((section) => section.id === activeSection);
  const urgentSection = mostUrgent ? sections.find((section) => section.id === mostUrgent.sectionId) : undefined;
  const focusDays = mostUrgent?.dueDate ? daysUntil(mostUrgent.dueDate, today) : undefined;

  useEffect(() => {
    if (!session) return;
    storePreference(THEME_STORAGE_KEY, {
      mode: session.user.themeMode,
      colourway: session.user.themeId,
      textSize: session.user.textSize,
      urgencyPalette: session.user.urgencyPalette,
      emailNotifications: session.user.emailNotifications,
      pushNotifications: session.user.pushNotifications,
    });
  }, [session]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("open") !== "inbox") return;
    const timer = window.setTimeout(() => setSettingsView("inbox"), 0);
    return () => window.clearTimeout(timer);
  }, []);

  function updateAppearance(changes: Partial<ThemePreference>) {
    const preference = { ...themePreference, ...changes };
    storePreference(THEME_STORAGE_KEY, preference);
    if (session) {
      void fetch("/api/preferences", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify(preference),
      });
    }
  }

  function updateSections(nextSections: HouseholdSection[]) {
    dispatch({ type: "sections.replace", householdId: household.id, sections: nextSections });
    if (activeSection !== "all" && !nextSections.some((section) => section.id === activeSection && section.visible)) {
      setActiveSection("all");
    }
  }

  function addSection() {
    if (sections.length >= 12) return;
    const index = sections.length;
    updateSections([
      ...sections,
      {
        id: crypto.randomUUID(),
        name: "New section",
        icon: customSectionIcons[index % customSectionIcons.length],
        accent: customSectionAccents[index % customSectionAccents.length],
        visible: true,
      },
    ]);
  }

  function moveSection(sectionId: string, direction: -1 | 1) {
    const currentIndex = sections.findIndex((section) => section.id === sectionId);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= sections.length) return;
    const nextSections = [...sections];
    [nextSections[currentIndex], nextSections[targetIndex]] = [nextSections[targetIndex], nextSections[currentIndex]];
    updateSections(nextSections);
  }

  function cycleSectionAccent(sectionId: string) {
    updateSections(sections.map((section) => {
      if (section.id !== sectionId) return section;
      const currentIndex = customSectionAccents.indexOf(section.accent);
      return { ...section, accent: customSectionAccents[(currentIndex + 1) % customSectionAccents.length] };
    }));
  }

  function restoreDefaultSections() {
    const restored = cloneSections().map((section, index) => ({
      ...section,
      id: sections[index]?.id ?? crypto.randomUUID(),
    }));
    const retainedIds = new Set(restored.map((section) => section.id));
    const movedItems = household.items.filter((item) => !retainedIds.has(item.sectionId)).length;
    if (
      movedItems > 0
      && !window.confirm(
        `${movedItems} ${movedItems === 1 ? "item is" : "items are"} in additional sections. Restore the defaults and move ${movedItems === 1 ? "it" : "them"} to Home?`,
      )
    ) return;
    updateSections(restored);
  }

  function openNewItem() {
    setEditingItem(undefined);
    setDetailItemId(null);
    setItemEditorOpen(true);
  }

  function editItem(item: HomeItem) {
    setEditingItem(item);
    setDetailItemId(null);
    setItemEditorOpen(true);
  }

  function openItem(item: HomeItem) {
    setDetailItemId(item.id);
    setNotificationsOpen(false);
  }

  function activity(item: HomeItem, kind: ItemActivity["kind"], details: Partial<ItemActivity> = {}): ItemActivity {
    return {
      id: crypto.randomUUID(),
      itemId: item.id,
      kind,
      occurredAt: new Date().toISOString(),
      ...details,
    };
  }

  async function saveItem(item: HomeItem, document?: File) {
    const kind = editingItem ? "updated" : "created";
    const command = {
      type: "item.upsert",
      householdId: household.id,
      item,
      activity: activity(item, kind, { nextDate: item.dueDate }),
    } as const;
    // A document-assisted item uses the same reviewed approval contract as a
    // mailbox draft. The browser retains the original until this explicit
    // approval succeeds, then sends it through the secure document route.
    if (document && !editingItem) {
      const approvalResponse = await fetch("/api/reviewed-intake/approve", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({
          operationId: item.id,
          source: { kind: "direct_upload", expectedDocument: true },
          householdId: household.id,
          sectionId: item.sectionId,
          action: "create_separate",
          item,
          attachmentIds: [],
        }),
      });
      if (!approvalResponse.ok) {
        const payload = await approvalResponse.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
        throw new Error(payload?.error?.message ?? "The reviewed item could not be approved");
      }
      const approval = await approvalResponse.json() as { itemId?: string; attachmentState?: string };
      const approvedItemId = approval.itemId ?? item.id;
      // Refresh the canonical workspace before the secure upload. The item is
      // intentionally durable and reachable even when attachment storage fails.
      await refreshWorkspace();
      const response = await fetch(`/api/households/${household.id}/items/${approvedItemId}/documents`, {
          method: "POST", credentials: "same-origin",
          headers: {
            "X-CSRF-Token": session.csrfToken,
            "X-Orbit-Filename": encodeURIComponent(document.name),
            "X-Orbit-Review-Operation": item.id,
          },
          body: document,
        });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
        throw new Error(payload?.error?.message ?? "The document could not be attached");
      }
      await refreshWorkspace();
    } else await executeCommand(command);
    setItemEditorOpen(false);
    setNotice({ message: editingItem ? `${item.title} updated` : `${item.title} added` });
  }

  function archiveItem(item: HomeItem) {
    dispatch({
      type: "item.archive",
      householdId: household.id,
      itemId: item.id,
      expectedVersion: item.version ?? 1,
      activity: activity(item, "archived"),
    });
    setItemEditorOpen(false);
    setDetailItemId(null);
    setNotice({ message: `${item.title} archived`, undoItem: item });
  }

  function undoArchive(item: HomeItem) {
    dispatch({
      type: "item.status",
      householdId: household.id,
      itemId: item.id,
      expectedVersion: item.version ?? 1,
      status: "active",
      activity: activity(item, "restored"),
    });
    setNotice({ message: `${item.title} restored` });
  }

  function completeItem(item: HomeItem, input: CompletionInput) {
    const kind = item.scheduleKind === "service" ? "service_completed" : "renewal_completed";
    dispatch({
      type: "item.complete",
      householdId: household.id,
      itemId: item.id,
      expectedVersion: item.version ?? 1,
      ...input,
      activity: activity(item, kind, {
        effectiveDate: input.completedDate,
        previousDate: item.dueDate,
        nextDate: input.nextDate,
        costMinor: input.costMinor,
        notes: input.notes,
      }),
    });
    setNotice({ message: `${item.title} ${item.scheduleKind === "service" ? "service" : "renewal"} completed` });
  }

  function rescheduleItem(item: HomeItem, dueDate: string) {
    dispatch({
      type: "item.reschedule",
      householdId: household.id,
      itemId: item.id,
      expectedVersion: item.version ?? 1,
      dueDate,
      activity: activity(item, "rescheduled", { previousDate: item.dueDate, nextDate: dueDate }),
    });
    setNotice({ message: `${item.title} rescheduled` });
  }

  function snoozeItem(item: HomeItem, snoozedUntil: string) {
    dispatch({
      type: "item.snooze",
      householdId: household.id,
      itemId: item.id,
      expectedVersion: item.version ?? 1,
      snoozedUntil,
      activity: activity(item, "snoozed", { nextDate: snoozedUntil }),
    });
    setNotice({ message: `Reminders snoozed until ${formatLongDate(snoozedUntil)}` });
  }

  function setItemStatus(item: HomeItem, status: "active" | "cancelled") {
    dispatch({
      type: "item.status",
      householdId: household.id,
      itemId: item.id,
      expectedVersion: item.version ?? 1,
      status,
      activity: activity(item, status === "active" ? "restored" : "cancelled"),
    });
    if (status === "cancelled") setDetailItemId(null);
    setNotice({ message: status === "active" ? `${item.title} restored` : `${item.title} cancelled` });
  }

  function openNotification(notification: HouseholdNotification) {
    dispatch({ type: "notification.read", householdId: household.id, notificationId: notification.id });
    const item = household.items.find((entry) => entry.id === notification.itemId);
    if (item) openItem(item);
  }

  function selectHousehold(householdId: string) {
    dispatch({ type: "household.activate", householdId });
    setActiveSection("all");
    setQuery("");
    setItemFilter("all");
    setDetailItemId(null);
    setNotificationsOpen(false);
    setSettingsView(null);
    setHouseholdMenuOpen(false);
    setMenuOpen(false);
  }

  async function addHousehold(input: HouseholdInput) {
    await executeCommand({
      type: "household.create",
      household: createHousehold({ id: crypto.randomUUID(), ...input }),
    });
    setActiveSection("all");
    setOnboardingOpen(false);
    setHouseholdMenuOpen(false);
    setNotice({ message: `${input.name} is ready` });
  }

  function returnToHouseholdRecovery() {
    setOnboardingOpen(false);
    setNotice({ message: "That name belongs to a removed household. Restore it, permanently delete it if you are an instance administrator, or choose a different name." });
  }

  async function updateHousehold(input: HouseholdSettingsInput) {
    await executeCommand({ type: "household.update", householdId: household.id, ...input });
    setNotice({ message: `${input.name} was updated` });
  }

  async function handleSignOut() {
    setLogoutBusy(true);
    setNotice(null);
    try {
      await signOut();
    } catch {
      setLogoutBusy(false);
    }
  }

  function completeFirstRun(input: HouseholdSetupInput) {
    dispatch({
      type: "household.setup",
      householdId: household.id,
      ...input,
    });
    setNotice({ message: `${input.name} is ready` });
  }

  return (
    <div
      className="app-frame"
      data-theme={colourway}
      data-mode={themeMode}
      data-text-size={textSize}
      data-urgency-palette={urgencyPalette}
    >
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <span className="brand-mark"><Image src="/orbit-mark.svg" alt="" width={56} height={56} priority /></span>
          <span>Orbit</span>
        </div>
        <div className="household-control">
          <button className="household-picker" type="button" aria-expanded={householdMenuOpen} onClick={() => setHouseholdMenuOpen(!householdMenuOpen)}>
            <span className="household-avatar">{householdInitials(household.name)}</span>
            <span><strong>{household.name}</strong><small>{household.memberCount} {household.memberCount === 1 ? "member" : "members"}</small></span>
            <Icon name="chevron" />
          </button>
          {householdMenuOpen && (
            <div className="household-menu" role="menu">
              <p>Your households</p>
              {workspace.households.map((entry) => (
                <button type="button" role="menuitem" className={entry.id === household.id ? "active" : ""} key={entry.id} onClick={() => selectHousehold(entry.id)}>
                  <span>{householdInitials(entry.name)}</span>
                  <span><strong>{entry.name}</strong><small>{entry.items.filter((item) => item.status !== "archived").length} items</small></span>
                  <b>{entry.id === household.id ? "✓" : ""}</b>
                </button>
              ))}
              <button type="button" className="add-household" onClick={() => setOnboardingOpen(true)}><Icon name="plus" /> Add a household</button>
            </div>
          )}
        </div>
        <nav aria-label="Main navigation">
          <p className="nav-label">Overview</p>
          <button className={activeSection === "all" ? "nav-item active" : "nav-item"} onClick={() => { setActiveSection("all"); setMenuOpen(false); }}>
            <Icon name="calendar" /><span>Due next</span><b>{urgentCount}</b>
          </button>
          <p className="nav-label">Your things</p>
          {sections.filter((section) => section.visible).map((section) => (
            <button className={activeSection === section.id ? "nav-item active" : "nav-item"} key={section.id} onClick={() => { setActiveSection(section.id); setMenuOpen(false); }}>
              <Icon name={section.icon} /><span>{section.name}</span><b>{activeItems.filter((item) => item.sectionId === section.id).length}</b>
            </button>
          ))}
          <p className="nav-label nav-spaced">Manage</p>
          <button className="nav-item" onClick={() => { setNotificationsOpen(true); setMenuOpen(false); }}><Icon name="bell" /><span>Notifications</span>{unreadNotificationCount > 0 && <b>{unreadNotificationCount}</b>}</button>
          <button className={archiveMode ? "nav-item active" : "nav-item"} onClick={() => { setActiveSection("archive"); setItemFilter("all"); setMenuOpen(false); }}><Icon name="archive" /><span>Archive</span><b>{inactiveItems.length}</b></button>
          <button className="nav-item" onClick={() => { setSettingsView("appearance"); setMenuOpen(false); }}><Icon name="settings" /><span>Personalise</span></button>
        </nav>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <button className="mobile-menu" data-settings-return-focus aria-label="Open navigation" onClick={() => setMenuOpen(!menuOpen)}><span /><span /><span /></button>
          <label className="search"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${household.name.toLowerCase()}…`} /></label>
          <span className={`sync-state sync-${syncStatus}`} title={syncMessage || undefined}>
            <i />{syncStatus === "saving" ? "Saving" : syncStatus === "loading" ? "Loading" : syncStatus === "error" ? "Review" : "Synced"}
          </span>
          <button className="icon-button" aria-label={`Notifications${unreadNotificationCount ? `, ${unreadNotificationCount} unread` : ""}`} onClick={() => setNotificationsOpen(true)}><Icon name="bell" />{unreadNotificationCount > 0 && <i />}</button>
          <button className="topbar-profile" data-settings-return-focus onClick={() => setSettingsView("appearance")} aria-label="Open personalisation settings"><span className="profile-avatar">{householdInitials(session.user.displayName)}</span><strong>{session.user.displayName}</strong></button>
          <button className="add-button" onClick={openNewItem}><Icon name="plus" /> Add item</button>
        </header>

        {syncStatus === "error" && syncMessage && (
          <div className="sync-error-banner" role="alert">{syncMessage}</div>
        )}

        <section className="content">
          <div className="overview-grid">
            <article className="hero-panel">
              <div className="hero-copy">
                <p className="eyebrow">{archiveMode ? "Household history" : activeSection === "all" ? formatHeadingDate(today) : "Your things"}</p>
                <h1>{archiveMode ? <>Past, but<br />not <em>lost.</em></> : activeSection === "all" ? <>Everything in your<br /><em>orbit</em>, on track.</> : currentSection?.name ?? "Section"}</h1>
                <p>{archiveMode ? "Cancelled and archived records stay safely out of the way until you need them." : activeSection === "all" ? "Maintenance, services, renewals and household schedules—looked after in one clear place." : `${visibleItems.length} ${visibleItems.length === 1 ? "item" : "items"} in this section.`}</p>
              </div>
              <div className="hero-orbit" aria-hidden="true"><Image src="/orbit-mark.svg" alt="" width={280} height={280} /></div>
              <div className="hero-footer"><span><b>{archiveMode ? inactiveItems.length : urgentCount}</b> {archiveMode ? "stored records" : "need attention"}</span><span>All dates in {household.timezone.replace("_", " ")}</span></div>
            </article>

            <div className="insight-stack">
              <article className={`focus-card ${mostUrgent ? "" : "focus-card-empty"}`}>
                <div><span className="focus-kicker">{urgentCount ? "Most urgent" : "Next on the horizon"}</span><Icon name={urgentSection?.icon ?? "calendar"} /></div>
                <h2>{mostUrgent?.title ?? "Nothing scheduled"}</h2>
                <p>{mostUrgent ? `${mostUrgent.provider ?? mostUrgent.subtype ?? "Household item"}${mostUrgent.reference ? ` · ${mostUrgent.reference}` : ""}` : "Add a date and Orbit will keep watch."}</p>
                <div className="focus-date">
                  <strong>{focusDays == null ? "—" : Math.abs(focusDays)}</strong>
                  <span>{focusDays == null ? <>not<br />scheduled</> : focusDays < 0 ? <>days<br />overdue</> : focusDays === 0 ? <>due<br />today</> : <>days<br />to go</>}</span>
                  <button aria-label={mostUrgent ? `Open ${mostUrgent.title}` : "Add an item"} onClick={() => mostUrgent ? openItem(mostUrgent) : openNewItem()}><Icon name="chevron" /></button>
                </div>
              </article>
              <div className="mini-stats">
                <article><span className="mini-dot amber" /><div><strong>{dueSoonCount} due soon</strong><small>Within 30 days</small></div></article>
                <article><span className="mini-dot green">✓</span><div><strong>{onTrackCount} on track</strong><small>Nothing to do</small></div></article>
              </div>
            </div>
          </div>

          <section className="upcoming-section">
            <div className="list-heading">
              <div><p className="section-number">02</p><h2>{archiveMode ? "Archive & cancelled" : activeSection === "all" ? "Coming up" : `All ${(currentSection?.name ?? "items").toLowerCase()}`}</h2></div>
              <div className="list-actions">
                <span>{visibleItems.length} items</span>
                {!archiveMode && (
                  <select aria-label="Filter items" value={itemFilter} onChange={(event) => setItemFilter(event.target.value as ItemFilter)}>
                    <option value="all">All items</option>
                    <option value="attention">Needs attention</option>
                    <option value="unscheduled">Unscheduled</option>
                  </select>
                )}
                {!archiveMode && <button className="mobile-add" aria-label="Add item" onClick={openNewItem}><Icon name="plus" /></button>}
              </div>
            </div>
            <div className="item-list">
              {visibleItems.map((item, index) => {
                const dueBand = getDueBand(item.dueDate, today);
                const displayState = archiveMode ? item.status : dueBand;
                const itemSection = sections.find((section) => section.id === item.sectionId);
                return (
                  <article className={`item-card ${archiveMode ? "" : `due-band-${dueBand}`}`} key={item.id}>
                    <span className="row-number">{String(index + 1).padStart(2, "0")}</span>
                    <span className={`category-icon type-icon-${itemSection?.icon ?? "calendar"} accent-${itemSection?.accent ?? "sage"}`}><Icon name={itemSection?.icon ?? "calendar"} /></span>
                    <button className="item-main" onClick={() => openItem(item)}>
                      <div className="item-title-row"><h3>{item.title}</h3><span className={`status status-${displayState}`}>{archiveMode ? displayState : dashboardDueCopy(item, today, daysUntil)}</span></div>
                      <p><b>{item.subtype ?? itemSection?.name ?? "Household item"}</b><span>{item.provider ?? "No provider"}{item.reference ? ` · ${item.reference}` : ""}{item.recurrenceMonths ? ` · every ${item.recurrenceMonths === 12 ? "year" : `${item.recurrenceMonths} months`}` : ""}</span></p>
                    </button>
                    <div className="item-meta"><strong>{formatCost(item)}</strong><small>{item.dueDate ? formatLongDate(item.dueDate) : "Add a schedule"}</small></div>
                    <button className="more-button" aria-label={`Open ${item.title}`} onClick={() => openItem(item)}><Icon name="chevron" /></button>
                  </article>
                );
              })}
              {visibleItems.length === 0 && (
                <div className="empty-state">
                  <span><Icon name={listedItems.length ? "search" : archiveMode ? "archive" : "plus"} /></span>
                  <h3>{listedItems.length ? "No matching items" : archiveMode ? "Your archive is empty" : `Start shaping ${household.name}`}</h3>
                  <p>{listedItems.length ? "Try another search, section, or filter." : archiveMode ? "Archived and cancelled items will remain available here." : "Add the first renewal, service, contract, or household record."}</p>
                  {!listedItems.length && !archiveMode && <button onClick={openNewItem}>Add your first item</button>}
                </div>
              )}
            </div>
          </section>
        </section>
      </main>

      {menuOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}

      {settingsView && (
        <>
          <button className="settings-scrim" aria-label="Close personalisation" onClick={() => setSettingsView(null)} />
          <FocusDialog className="settings-drawer" aria-labelledby="personalise-title" onDismiss={() => setSettingsView(null)} returnFocusFallback="[data-settings-return-focus]">
            <header>
              <div><p>Make it yours</p><h2 id="personalise-title" tabIndex={-1} data-dialog-initial-focus>Personalise Orbit</h2></div>
              <button aria-label="Close personalisation" onClick={() => setSettingsView(null)}>×</button>
            </header>
            <div className="settings-tabs" role="tablist" aria-label="Personalisation settings">
              <button role="tab" aria-selected={settingsView === "appearance"} className={settingsView === "appearance" ? "active" : ""} onClick={() => setSettingsView("appearance")}>Appearance</button>
              <button role="tab" aria-selected={settingsView === "data"} className={settingsView === "data" ? "active" : ""} onClick={() => setSettingsView("data")}>Your data</button>
              <button role="tab" aria-selected={settingsView === "inbox"} className={settingsView === "inbox" ? "active" : ""} onClick={() => setSettingsView("inbox")}>Inbox</button>
              {workspace.recoverableHouseholds.length > 0 && <button role="tab" aria-selected={settingsView === "recovery"} className={settingsView === "recovery" ? "active" : ""} onClick={() => setSettingsView("recovery")}>Removed</button>}
              {household.canManage && <button role="tab" aria-selected={settingsView === "household"} className={settingsView === "household" ? "active" : ""} onClick={() => setSettingsView("household")}>Household</button>}
              {household.canManage && <button role="tab" aria-selected={settingsView === "sections"} className={settingsView === "sections" ? "active" : ""} onClick={() => setSettingsView("sections")}>Sections</button>}
              <button role="tab" aria-selected={settingsView === "members"} className={settingsView === "members" ? "active" : ""} onClick={() => setSettingsView("members")}>Members</button>
              {session.user.isInstanceAdmin && <button role="tab" aria-selected={settingsView === "administration"} className={settingsView === "administration" ? "active" : ""} onClick={() => setSettingsView("administration")}>Admin</button>}
            </div>

            {settingsView === "appearance" ? (
              <div className="settings-content">
                <section>
                  <div className="setting-heading"><h3>Display mode</h3><p>Use your device setting or choose a consistent mode.</p></div>
                  <div className="mode-picker">
                    {themeModes.map((mode) => (
                      <button className={themeMode === mode ? "active" : ""} key={mode} onClick={() => updateAppearance({ mode })}>
                        <span className={`mode-preview mode-${mode}`}><i /><b /></span>
                        {mode[0].toUpperCase() + mode.slice(1)}
                      </button>
                    ))}
                  </div>
                </section>
                <section>
                  <div className="setting-heading"><h3>Colourway</h3><p>Each palette has a carefully tuned light and dark expression.</p></div>
                  <div className="colourway-list">
                    {colourways.map((theme) => (
                      <button className={colourway === theme.id ? "active" : ""} key={theme.id} onClick={() => updateAppearance({ colourway: theme.id })}>
                        <span className="theme-swatches">{theme.swatches.map((swatch) => <i key={swatch} style={{ backgroundColor: swatch }} />)}</span>
                        <span><strong>{theme.name}</strong><small>{theme.description}</small></span>
                        <b>{colourway === theme.id ? "✓" : ""}</b>
                      </button>
                    ))}
                  </div>
                </section>
                <section>
                  <div className="setting-heading"><h3>Text size</h3><p>Increase Orbit&apos;s typography without scaling the rest of the interface.</p></div>
                  <div className="preference-card-picker">
                    {textSizes.map((size) => (
                      <button className={textSize === size ? "active" : ""} key={size} onClick={() => updateAppearance({ textSize: size })}>
                        <span className={`text-size-preview text-size-${size}`}>Aa</span>
                        <span><strong>{textSizeLabels[size].name}</strong><small>{textSizeLabels[size].detail}</small></span>
                        <b>{textSize === size ? "✓" : ""}</b>
                      </button>
                    ))}
                  </div>
                </section>
                <section>
                  <div className="setting-heading"><h3>Due-date heat map</h3><p>Choose traditional urgency colours or a palette tuned to the active theme.</p></div>
                  <div className="preference-card-picker">
                    {urgencyPalettes.map((palette) => (
                      <button className={urgencyPalette === palette ? "active" : ""} key={palette} onClick={() => updateAppearance({ urgencyPalette: palette })}>
                        <span className={`heat-preview heat-preview-${palette}`}><i /><i /><i /><i /></span>
                        <span><strong>{urgencyPaletteLabels[palette].name}</strong><small>{urgencyPaletteLabels[palette].detail}</small></span>
                        <b>{urgencyPalette === palette ? "✓" : ""}</b>
                      </button>
                    ))}
                  </div>
                </section>
                <section>
                  <div className="setting-heading"><h3>Reminder delivery</h3><p>Choose how Orbit contacts you. These choices only affect your account.</p></div>
                  <div className="preference-card-picker">
                    <button
                      aria-pressed={emailNotifications}
                      className={emailNotifications ? "active" : ""}
                      onClick={() => updateAppearance({ emailNotifications: !emailNotifications })}
                    >
                      <span className="text-size-preview">Email</span>
                      <span><strong>Email reminders</strong><small>Send scheduled reminders to your registered address</small></span>
                      <b>{emailNotifications ? "On" : "Off"}</b>
                    </button>
                    <button
                      aria-pressed={pushNotifications}
                      className={pushNotifications ? "active" : ""}
                      onClick={() => updateAppearance({ pushNotifications: !pushNotifications })}
                    >
                      <span className="text-size-preview">Push</span>
                      <span><strong>Browser push</strong><small>Notify browsers where you have enabled Orbit notifications</small></span>
                      <b>{pushNotifications ? "On" : "Off"}</b>
                    </button>
                  </div>
                </section>
              </div>
            ) : settingsView === "data" ? (
              <PortableArchiveManager householdId={household.id} csrfToken={session.csrfToken} />
            ) : settingsView === "inbox" ? (
              <ImapInbox csrfToken={session.csrfToken} />
            ) : settingsView === "recovery" ? (
              <HouseholdRecovery households={workspace.recoverableHouseholds} csrfToken={session.csrfToken} isInstanceAdmin={session.user.isInstanceAdmin} />
            ) : settingsView === "household" && household.canManage ? (
              <HouseholdSettings key={household.id} household={household} onSave={updateHousehold} csrfToken={session.csrfToken} />
            ) : settingsView === "sections" && household.canManage ? (
              <div className="settings-content">
                <section>
                  <div className="setting-heading section-heading"><div><h3>{household.name}&apos;s sections</h3><p>Rename, reorder or hide the areas this household uses.</p></div><button onClick={addSection} disabled={sections.length >= 12}><Icon name="plus" /> Add</button></div>
                  <div className="section-editor">
                    {sections.map((section, index) => {
                      const itemCount = activeItems.filter((item) => item.sectionId === section.id).length;
                      return (
                        <article key={section.id}>
                          <button className={`section-drag accent-${section.accent}`} aria-label={`Change colour for ${section.name}`} title="Change section colour" onClick={() => cycleSectionAccent(section.id)}><Icon name={section.icon} /></button>
                          <div>
                            <input aria-label={`Name for ${section.name}`} maxLength={30} value={section.name} onChange={(event) => updateSections(sections.map((entry) => entry.id === section.id ? { ...entry, name: event.target.value || "Untitled section" } : entry))} />
                            <small>{itemCount} {itemCount === 1 ? "item" : "items"}</small>
                          </div>
                          <select aria-label={`Icon for ${section.name}`} value={section.icon} onChange={(event) => updateSections(sections.map((entry) => entry.id === section.id ? { ...entry, icon: event.target.value as SectionIcon } : entry))}>
                            {customSectionIcons.map((icon) => <option key={icon} value={icon}>{icon}</option>)}
                          </select>
                          <div className="order-buttons">
                            <button aria-label={`Move ${section.name} up`} disabled={index === 0} onClick={() => moveSection(section.id, -1)}>↑</button>
                            <button aria-label={`Move ${section.name} down`} disabled={index === sections.length - 1} onClick={() => moveSection(section.id, 1)}>↓</button>
                          </div>
                          <label className="visibility-toggle"><input type="checkbox" checked={section.visible} onChange={(event) => updateSections(sections.map((entry) => entry.id === section.id ? { ...entry, visible: event.target.checked } : entry))} /><span /><em>{section.visible ? "Shown" : "Hidden"}</em></label>
                        </article>
                      );
                    })}
                  </div>
                  <button className="reset-sections" onClick={restoreDefaultSections}>Restore default sections</button>
                </section>
              </div>
            ) : settingsView === "members" ? (
              <MemberManager householdId={household.id} session={session} />
            ) : (
              <AdminManager session={session} />
            )}
            <footer className="settings-session-actions">
              <div>
                <strong>End this session</strong>
                <span>Private workspace data is not retained for offline use.</span>
              </div>
              <button type="button" onClick={handleSignOut} disabled={logoutBusy}>
                {logoutBusy ? "Signing out…" : "Sign out securely"}
              </button>
            </footer>
          </FocusDialog>
        </>
      )}

      {itemEditorOpen && (
        <ItemEditor
          key={editingItem?.id ?? "new-item"}
          item={editingItem}
          sections={sections}
          currency={household.currency}
          householdId={household.id}
          csrfToken={session.csrfToken}
          onClose={() => setItemEditorOpen(false)}
          onSave={saveItem}
          onArchive={editingItem ? archiveItem : undefined}
        />
      )}

      {detailItem && !itemEditorOpen && (
        <ItemDetail
          key={detailItem.id}
          item={detailItem}
          section={sections.find((section) => section.id === detailItem.sectionId)}
          activities={household.activities}
          today={today}
          householdId={household.id}
          csrfToken={session.csrfToken}
          onClose={() => setDetailItemId(null)}
          onEdit={() => editItem(detailItem)}
          onComplete={(input) => completeItem(detailItem, input)}
          onReschedule={(dueDate) => rescheduleItem(detailItem, dueDate)}
          onSnooze={(until) => snoozeItem(detailItem, until)}
          onCancel={() => setItemStatus(detailItem, "cancelled")}
          onRestore={() => setItemStatus(detailItem, "active")}
          onArchive={() => archiveItem(detailItem)}
        />
      )}

      {notificationsOpen && !detailItem && (
        <NotificationCenter
          notifications={notifications}
          onClose={() => setNotificationsOpen(false)}
          onOpenItem={openNotification}
          onRead={(notificationId) => dispatch({ type: "notification.read", householdId: household.id, notificationId })}
          onDismiss={(notificationId) => dispatch({ type: "notification.dismiss", householdId: household.id, notificationId })}
          onReadAll={() => dispatch({
            type: "notification.read-all",
            householdId: household.id,
            notificationIds: notifications.map((notification) => notification.id),
          })}
          session={session}
        />
      )}

      {onboardingOpen && <HouseholdOnboarding onClose={() => setOnboardingOpen(false)} onCreate={addHousehold} onRecoverableNameConflict={returnToHouseholdRecovery} />}

      {householdChoiceRequired && !onboardingOpen && <HouseholdRecoveryPrompt households={workspace.recoverableHouseholds} csrfToken={session.csrfToken} isInstanceAdmin={session.user.isInstanceAdmin} onCreate={() => setOnboardingOpen(true)} />}

      {!household.onboardingComplete && !householdChoiceRequired && <FirstRunWizard household={household} onComplete={completeFirstRun} />}

      {notice && (
        <div className="action-toast" role="status">
          <span>{notice.message}</span>
          {notice.undoItem && <button onClick={() => undoArchive(notice.undoItem as HomeItem)}>Undo</button>}
          <button aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button>
        </div>
      )}
    </div>
  );
}
