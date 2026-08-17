"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountMenu } from "@/components/account-menu";
import { usePersistedThemePreference } from "@/components/appearance-preference";
import { FirstRunWizard, type HouseholdSetupInput } from "@/components/first-run-wizard";
import type { HouseholdInput } from "@/components/household-onboarding";
import type { HouseholdSettingsInput } from "@/components/household-settings";
import { HouseholdRecovery, HouseholdRecoveryPrompt } from "@/components/household-recovery";
import { HeroSky, ItemRow, type ItemFilter } from "@/components/hero-sky";
import { Icon } from "@/components/icons";
import type { CompletionInput } from "@/components/item-detail";
import { calendarDateInTimeZone, formatLongDate, householdInitials, storePreference, THEME_STORAGE_KEY } from "@/components/dashboard-utils";
import {
  daysUntil,
  getDueState,
  sortByDueDate,
  type HomeItem,
  type HouseholdSection,
  type SectionAccent,
  type SectionIcon,
} from "@/lib/domain";
import { householdNotifications, type HouseholdNotification, type NotificationReader } from "@/lib/notifications";
import {
  textSizes,
  themePackInfo,
  themePacks,
  type ThemePreference,
} from "@/lib/preferences";
import { useWorkspace } from "@/lib/preview-workspace";
import { activeHousehold, cloneSections, createEmptyWorkspace, createHousehold, type ItemActivity } from "@/lib/workspace";

// Code-split (issue #383): these render only inside the settings route
// (`mode === "settings"`, see renderSettingsContent below) and never in the
// home route's `mode === "workspace"` tree, so a static import here put
// ~115KB of settings-only source in the home route's client bundle. Kept as
// SSR'd dynamic imports (the default) rather than `{ ssr: false }` because
// `/settings` renders them unconditionally on first paint and must still
// come back as real SSR'd HTML for that route.
const HouseholdSettings = dynamic(() => import("@/components/household-settings").then((mod) => mod.HouseholdSettings));
const PortableArchiveManager = dynamic(() => import("@/components/portable-archive-manager").then((mod) => mod.PortableArchiveManager));
const ImapInbox = dynamic(() => import("@/components/imap-inbox").then((mod) => mod.ImapInbox));
const MemberManager = dynamic(() => import("@/components/member-manager").then((mod) => mod.MemberManager));

// Code-split (issue #383): these only ever mount behind boolean modal state
// that starts `false`, so they are never part of the server-rendered HTML
// on either route — `{ ssr: false }` matches that and skips rendering them
// server-side entirely.
const ItemEditor = dynamic(() => import("@/components/item-editor").then((mod) => mod.ItemEditor), { ssr: false });
const ItemDetail = dynamic(() => import("@/components/item-detail").then((mod) => mod.ItemDetail), { ssr: false });
const NotificationCenter = dynamic(() => import("@/components/notification-center").then((mod) => mod.NotificationCenter), { ssr: false });
const HouseholdOnboarding = dynamic(() => import("@/components/household-onboarding").then((mod) => mod.HouseholdOnboarding), { ssr: false });

const NOTICE_DURATION_MS = 10_000;
const SETTINGS_RETURN_FOCUS_KEY = "settings-return-focus";

type DashboardMode = "workspace" | "settings";
type Notice = { message: string; undoItem?: HomeItem };

const settingsSectionIds = {
  appearance: "settings-appearance",
  data: "settings-data",
  inbox: "settings-inbox",
  recovery: "settings-recovery",
  household: "settings-household",
  sections: "settings-sections",
  members: "settings-members",
} as const;

function visibleSettingsTrigger(): "desktop-profile" | "mobile-menu" {
  return window.matchMedia("(min-width: 821px)").matches ? "desktop-profile" : "mobile-menu";
}

/** See navigateHomeWithFocus: the marker's presence is the only trace of
 *  whether this settings visit came from this engine's own workspace. */
function settingsExitTarget(): string {
  return sessionStorage.getItem(SETTINGS_RETURN_FOCUS_KEY) ? "/workspace" : "/";
}

function focusSettingsSection(sectionId: string) {
  window.setTimeout(() => {
    const heading = document.getElementById(sectionId)?.querySelector<HTMLElement>("h2");
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "start" });
  }, 0);
}

