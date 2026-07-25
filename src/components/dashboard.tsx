"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { HouseholdOnboarding, type HouseholdInput } from "@/components/household-onboarding";
import { Icon } from "@/components/icons";
import { ItemDetail, type CompletionInput } from "@/components/item-detail";
import { ItemEditor } from "@/components/item-editor";
import { NotificationCenter } from "@/components/notification-center";
import { MemberManager } from "@/components/member-manager";
import {
  daysUntil,
  getDueState,
  sortByDueDate,
  type HomeItem,
  type HouseholdSection,
  type SectionAccent,
  type SectionIcon,
} from "@/lib/domain";
import { householdNotifications, type HouseholdNotification } from "@/lib/notifications";
import { colourways, themeModes, themePreferenceSchema, type ThemeMode } from "@/lib/preferences";
import { useWorkspace } from "@/lib/preview-workspace";
import { activeHousehold, cloneSections, createHousehold, type ItemActivity } from "@/lib/workspace";

const THEME_STORAGE_KEY = "orbit:theme:v1";
const PREFERENCE_EVENT = "orbit:preference-change";
const DEFAULT_THEME_JSON = JSON.stringify({ mode: "system", colourway: "after-dark" });

type SettingsView = "appearance" | "sections" | "members";
type ItemFilter = "all" | "attention" | "unscheduled";
type Notice = { message: string; undoItem?: HomeItem };

const customSectionAccents: SectionAccent[] = ["coral", "sage", "blue", "sand", "plum"];
const customSectionIcons: SectionIcon[] = ["home", "vehicle", "device", "service", "calendar"];

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

function storePreference(key: string, value: unknown) {
  window.localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent(PREFERENCE_EVENT, { detail: key }));
}

function calendarDateInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function formatLongDate(value: string, timeZone = "UTC") {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatHeadingDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatCost(item: HomeItem) {
  if (item.costMinor == null) return "No cost recorded";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: item.currency }).format(item.costMinor / 100);
}

function dueCopy(item: HomeItem, today: string) {
  if (!item.dueDate) return "No due date";
  const days = daysUntil(item.dueDate, today);
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days === 0) return "Due today";
  return `Due in ${days} days`;
}

function householdInitials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

