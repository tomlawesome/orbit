"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dueCopy as dashboardDueCopy, formatCost, formatLongDate } from "@/components/dashboard-utils";
import { GravityDial, type DialItem } from "@/components/gravity-dial";
import { Icon } from "@/components/icons";
import { Starfield } from "@/components/starfield";
import { buildDialItems, calloutPlacementForBody, formatTMinus, type CalloutPlacement } from "@/lib/dial-adapter";
import { daysUntil, getDueBand, type HomeItem, type HouseholdSection } from "@/lib/domain";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

/**
 * The v19 hero-sky home (issue #327, spec: docs/design/v19/home.html,
 * docs/design/polish-register.md). Composes the full-viewport gravity
 * dial (#326) over a drifting starfield (POL-11), an "explore your
 * world" search, and — on a single scrolling page, no route change — the
 * grouped, reveal-on-scroll manifest that remains the accessible source
 * of truth (every dial body has a matching row here; nothing lives on
 * the chart alone).
 *
 * Deliberately out of scope for this slice (tracked as follow-ups, not
 * implemented): the galaxy / multi-household flight camera (CON-13),
 * the status/key drawers (CON-7), the north-star create drawer (CON-12),
 * and the quiet/storm chart moods (POL-8/POL-10). The manifest's
 * `.item-card` markup and `Open {title}` action are shared verbatim with
 * the non-"Due next" views so this stays additive over the existing
 * accepted item lifecycle.
 */

export type ItemFilter = "all" | "attention" | "unscheduled";

export interface ItemRowProps {
  item: HomeItem;
  index: number;
  today: string;
  sections: HouseholdSection[];
  archiveMode: boolean;
  highlighted?: boolean;
  showTMinus?: boolean;
  onOpen: (item: HomeItem) => void;
}

/**
 * One manifest row. Shared by the hero-sky grouped manifest and the
 * plain flat list used for section/archive views, so there is exactly
 * one place that decides what an item row says and one accessible
 * "Open {title}" action e2e/acceptance coverage can rely on either way.
 */
export const ItemRow = memo(function ItemRow({ item, index, today, sections, archiveMode, highlighted, showTMinus, onOpen }: ItemRowProps) {
  const dueBand = getDueBand(item.dueDate, today);
  const displayState = archiveMode ? item.status : dueBand;
  const itemSection = sections.find((section) => section.id === item.sectionId);
  const tMinus = showTMinus && !archiveMode && item.dueDate ? formatTMinus(daysUntil(item.dueDate, today)) : null;
  return (
    <article
      id={`manifest-item-${item.id}`}
      className={`item-card${archiveMode ? "" : ` due-band-${dueBand}`}${highlighted ? " dial-target" : ""}`}
    >
      <span className="row-number">{String(index + 1).padStart(2, "0")}</span>
      <span className={`category-icon type-icon-${itemSection?.icon ?? "calendar"} accent-${itemSection?.accent ?? "sage"}`}>
        <Icon name={itemSection?.icon ?? "calendar"} />
      </span>
      <button className="item-main" onClick={() => onOpen(item)}>
        <div className="item-title-row">
          <h3>{item.title}</h3>
          <span className={`status status-${displayState}`}>
            {archiveMode ? displayState : dashboardDueCopy(item, today, daysUntil)}
          </span>
        </div>
        <p>
          <b>{item.subtype ?? itemSection?.name ?? "Household item"}</b>
          <span>
            {item.provider ?? "No provider"}
            {item.reference ? ` · ${item.reference}` : ""}
            {item.recurrenceMonths ? ` · every ${item.recurrenceMonths === 12 ? "year" : `${item.recurrenceMonths} months`}` : ""}
            {tMinus ? ` · ${tMinus}` : ""}
          </span>
        </p>
      </button>
      <div className="item-meta">
        <strong>{formatCost(item)}</strong>
        <small>{item.dueDate ? formatLongDate(item.dueDate) : "Add a schedule"}</small>
      </div>
      <button className="more-button" aria-label={`Open ${item.title}`} onClick={() => onOpen(item)}><Icon name="chevron" /></button>
    </article>
  );
});