const customSectionAccents: SectionAccent[] = ["coral", "sage", "blue", "sand", "plum"];
const customSectionIcons: SectionIcon[] = ["home", "vehicle", "device", "service", "calendar"];
const textSizeLabels = {
  standard: { name: "Standard", detail: "Original compact sizing" },
  comfortable: { name: "Comfortable", detail: "Larger and easier to scan" },
  large: { name: "Large", detail: "Maximum in-app text size" },
  "extra-large": { name: "Extra large", detail: "Maximum readability without browser zoom" },
} as const;

/**
 * A section-name editor that types locally and only commits (via `onCommit`)
 * on blur or Enter, instead of on every keystroke (issue #383). The section
 * list is the source of truth once committed: if it changes out from under
 * this field (another tab, a restore) while untouched, the draft resyncs.
 *
 * Exported for direct unit coverage (dashboard.test.tsx) — the surrounding
 * `AuthenticatedDashboard` needs a full session/workspace to render.
 */
export function SectionNameField({ name, onCommit, ariaLabel }: { name: string; onCommit: (name: string) => void; ariaLabel: string }) {
  const [draft, setDraft] = useState(name);
  // Resync the draft when `name` changes out from under this field (a
  // committed rename round-trip, another tab, a restore) without an effect —
  // adjusting state during render, per https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  const [prevName, setPrevName] = useState(name);
  if (name !== prevName) {
    setPrevName(name);
    setDraft(name);
  }

  function commit() {
    const trimmed = draft || "Untitled section";
    if (trimmed !== name) onCommit(trimmed);
    else if (draft !== name) setDraft(name);
  }

  return (
    <input
      aria-label={ariaLabel}
      maxLength={30}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      }}
    />
  );
}

function AuthenticationGate({
  loading,
  loadingMessage,
  error,
  onRetry,
  returnTo,
}: {
  loading: boolean;
  loadingMessage?: string;
  error?: string;
  onRetry?: () => void;
  returnTo: string;
}) {
  const message = loading ? loadingMessage : error;
  return (
    <main className="authentication-gate">
      <section>
        <Image src="/orbit-mark.svg" alt="" width={112} height={112} priority />
        <p className="eyebrow">Everything in your orbit, on track</p>
        <h1>{loading ? loadingMessage ? "Orbit is starting…" : "Checking access…" : error ? "Orbit could not open safely." : "Sign in to Orbit."}</h1>
        <p role={message ? "alert" : undefined}>
          {message ?? (loading
            ? "Orbit is confirming your session."
            : "Your household information is private and is only available after authentication.")}
        </p>
        {!loading && error && onRetry && <button className="wizard-primary" type="button" onClick={onRetry}>Try again <Icon name="chevron" /></button>}
        {!loading && !error && <a className="wizard-primary" href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>Sign in securely <Icon name="chevron" /></a>}
      </section>
    </main>
  );
}

type AuthenticatedWorkspace = Omit<ReturnType<typeof useWorkspace>, "session">;

/** Keeps signed-out/loading state outside the authenticated dashboard tree. */
export function Dashboard({ mode = "workspace" }: { mode?: DashboardMode } = {}) {
  const { session, ...workspaceState } = useWorkspace();
  if (!session) {
    return (
      <AuthenticationGate
        loading={workspaceState.syncStatus === "loading"}
        loadingMessage={workspaceState.syncStatus === "loading" ? workspaceState.syncMessage || undefined : undefined}
        error={workspaceState.syncStatus === "error" ? workspaceState.syncMessage : undefined}
        onRetry={workspaceState.syncStatus === "error" ? workspaceState.retryInitialization : undefined}
        // "/" is v19's own door now (#410, §15): a bare login redirect would
        // strand this engine's sign-in on the wrong front end. This gate only
        // ever renders at the address it was mounted on, so returning there
        // (not "/") is what "signed in" actually means for this reader.
        returnTo={mode === "settings" ? "/settings" : "/workspace"}
      />
    );
  }
  return <AuthenticatedDashboard session={session} workspaceState={workspaceState} mode={mode} />;
}