export function Dashboard() {
  const { workspace, dispatch, session, syncStatus, syncMessage } = useWorkspace();
  const household = activeHousehold(workspace);
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
  const storedTheme = useLocalStorageValue(THEME_STORAGE_KEY, DEFAULT_THEME_JSON);
  const themePreference = useMemo(() => {
    try {
      const parsed = themePreferenceSchema.safeParse(JSON.parse(storedTheme));
      return parsed.success ? parsed.data : { mode: "system" as ThemeMode, colourway: "after-dark" };
    } catch {
      return { mode: "system" as ThemeMode, colourway: "after-dark" };
    }
  }, [storedTheme]);
  const themeMode = themePreference.mode;
  const colourway = themePreference.colourway;
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
    });
  }, [session]);

  function updateTheme(mode: ThemeMode, nextColourway = colourway) {
    storePreference(THEME_STORAGE_KEY, { mode, colourway: nextColourway });
    if (session) {
      void fetch("/api/preferences", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
        body: JSON.stringify({ mode, colourway: nextColourway }),
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

  function saveItem(item: HomeItem) {
    const kind = editingItem ? "updated" : "created";
    dispatch({
      type: "item.upsert",
      householdId: household.id,
      item,
      activity: activity(item, kind, { nextDate: item.dueDate }),
    });
    setItemEditorOpen(false);
    setNotice({ message: editingItem ? `${item.title} updated` : `${item.title} added` });
  }

  function archiveItem(item: HomeItem) {
    dispatch({
      type: "item.archive",
      householdId: household.id,
      itemId: item.id,
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
    setHouseholdMenuOpen(false);
    setMenuOpen(false);
  }

  function addHousehold(input: HouseholdInput) {
    dispatch({
      type: "household.create",
      household: createHousehold({ id: crypto.randomUUID(), ...input }),
    });
    setActiveSection("all");
    setOnboardingOpen(false);
    setHouseholdMenuOpen(false);
    setNotice({ message: `${input.name} is ready` });
  }

  return (
    <div className="app-frame" data-theme={colourway} data-mode={themeMode}>
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
        <button className="profile" onClick={() => setSettingsView("appearance")}>
          <span className="profile-avatar">{householdInitials(session?.user.displayName ?? "Preview owner")}</span>
          <span><strong>{session?.user.displayName ?? "Preview owner"}</strong><small>{session ? session.user.email : "Local demonstration"}</small></span>
          <Icon name="more" />
        </button>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Open navigation" onClick={() => setMenuOpen(!menuOpen)}><span /><span /><span /></button>
          <label className="search"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${household.name.toLowerCase()}…`} /></label>
          <span className={`sync-state sync-${syncStatus}`} title={syncMessage || undefined}>
            <i />{syncStatus === "preview" ? "Preview" : syncStatus === "saving" ? "Saving" : syncStatus === "offline" ? "Offline" : syncStatus === "loading" ? "Loading" : syncStatus === "error" ? "Review" : "Synced"}
          </span>
          <button className="icon-button" aria-label={`Notifications${unreadNotificationCount ? `, ${unreadNotificationCount} unread` : ""}`} onClick={() => setNotificationsOpen(true)}><Icon name="bell" />{unreadNotificationCount > 0 && <i />}</button>
          <button className="add-button" onClick={openNewItem}><Icon name="plus" /> Add item</button>
        </header>

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
                const dueState = getDueState(item.dueDate, today);
                const displayState = archiveMode ? item.status : dueState;
                const itemSection = sections.find((section) => section.id === item.sectionId);
                return (
                  <article className="item-card" key={item.id}>
                    <span className="row-number">{String(index + 1).padStart(2, "0")}</span>
                    <span className={`category-icon type-icon-${itemSection?.icon ?? "calendar"} accent-${itemSection?.accent ?? "sage"}`}><Icon name={itemSection?.icon ?? "calendar"} /></span>
                    <button className="item-main" onClick={() => openItem(item)}>
                      <div className="item-title-row"><h3>{item.title}</h3><span className={`status status-${displayState}`}>{archiveMode ? displayState : dueCopy(item, today)}</span></div>
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
          <aside className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="personalise-title">
            <header>
              <div><p>Make it yours</p><h2 id="personalise-title">Personalise Orbit</h2></div>
              <button aria-label="Close personalisation" onClick={() => setSettingsView(null)}>×</button>
            </header>
            <div className="settings-tabs" role="tablist" aria-label="Personalisation settings">
              <button role="tab" aria-selected={settingsView === "appearance"} className={settingsView === "appearance" ? "active" : ""} onClick={() => setSettingsView("appearance")}>Appearance</button>
              <button role="tab" aria-selected={settingsView === "sections"} className={settingsView === "sections" ? "active" : ""} onClick={() => setSettingsView("sections")}>Sections</button>
              <button role="tab" aria-selected={settingsView === "members"} className={settingsView === "members" ? "active" : ""} onClick={() => setSettingsView("members")}>Members</button>
            </div>

            {settingsView === "appearance" ? (
              <div className="settings-content">
                <section>
                  <div className="setting-heading"><h3>Display mode</h3><p>Use your device setting or choose a consistent mode.</p></div>
                  <div className="mode-picker">
                    {themeModes.map((mode) => (
                      <button className={themeMode === mode ? "active" : ""} key={mode} onClick={() => updateTheme(mode)}>
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
                      <button className={colourway === theme.id ? "active" : ""} key={theme.id} onClick={() => updateTheme(themeMode, theme.id)}>
                        <span className="theme-swatches">{theme.swatches.map((swatch) => <i key={swatch} style={{ backgroundColor: swatch }} />)}</span>
                        <span><strong>{theme.name}</strong><small>{theme.description}</small></span>
                        <b>{colourway === theme.id ? "✓" : ""}</b>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            ) : settingsView === "sections" ? (
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
                  <button className="reset-sections" onClick={() => updateSections(cloneSections().map((section, index) => ({
                    ...section,
                    id: sections[index]?.id ?? crypto.randomUUID(),
                  })))}>Restore default sections</button>
                </section>
              </div>
            ) : (
              <MemberManager householdId={household.id} session={session} />
            )}
          </aside>
        </>
      )}

      {itemEditorOpen && (
        <ItemEditor
          key={editingItem?.id ?? "new-item"}
          item={editingItem}
          sections={sections}
          currency={household.currency}
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

      {onboardingOpen && <HouseholdOnboarding onClose={() => setOnboardingOpen(false)} onCreate={addHousehold} />}

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