interface ManifestGroup {
  key: string;
  label: string;
  hint?: string;
  items: HomeItem[];
}

/** Groups an already due-date-sorted item list into the v19 manifest sections. */
function buildManifestGroups(items: HomeItem[], today: string): ManifestGroup[] {
  const attention: HomeItem[] = [];
  const later: HomeItem[] = [];
  const unscheduled: HomeItem[] = [];
  for (const item of items) {
    const band = getDueBand(item.dueDate, today);
    if (band === "overdue" || band === "week") attention.push(item);
    else if (band === "unscheduled") unscheduled.push(item);
    else later.push(item);
  }
  const groups: ManifestGroup[] = [];
  if (attention.length > 0) {
    const closest = attention[0];
    groups.push({
      key: "attention",
      label: "Needs attention",
      hint: closest.dueDate ? `closest approach — ${closest.title} · ${formatTMinus(daysUntil(closest.dueDate, today))}` : undefined,
      items: attention,
    });
  }
  if (later.length > 0) groups.push({ key: "later", label: "Later this year", items: later });
  if (unscheduled.length > 0) groups.push({ key: "unscheduled", label: "Unscheduled", items: unscheduled });
  return groups;
}

/**
 * Reveal-on-scroll (v19 `.group`/`.group.seen`): starts each manifest
 * group faded/offset and settles it in once it crosses the viewport.
 * Falls back to already-visible when `IntersectionObserver` doesn't
 * exist (old browser, or a test environment) — the manifest must never
 * depend on the observer firing to be readable.
 */
function RevealGroup({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // No IntersectionObserver (old browser, or a test environment): start
  // already "seen" via the lazy initializer, rather than flipping it in
  // an effect — the manifest must never depend on the observer firing.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (seen) return;
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) setSeen(true);
    }, { threshold: 0.15 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);

  return (
    <div ref={ref} className={`group${seen ? " seen" : ""}`}>
      <h3>{label}{hint ? <span className="closest"> · {hint}</span> : null}</h3>
      {children}
    </div>
  );
}

export interface HeroSkyProps {
  /** The already section/search/filter-scoped, due-date-sorted item list — the manifest's source of truth. */
  items: HomeItem[];
  /** Total items in the current list before search/filter narrowed it, for empty-state copy. */
  listedItemsLength: number;
  sections: HouseholdSection[];
  today: string;
  householdName: string;
  query: string;
  onQueryChange: (value: string) => void;
  itemFilter: ItemFilter;
  onItemFilterChange: (filter: ItemFilter) => void;
  onOpenItem: (item: HomeItem) => void;
  onAddItem: () => void;
}