function AuthenticatedDashboard({ session, workspaceState, mode }: { session: NonNullable<ReturnType<typeof useWorkspace>["session"]>; workspaceState: AuthenticatedWorkspace; mode: DashboardMode }) {
  const router = useRouter();
  const { workspace, dispatch, executeCommand, refreshWorkspace, signOut, syncStatus, syncMessage } = workspaceState;
  const hasActiveHousehold = workspace.households.length > 0;
  // Memoized (issue #383): gives `household` (and everything derived from it
  // below) a stable identity across renders that don't touch `workspace`, so
  // those derived useMemo/HeroSky memoizations can actually hit instead of
  // recomputing every time — including on the placeholder-household fallback
  // branch, which otherwise allocates a fresh object on every render.
  const household = useMemo(() => activeHousehold(workspace) ?? createEmptyWorkspace().households[0], [workspace]);
  // Legacy placeholder households may already exist from releases that created
  // one during a workspace read. Give recovery choices precedence over that
  // unfinished setup, but never create another household from this view.
  const householdChoiceRequired = workspace.householdLanding === "choose"
    || (workspace.recoverableHouseholds.length > 0 && (!hasActiveHousehold || !household.onboardingComplete));
  const sections = household.sections;
  const today = calendarDateInTimeZone(household.timezone);
  const [activeSection, setActiveSection] = useState<string | "all">("all");
  const settingsHeadingRef = useRef<HTMLHeadingElement>(null);
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
  const themePreference = usePersistedThemePreference(session.user);
  const theme = themePreference.theme;
  const textSize = themePreference.textSize;
  const emailNotifications = themePreference.emailNotifications;
  const pushNotifications = themePreference.pushNotifications;
  // #487: the in-app notification list must warn this reader on THEIR OWN
  // first/final pair, exactly like dispatch does (#479) — not a fixed window.
  // Starts with no stored pair (falls back to the documented defaults inside
  // householdNotifications) until the fetch below resolves, so the list never
  // blocks on this request; an item with its own reminder rules is unaffected
  // either way, since a rule always wins outright.
  const [reminderReader, setReminderReader] = useState<NotificationReader>({
    id: session.user.id, firstWarningDays: null, finalWarningDays: null,
  });
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/settings/reminders", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() as Promise<{ reminders?: { firstWarningDays: number; finalWarningDays: number } }> : null))
      .then((body) => {
        if (cancelled || !body?.reminders) return;
        setReminderReader({ id: session.user.id, firstWarningDays: body.reminders.firstWarningDays, finalWarningDays: body.reminders.finalWarningDays });
      })
      .catch(() => { /* Keeps the documented defaults; the bell degrades gracefully rather than blocking. */ });
    return () => { cancelled = true; };
  }, [session.user.id]);
  // Memoized (issue #383): household.items keeps a stable reference across
  // renders that don't touch the workspace (menu toggles, notices, etc.), so
  // these only need to recompute when the underlying data actually changes.
  const activeItems = useMemo(
    () => household.items.filter((item) => item.status === "active"),
    [household.items],
  );
  const inactiveItems = useMemo(
    () => household.items.filter((item) => ["archived", "cancelled"].includes(item.status)),
    [household.items],
  );
  const archiveMode = activeSection === "archive";
  const listedItems = archiveMode ? inactiveItems : activeItems;
  // Memoized (issue #383): householdNotifications does O(items x id-array)
  // work; without this it reran on every render, including every keystroke
  // in the unrelated topbar search input.
  const notifications = useMemo(() => householdNotifications(household, today, reminderReader), [household, today, reminderReader]);
  const unreadNotificationCount = notifications.filter((notification) => !notification.read).length;
  const detailItem = household.items.find((item) => item.id === detailItemId);

  // Memoized (issue #383): keeps a stable array identity when none of these
  // inputs changed, so HeroSky's own `[items, today]` memos (buildDialItems /
  // buildManifestGroups) actually hit instead of recomputing on every
  // dashboard-level re-render (menu toggles, notices, hover-adjacent state).
  const visibleItems = useMemo(
    () => sortByDueDate(listedItems.filter((item) => {
      const matchesSection = archiveMode || activeSection === "all" || item.sectionId === activeSection;
      const haystack = `${item.title} ${item.provider ?? ""} ${item.subtype ?? ""} ${item.reference ?? ""}`.toLowerCase();
      const matchesSearch = haystack.includes(query.trim().toLowerCase());
      const dueState = getDueState(item.dueDate, today);
      const matchesFilter = archiveMode || itemFilter === "all"
        || (itemFilter === "attention" && ["overdue", "due-soon"].includes(dueState))
        || (itemFilter === "unscheduled" && dueState === "unscheduled");
      return matchesSection && matchesSearch && matchesFilter;
    }), today),
    [listedItems, archiveMode, activeSection, query, itemFilter, today],
  );

  const sortedItems = sortByDueDate(activeItems, today);
  const urgentItems = sortedItems.filter((item) => ["overdue", "due-soon"].includes(getDueState(item.dueDate, today)));
  const mostUrgent = urgentItems[0] ?? sortedItems.find((item) => item.dueDate);
  const urgentCount = urgentItems.length;
  const dueSoonCount = activeItems.filter((item) => getDueState(item.dueDate, today) === "due-soon").length;
  const onTrackCount = activeItems.filter((item) => getDueState(item.dueDate, today) === "upcoming").length;
  const currentSection = sections.find((section) => section.id === activeSection);
  const urgentSection = mostUrgent ? sections.find((section) => section.id === mostUrgent.sectionId) : undefined;
  const focusDays = mostUrgent?.dueDate ? daysUntil(mostUrgent.dueDate, today) : undefined;

  const navigateHomeWithFocus = useCallback(() => {
    // navigateToSettings() (below) writes this marker before router.push("/settings")
    // whenever settings was entered from this engine's own workspace — its
    // presence here is the only trace of that, since /settings is reachable
    // from v19's helm too (#410, §15) and this component cannot otherwise
    // tell the two apart.
    const target = settingsExitTarget();
    if (target === "/") {
      sessionStorage.setItem(SETTINGS_RETURN_FOCUS_KEY, visibleSettingsTrigger());
    }
    router.push(target);
  }, [router]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Handle ?open=inbox routing for workspace mode
  useEffect(() => {
    if (mode !== "workspace") return;
    if (new URLSearchParams(window.location.search).get("open") !== "inbox") return;
    router.push("/settings?open=inbox");
  }, [mode, router]);

  // Focus the settings heading on route entry, or the requested section when
  // the route carries a same-page destination.
  useEffect(() => {
    if (mode !== "settings") return;
    const requestedSection = new URLSearchParams(window.location.search).get("open") === "inbox"
      ? settingsSectionIds.inbox
      : window.location.hash.slice(1);
    const settingsSectionIdValues = Object.values(settingsSectionIds);
    const sectionId = settingsSectionIdValues.includes(requestedSection as (typeof settingsSectionIdValues)[number])
      ? requestedSection
      : null;
    const timer = window.setTimeout(() => {
      if (sectionId) focusSettingsSection(sectionId);
      else settingsHeadingRef.current?.focus();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [mode]);

  // Handle focus return in workspace mode
  useEffect(() => {
    if (mode !== "workspace") return;
    const focusMarker = sessionStorage.getItem(SETTINGS_RETURN_FOCUS_KEY);
    if (!focusMarker) return;

    sessionStorage.removeItem(SETTINGS_RETURN_FOCUS_KEY);

    const timer = window.setTimeout(() => {
      if (focusMarker === "desktop-profile") {
        const profileButton = document.querySelector("button.topbar-profile") as HTMLButtonElement | null;
        profileButton?.focus();
      } else if (focusMarker === "mobile-menu") {
        const menuButton = document.querySelector("button.mobile-menu") as HTMLButtonElement | null;
        menuButton?.focus();
      }
    }, 50);

    return () => window.clearTimeout(timer);
  }, [mode]);

  useEffect(() => {
    if (mode !== "settings") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") navigateHomeWithFocus();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, navigateHomeWithFocus]);

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
      const documentId = crypto.randomUUID();
      const response = await fetch(`/api/households/${household.id}/items/${approvedItemId}/documents`, {
          method: "POST", credentials: "same-origin",
          headers: {
            "X-CSRF-Token": session.csrfToken,
            "X-Orbit-Filename": encodeURIComponent(document.name),
            "X-Orbit-Review-Operation": item.id,
            "X-Orbit-Document-Id": documentId,
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
      // mode "workspace" is only ever this engine's own address (#410, §15);
      // mode "settings" is reachable from v19's helm too, so the same
      // came-from-workspace marker navigateHomeWithFocus reads decides it.
      await signOut(mode === "workspace" ? "/workspace" : settingsExitTarget());
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

  function navigateToSettings() {
    sessionStorage.setItem(SETTINGS_RETURN_FOCUS_KEY, visibleSettingsTrigger());
    router.push("/settings");
  }

  if (mode === "settings") {
    return (
      <main className="settings-page" data-theme={theme} data-text-size={textSize}>
        <header className="settings-page-header">
          <button className="settings-return-button" onClick={navigateHomeWithFocus}>
            <Icon name="chevron" /> Return to Orbit
          </button>
          <h1 className="page-heading" ref={settingsHeadingRef} tabIndex={-1}>Settings</h1>
        </header>

        {syncStatus === "error" && syncMessage && (
          <div className="sync-error-banner" role="alert">{syncMessage}</div>
        )}

        {session.user.isInstanceAdmin && (
          <nav className="settings-admin-link" aria-label="Instance administration">
            <a href="/admin">Administration</a>
          </nav>
        )}

        <div className="settings-layout">
          <aside className="settings-section-nav-column">
            <nav className="settings-section-nav" aria-label="Settings sections">
              <a href={`#${settingsSectionIds.appearance}`} onClick={() => focusSettingsSection(settingsSectionIds.appearance)}>Appearance</a>
              <a href={`#${settingsSectionIds.data}`} onClick={() => focusSettingsSection(settingsSectionIds.data)}>Your data</a>
              <a href={`#${settingsSectionIds.inbox}`} onClick={() => focusSettingsSection(settingsSectionIds.inbox)}>Inbox</a>
              {workspace.recoverableHouseholds.length > 0 && <a href={`#${settingsSectionIds.recovery}`} onClick={() => focusSettingsSection(settingsSectionIds.recovery)}>Removed</a>}
              {household.canManage && <a href={`#${settingsSectionIds.household}`} onClick={() => focusSettingsSection(settingsSectionIds.household)}>Household</a>}
              {household.canManage && <a href={`#${settingsSectionIds.sections}`} onClick={() => focusSettingsSection(settingsSectionIds.sections)}>Sections</a>}
              <a href={`#${settingsSectionIds.members}`} onClick={() => focusSettingsSection(settingsSectionIds.members)}>Members</a>
            </nav>
          </aside>
          {renderSettingsContent()}
        </div>

        <footer className="settings-session-actions">
          <div>
            <strong>End this session</strong>
            <span>Private workspace data is not retained for offline use.</span>
          </div>
          <button type="button" onClick={handleSignOut} disabled={logoutBusy}>
            {logoutBusy ? "Signing out…" : "Sign out securely"}
          </button>
        </footer>
      </main>
    );
  }

  function renderSettingsContent() {
    return (
      <div className="settings-content">
        <section className="settings-section-region" id={settingsSectionIds.appearance} aria-labelledby={`${settingsSectionIds.appearance}-heading`}>
          <h2 id={`${settingsSectionIds.appearance}-heading`} tabIndex={-1}>Appearance</h2>
          <section>
            <div className="setting-heading"><h3>Theme</h3><p>Each pack is a complete, self-contained sky — pick the one that matches your household.</p></div>
            <div className="theme-pack-list">
              {themePacks.map((pack) => (
                <button className={theme === pack ? "active" : ""} key={pack} onClick={() => updateAppearance({ theme: pack })}>
                  <span className="theme-swatches">{themePackInfo[pack].swatches.map((swatch, index) => <i key={`${pack}-${index}`} style={{ backgroundColor: swatch }} />)}</span>
                  <span><strong>{themePackInfo[pack].name}</strong><small>{themePackInfo[pack].description}</small></span>
                  <b>{theme === pack ? "✓" : ""}</b>
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
        </section>

        <section className="settings-section-region" id={settingsSectionIds.data} aria-labelledby={`${settingsSectionIds.data}-heading`}>
          <h2 id={`${settingsSectionIds.data}-heading`} tabIndex={-1}>Your data</h2>
          <PortableArchiveManager householdId={household.id} csrfToken={session.csrfToken} />
        </section>

        <section className="settings-section-region" id={settingsSectionIds.inbox} aria-labelledby={`${settingsSectionIds.inbox}-heading`}>
          <h2 id={`${settingsSectionIds.inbox}-heading`} tabIndex={-1}>Inbox</h2>
          <ImapInbox csrfToken={session.csrfToken} />
        </section>

        {workspace.recoverableHouseholds.length > 0 && (
          <section className="settings-section-region" id={settingsSectionIds.recovery} aria-labelledby={`${settingsSectionIds.recovery}-heading`}>
            <h2 id={`${settingsSectionIds.recovery}-heading`} tabIndex={-1}>Removed</h2>
            <HouseholdRecovery households={workspace.recoverableHouseholds} csrfToken={session.csrfToken} isInstanceAdmin={session.user.isInstanceAdmin} />
          </section>
        )}

        {household.canManage && (
          <section className="settings-section-region" id={settingsSectionIds.household} aria-labelledby={`${settingsSectionIds.household}-heading`}>
            <h2 id={`${settingsSectionIds.household}-heading`} tabIndex={-1}>Household</h2>
            <HouseholdSettings
              key={household.id}
              household={household}
              onSave={updateHousehold}
              onRemoved={() => router.replace(settingsExitTarget())}
              csrfToken={session.csrfToken}
            />
          </section>
        )}

        {household.canManage && (
          <section className="settings-section-region" id={settingsSectionIds.sections} aria-labelledby={`${settingsSectionIds.sections}-heading`}>
            <h2 id={`${settingsSectionIds.sections}-heading`} tabIndex={-1}>Sections</h2>
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
                          <SectionNameField
                            name={section.name}
                            ariaLabel={`Name for ${section.name}`}
                            onCommit={(name) => updateSections(sections.map((entry) => entry.id === section.id ? { ...entry, name } : entry))}
                          />
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
          </section>
        )}

        <section className="settings-section-region" id={settingsSectionIds.members} aria-labelledby={`${settingsSectionIds.members}-heading`}>
          <h2 id={`${settingsSectionIds.members}-heading`} tabIndex={-1}>Members</h2>
          <MemberManager householdId={household.id} session={session} refreshWorkspace={refreshWorkspace} />
        </section>
      </div>
    );
  }

  return (
    <div
      className="app-frame"
      data-theme={theme}
      data-text-size={textSize}
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
          <button className="nav-item" onClick={() => { navigateToSettings(); setMenuOpen(false); }}><Icon name="settings" /><span>Personalise</span></button>
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
          <AccountMenu
            displayName={session.user.displayName}
            initials={householdInitials(session.user.displayName)}
            isInstanceAdmin={session.user.isInstanceAdmin}
            onSettings={navigateToSettings}
            onAdministration={() => router.push("/admin")}
            onSignOut={() => { void handleSignOut(); }}
            logoutBusy={logoutBusy}
          />
          <button className="add-button" onClick={openNewItem}><Icon name="plus" /> Add item</button>
        </header>

        {syncStatus === "error" && syncMessage && (
          <div className="sync-error-banner" role="alert">{syncMessage}</div>
        )}

        <section className="content">
          {activeSection === "all" && !archiveMode ? (
            // Issue #327: "Due next" is the v19 hero-sky experience — the
            // full-viewport dial and grouped, reveal-on-scroll manifest.
            // Every other view (a section, or the archive) keeps the
            // plain hero-panel + flat list below, unchanged.
            <HeroSky
              items={visibleItems}
              listedItemsLength={listedItems.length}
              sections={sections}
              today={today}
              householdName={household.name}
              query={query}
              onQueryChange={setQuery}
              itemFilter={itemFilter}
              onItemFilterChange={setItemFilter}
              onOpenItem={openItem}
              onAddItem={openNewItem}
            />
          ) : (
            <>
              <div className="overview-grid">
                <article className="hero-panel">
                  <div className="hero-copy">
                    <p className="eyebrow">{archiveMode ? "Household history" : "Your things"}</p>
                    <h1>{archiveMode ? <>Past, but<br />not <em>lost.</em></> : currentSection?.name ?? "Section"}</h1>
                    <p>{archiveMode ? "Cancelled and archived records stay safely out of the way until you need them." : `${visibleItems.length} ${visibleItems.length === 1 ? "item" : "items"} in this section.`}</p>
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
                  <div><p className="section-number">02</p><h2>{archiveMode ? "Archive & cancelled" : `All ${(currentSection?.name ?? "items").toLowerCase()}`}</h2></div>
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
                  {visibleItems.map((item, index) => (
                    <ItemRow key={item.id} item={item} index={index} today={today} sections={sections} archiveMode={archiveMode} onOpen={openItem} />
                  ))}
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
            </>
          )}
        </section>
      </main>

      {menuOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}

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