export function HeroSky({
  items,
  listedItemsLength,
  sections,
  today,
  householdName,
  query,
  onQueryChange,
  itemFilter,
  onItemFilterChange,
  onOpenItem,
  onAddItem,
}: HeroSkyProps) {
  const reducedMotion = usePrefersReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const manifestRef = useRef<HTMLElement>(null);
  const [hovered, setHovered] = useState<DialItem | null>(null);
  const [placement, setPlacement] = useState<CalloutPlacement | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const dialItems = useMemo(() => buildDialItems(items, today), [items, today]);
  const groups = useMemo(() => buildManifestGroups(items, today), [items, today]);
  const manifestHeadingId = "hero-sky-manifest-heading";

  // Measured synchronously inside the hover event itself (not an effect):
  // `onBodyHover` fires from GravityDial's own React event handlers, so
  // there is a real DOM to measure right here, and setting both `hovered`
  // and `placement` together avoids an extra render between "who" and
  // "where" that a `useEffect` round-trip would otherwise introduce.
  //
  // useCallback (issue #383): GravityDial is memoized, so a stable handler
  // identity is required for that memo to actually skip re-rendering every
  // orbiting body on each hover — a freshly-created closure every render
  // would defeat React.memo's prop comparison.
  const handleBodyHover = useCallback((item: DialItem | null) => {
    setHovered(item);
    if (!item) {
      setPlacement(null);
      return;
    }
    const stage = stageRef.current;
    if (!stage || typeof window === "undefined") {
      setPlacement(null);
      return;
    }
    const escapedId = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(item.id) : item.id;
    const bodyEl = stage.querySelector(`[data-body="${escapedId}"]`);
    const dialEl = stage.querySelector("svg.dial");
    if (!bodyEl || !dialEl) {
      setPlacement(null);
      return;
    }
    const bodyRect = bodyEl.getBoundingClientRect();
    const dialRect = dialEl.getBoundingClientRect();
    setPlacement(calloutPlacementForBody(bodyRect, dialRect, window.innerWidth));
  }, []);

  useEffect(() => {
    if (!highlightedId) return;
    const timer = window.setTimeout(() => setHighlightedId(null), 4000);
    return () => window.clearTimeout(timer);
  }, [highlightedId]);

  const handleBodyClick = useCallback((item: DialItem) => {
    setHighlightedId(item.id);
    const target = manifestRef.current?.querySelector(`#manifest-item-${item.id}`);
    target?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  }, [reducedMotion]);

  const hoveredHomeItem = hovered ? items.find((item) => item.id === hovered.id) : undefined;
  const hoveredTMinus = hovered ? formatTMinus(daysUntil(hovered.dueDate, today)) : null;

  return (
    <div className="hero-sky">
      <style>{`
        .hero-sky{position:relative;isolation:isolate;overflow:hidden;
          border-radius:24px 8px 24px 24px;background:var(--bg);
          display:flex;flex-direction:column;align-items:center;
          padding:0 0 8px}
        .hero-sky-stage{position:relative;z-index:2;width:100%;min-height:min(880px,90vh);
          display:flex;flex-direction:column;align-items:center;justify-content:center;
          gap:14px;padding:24px 0}
        .hero-sky-stage .gravity-dial svg.dial{width:min(640px,58vw,72vh);height:min(640px,58vw,72vh)}
        .hero-sky-foot{display:flex;flex-direction:column;align-items:center;gap:12px}
        .hero-sky-search{position:relative}
        .hero-sky-search input{background:none;border:0;outline:0;
          border-bottom:1px solid var(--line);width:300px;max-width:70vw;text-align:center;
          font:12.5px var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
          color:var(--ink);padding:6px 4px;transition:border-color .25s}
        .hero-sky-search input::placeholder{color:var(--ink-faint)}
        .hero-sky-search input:focus{border-color:var(--accent)}
        .hero-sky-scrollcue{font:11px var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
          color:var(--ink-faint);letter-spacing:.14em;text-align:center;margin:0}
        .callout{position:fixed;z-index:8;pointer-events:none;opacity:0;transition:opacity .12s;
          background:var(--panel-raised);backdrop-filter:blur(12px);border:1px solid var(--line);
          border-radius:10px;padding:9px 13px;font:13.5px var(--ui,system-ui);color:var(--ink);
          white-space:nowrap}
        .callout.show{opacity:1}
        .callout .line{position:absolute;top:50%;width:26px;height:1px;background:var(--accent);opacity:.85}
        .callout.side-right .line{left:-27px}
        .callout.side-left .line{right:-27px}
        .callout b{display:block;font-weight:600;font-size:13.5px}
        .callout small{font:11.5px var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:var(--ink-mid)}
        .callout .chip{display:block;margin-top:7px;font:11px var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
          color:var(--accent);border:1px solid var(--line);border-radius:99px;padding:3px 10px;
          cursor:pointer;background:none;pointer-events:auto}
        .callout .chip:hover{border-color:var(--accent)}
        .hero-sky-manifest{position:relative;z-index:2;width:100%;max-width:820px;margin:0 auto;padding:0 16px 6px}
        .hero-sky-manifest .list-heading{padding:0 0 15px}
        .group{margin-bottom:26px;opacity:0;transform:translateY(26px);
          transition:opacity .7s ease,transform .7s ease}
        .group.seen{opacity:1;transform:none}
        .group h3{font:10.5px var(--mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
          letter-spacing:.18em;text-transform:uppercase;color:var(--ink-faint);margin:0 0 10px;padding-left:4px}
        .group h3 .closest{color:var(--warm);text-transform:none;letter-spacing:.04em}
        .item-card.dial-target{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
        @media (prefers-reduced-motion: reduce){
          .group{opacity:1;transform:none;transition:none}
        }
      `}</style>
      <noscript>
        <style>{`.hero-sky-stage,.callout{display:none!important}.group{opacity:1!important;transform:none!important}`}</style>
      </noscript>

      {/* v19 keeps the sky itself wordless (CON-4: no loud headline over the
          chart) — the page's one h1 is present for the document outline and
          screen readers without changing what's visually on screen. */}
      <h1 className="visually-hidden">{householdName} — due next</h1>

      <Starfield />

      <div className="hero-sky-stage" ref={stageRef}>
        <GravityDial
          items={dialItems}
          today={today}
          householdName={householdName}
          ariaDescribedBy={manifestHeadingId}
          onBodyClick={handleBodyClick}
          onBodyHover={handleBodyHover}
        />
        <div className="hero-sky-foot">
          <div className="hero-sky-search">
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="explore your world"
              aria-label="Search items and documents"
            />
          </div>
          <p className="hero-sky-scrollcue" aria-hidden="true">↓ due next</p>
        </div>
      </div>

      <div
        className={`callout${placement ? " show" : ""}${placement ? ` side-${placement.side}` : ""}`}
        style={placement ? { top: placement.top, left: placement.left, right: placement.right } : undefined}
        role="status"
      >
        {hovered ? (
          <>
            <span className="line" aria-hidden="true" />
            <b>{hovered.title}</b>
            <small>{hoveredTMinus} · {hoveredHomeItem ? formatCost(hoveredHomeItem) : ""}</small>
            {hovered.documents ? (
              <button type="button" className="chip">{"◆"} {hovered.documents} documents</button>
            ) : null}
          </>
        ) : null}
      </div>

      <section className="hero-sky-manifest" ref={manifestRef} aria-label={`${householdName} due next`}>
        <div className="list-heading">
          <div><p className="section-number">02</p><h2 id={manifestHeadingId}>Coming up</h2></div>
          <div className="list-actions">
            <span>{items.length} items</span>
            <select aria-label="Filter items" value={itemFilter} onChange={(event) => onItemFilterChange(event.target.value as ItemFilter)}>
              <option value="all">All items</option>
              <option value="attention">Needs attention</option>
              <option value="unscheduled">Unscheduled</option>
            </select>
            <button className="mobile-add" aria-label="Add item" onClick={onAddItem}><Icon name="plus" /></button>
          </div>
        </div>

        {groups.map((group) => (
          <RevealGroup key={group.key} label={group.label} hint={group.hint}>
            {group.items.map((item, index) => (
              <ItemRow
                key={item.id}
                item={item}
                index={index}
                today={today}
                sections={sections}
                archiveMode={false}
                highlighted={item.id === highlightedId}
                showTMinus
                onOpen={onOpenItem}
              />
            ))}
          </RevealGroup>
        ))}

        {items.length === 0 && (
          <div className="empty-state">
            <span><Icon name={listedItemsLength ? "search" : "plus"} /></span>
            <h3>{listedItemsLength ? "No matching items" : `Start shaping ${householdName}`}</h3>
            <p>{listedItemsLength ? "Try another search, section, or filter." : "Add the first renewal, service, contract, or household record."}</p>
            {!listedItemsLength && <button onClick={onAddItem}>Add your first item</button>}
          </div>
        )}
      </section>
    </div>
  );
}
