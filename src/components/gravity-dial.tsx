"use client";

import { memo, useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import {
  computeBodyGeometry,
  describeDaysRemaining,
  describeOrbitArc,
  DIAL_CENTER,
  DIAL_VIEWBOX,
  monthCompassLabels,
  polarPoint,
  RING,
  SUN_CORE_RADIUS,
  SUN_GLOW_RADIUS,
  type DialCostBand,
} from "@/lib/dial-geometry";

/**
 * The gravity-well dial (issue #326, spec: v19 — design/v19/home.html,
 * design/polish-register.md). This is the SVG chart only: the
 * manifest list remains the accessible source of truth (CON-5 / the v19
 * aria-label), and the hover callout is #327's concern — this component
 * only reports hover via `onBodyHover` for a host to render one.
 */

export type DialItemType = "service" | "renewal" | "inspection" | "suggestion";
export type DialItemStatus = "overdue" | "soon" | "upcoming" | "ok";

export interface DialItem {
  id: string;
  title: string;
  /** ISO calendar date, YYYY-MM-DD. */
  dueDate: string;
  costBand: DialCostBand;
  type: DialItemType;
  status: DialItemStatus;
  /** Number of attached documents; a belt (CON-1) renders when > 0. */
  documents?: number;
}

export interface GravityDialProps {
  items: DialItem[];
  /** ISO calendar date, YYYY-MM-DD; defaults to the real current date (UTC). */
  today?: string;
  householdName?: string;
  /** Id of the manifest list (or other element) that describes this dial. */
  ariaDescribedBy?: string;
  onBodyClick?: (item: DialItem) => void;
  onBodyHover?: (item: DialItem | null) => void;
  className?: string;
}

const MATERIAL_BY_STATUS: Record<DialItemStatus, string> = {
  overdue: "url(#p-ruby)",
  soon: "url(#p-amber)",
  upcoming: "url(#p-sky)",
  ok: "url(#p-jade)",
};

/** POL-2 pings and decay trails read for anything short of "ok". */
function isUrgent(status: DialItemStatus): boolean {
  return status !== "ok";
}

/** POL-2: perihelion ping — once a body is overdue or due very soon. */
function pingsForStatus(status: DialItemStatus): boolean {
  return status === "overdue" || status === "soon";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    onChange();
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

function Body({
  item,
  today,
  reducedMotion,
  onClick,
  onHover,
}: {
  item: DialItem;
  today: string;
  reducedMotion: boolean;
  onClick?: (item: DialItem) => void;
  onHover?: (item: DialItem | null) => void;
}) {
  const geometry = computeBodyGeometry(item, today);
  const hollow = item.type === "suggestion";
  const material = MATERIAL_BY_STATUS[item.status];
  const label = `${item.title}, ${describeDaysRemaining(geometry.daysRemaining)}`;
  const hasBelt = Boolean(item.documents && item.documents > 0);
  const showPing = pingsForStatus(item.status) && !reducedMotion;
  const showTrail = isUrgent(item.status);
  const breatheClass = reducedMotion ? "" : " breathe";

  const handleClick = () => onClick?.(item);
  const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick?.(item);
    }
  };

  const trailPath = showTrail
    ? describeOrbitArc(geometry.orbitRadius, geometry.angleDeg - 7, geometry.angleDeg - 1.5)
    : null;

  return (
    <g data-body={item.id} data-status={item.status}>
      {trailPath ? (
        <path
          d={trailPath}
          fill="none"
          stroke={`var(--${item.status === "overdue" ? "overdue" : item.status === "soon" ? "warm" : "upcoming"})`}
          strokeOpacity={0.5}
          strokeWidth={2}
          strokeLinecap="round"
          aria-hidden="true"
          className="decay-trail"
        />
      ) : null}

      {hasBelt ? (
        <ellipse
          className="belt"
          aria-hidden="true"
          cx={geometry.x}
          cy={geometry.y}
          rx={geometry.bodyRadius * 2.1}
          ry={geometry.bodyRadius * 0.7}
          transform={`rotate(-24 ${geometry.x} ${geometry.y})`}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.3}
          opacity={0.8}
        />
      ) : null}

      {showPing ? (
        <circle
          className="ping"
          aria-hidden="true"
          cx={geometry.x}
          cy={geometry.y}
          r={geometry.bodyRadius}
          fill="none"
          stroke="var(--overdue)"
        />
      ) : null}

      {/* CON-5: exactly one clickable thing per body — the planet itself. */}
      <g
        className={`body${breatheClass}`}
        role="button"
        tabIndex={0}
        aria-label={label}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onMouseEnter={() => onHover?.(item)}
        onMouseLeave={() => onHover?.(null)}
        onFocus={() => onHover?.(item)}
        onBlur={() => onHover?.(null)}
      >
        {hollow ? (
          <>
            <circle cx={geometry.x} cy={geometry.y} r={geometry.bodyRadius} fill="var(--accent)" opacity={0.12} />
            <circle
              cx={geometry.x}
              cy={geometry.y}
              r={geometry.bodyRadius}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.8}
            />
          </>
        ) : item.type === "renewal" ? (
          <>
            <circle cx={geometry.x} cy={geometry.y} r={geometry.bodyRadius * 0.52} fill={material} />
            <circle cx={geometry.x} cy={geometry.y} r={geometry.bodyRadius * 0.34} fill="var(--panel-raised)" />
            <circle cx={geometry.x} cy={geometry.y} r={geometry.bodyRadius * 0.24} fill={material} />
          </>
        ) : item.type === "inspection" ? (
          <>
            <circle
              cx={geometry.x}
              cy={geometry.y}
              r={geometry.bodyRadius}
              fill={material}
              stroke="var(--bg)"
              strokeWidth={2}
            />
            <path
              d={`M ${geometry.x} ${geometry.y - geometry.bodyRadius} A ${geometry.bodyRadius} ${geometry.bodyRadius} 0 0 1 ${geometry.x} ${geometry.y + geometry.bodyRadius} Z`}
              fill="rgba(0,0,0,.42)"
            />
          </>
        ) : (
          <>
            <circle
              cx={geometry.x}
              cy={geometry.y}
              r={geometry.bodyRadius}
              fill={material}
              stroke="var(--bg)"
              strokeWidth={2}
            />
            <circle
              cx={geometry.x - geometry.bodyRadius * 0.22}
              cy={geometry.y - geometry.bodyRadius * 0.26}
              r={geometry.bodyRadius * 0.32}
              fill="rgba(255,255,255,.38)"
            />
          </>
        )}
      </g>
    </g>
  );
}

// Memoized (issue #383): each hover event re-rendered every orbiting body via
// this component even though its own props (the item list, today, callbacks)
// hadn't changed — React.memo skips that as long as callers pass stable
// props (see hero-sky.tsx's useCallback-wrapped hover/click handlers).
export const GravityDial = memo(function GravityDial({
  items,
  today,
  householdName,
  ariaDescribedBy,
  onBodyClick,
  onBodyHover,
  className,
}: GravityDialProps) {
  const reactId = useId().replace(/:/g, "");
  const resolvedToday = today ?? todayIso();
  const reducedMotion = usePrefersReducedMotion();
  const months = useMemo(() => monthCompassLabels(resolvedToday), [resolvedToday]);

  const rotorTicks = useMemo(
    () =>
      Array.from({ length: 8 }, (_, i) => {
        const angle = i * 45;
        const inner = polarPoint(14, angle);
        const outer = polarPoint(34, angle);
        return { key: angle, inner, outer };
      }),
    [],
  );

  const monthTicks = useMemo(
    () =>
      months.map((label, i) => {
        const angle = i * 30;
        const inner = polarPoint(RING.outer - 7, angle);
        const outer = polarPoint(RING.outer, angle);
        const textPoint = polarPoint(159, angle);
        return { label, angle, inner, outer, textPoint, isNow: i === 0 };
      }),
    [months],
  );

  return (
    <div className={`gravity-dial${className ? ` ${className}` : ""}`}>
      <style>{`
        .gravity-dial svg.dial{transform-origin:50% 50%;animation:gd-arrive 1s cubic-bezier(.2,.7,.2,1) 1}
        @keyframes gd-arrive{from{transform:scale(.16);opacity:0}60%{opacity:1}to{transform:scale(1)}}
        .gravity-dial .rotor{transform-origin:${DIAL_CENTER}px ${DIAL_CENTER}px;animation:gd-rotor 160s linear infinite}
        @keyframes gd-rotor{from{transform:rotate(0)}to{transform:rotate(360deg)}}
        .gravity-dial .breathe{animation:gd-breathe 4.2s ease-in-out infinite}
        @keyframes gd-breathe{0%,100%{opacity:1}50%{opacity:.55}}
        .gravity-dial .ping{animation:gd-ping 3.4s ease-out infinite;transform-origin:center;transform-box:fill-box}
        @keyframes gd-ping{0%{transform:scale(.6);stroke-opacity:.7}70%{transform:scale(3.2);stroke-opacity:0}100%{stroke-opacity:0}}
        .gravity-dial .now-month{fill:var(--accent);font-weight:600}
        .gravity-dial .body{cursor:pointer;transition:transform .25s;transform-origin:center;transform-box:fill-box}
        .gravity-dial .body:hover,.gravity-dial .body:focus-visible{transform:scale(1.5)}
        .gravity-dial .body:focus-visible{outline:none}
        @media (prefers-reduced-motion: reduce){
          .gravity-dial svg.dial,.gravity-dial .rotor,.gravity-dial .breathe,.gravity-dial .ping{animation:none!important}
        }
      `}</style>
      <svg
        className="dial"
        width={640}
        height={640}
        viewBox={`0 0 ${DIAL_VIEWBOX} ${DIAL_VIEWBOX}`}
        role="img"
        aria-label="Gravity well: items orbit by due date; distance from the household is time remaining, body size is typical cost; details in the manifest below"
        aria-describedby={ariaDescribedBy}
      >
        <defs>
          <filter id={`${reactId}-soft`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
          <filter id={`${reactId}-sun`} x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
          {/* POL-14: the four planet materials are the one deliberate
              exception to token-only colour — they are meant to read the
              same regardless of the active theme pack. */}
          <radialGradient id="p-ruby" cx="34%" cy="30%" r="72%">
            <stop offset="0%" stopColor="#ffb3ab" /><stop offset="42%" stopColor="#e0453e" />
            <stop offset="100%" stopColor="#7e1a1f" />
          </radialGradient>
          <radialGradient id="p-jade" cx="34%" cy="30%" r="72%">
            <stop offset="0%" stopColor="#b8f5cf" /><stop offset="45%" stopColor="#2fae6a" />
            <stop offset="100%" stopColor="#12603a" />
          </radialGradient>
          <radialGradient id="p-amber" cx="34%" cy="30%" r="72%">
            <stop offset="0%" stopColor="#ffe1a0" /><stop offset="45%" stopColor="#f0a52b" />
            <stop offset="100%" stopColor="#8a5a10" />
          </radialGradient>
          <radialGradient id="p-sky" cx="34%" cy="30%" r="72%">
            <stop offset="0%" stopColor="#cfe4ff" /><stop offset="45%" stopColor="#6fa3ef" />
            <stop offset="100%" stopColor="#2a4f8f" />
          </radialGradient>
          <radialGradient id={`${reactId}-danger`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" style={{ stopColor: "var(--overdue)", stopOpacity: 0.1 }} />
            <stop offset="55%" style={{ stopColor: "var(--overdue)", stopOpacity: 0.035 }} />
            <stop offset="85%" style={{ stopColor: "var(--overdue)", stopOpacity: 0 }} />
          </radialGradient>
        </defs>

        <g className="chrome">
          {/* decorative background compass ring — rotates slowly, never
              carries information (the real month ticks below are static) */}
          <g className={reducedMotion ? undefined : "rotor"}>
            <g stroke="var(--chart-line-soft)" strokeWidth={0.5}>
              {rotorTicks.map(({ key, inner, outer }) => (
                <line key={key} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />
              ))}
            </g>
            <circle cx={DIAL_CENTER} cy={DIAL_CENTER} r={168} fill="none" stroke="var(--chart-line-soft)" strokeWidth={0.5} />
          </g>

          {/* POL-8: the danger well threshold — dashed perihelion ring */}
          <circle cx={DIAL_CENTER} cy={DIAL_CENTER} r={RING.threshold} fill={`url(#${reactId}-danger)`} />
          <circle
            cx={DIAL_CENTER}
            cy={DIAL_CENTER}
            r={RING.threshold}
            fill="none"
            stroke="var(--overdue)"
            strokeOpacity={0.3}
            strokeWidth={1}
            strokeDasharray="3 5"
          />
          <circle cx={DIAL_CENTER} cy={DIAL_CENTER} r={RING.mid} fill="none" stroke="var(--chart-line-soft)" strokeWidth={0.75} />
          <circle cx={DIAL_CENTER} cy={DIAL_CENTER} r={RING.outer} fill="none" stroke="var(--chart-line)" strokeWidth={1.5} />

          {/* the month compass — static, never rotates */}
          <g stroke="var(--chart-line)" strokeWidth={1.5}>
            {monthTicks.map(({ angle, inner, outer }) => (
              <line key={angle} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />
            ))}
          </g>
          <g fontSize={9} fill="var(--chart-ink)" textAnchor="middle">
            {monthTicks.map(({ label, angle, textPoint, isNow }) => (
              <text
                key={angle}
                x={textPoint.x}
                y={textPoint.y}
                // POL-3: the present month reads a shade brighter
                className={isNow ? "now-month" : undefined}
                data-polish={isNow ? "POL-3" : undefined}
              >
                {label}
              </text>
            ))}
          </g>
          {/* "now" pointer, always at 12 o'clock */}
          <path d={`M ${DIAL_CENTER} 38 l5.5 9 h-11 Z`} style={{ fill: "var(--accent)" }} />
        </g>

        <circle
          cx={DIAL_CENTER}
          cy={DIAL_CENTER}
          r={SUN_GLOW_RADIUS}
          style={{ fill: "var(--sun)" }}
          filter={`url(#${reactId}-sun)`}
          opacity={0.8}
        />
        <circle cx={DIAL_CENTER} cy={DIAL_CENTER} r={SUN_CORE_RADIUS} style={{ fill: "var(--sun-core)" }} />
        {householdName ? (
          <text
            x={DIAL_CENTER}
            y={DIAL_CENTER + 22}
            fontSize={10}
            fill="var(--ink-mid)"
            textAnchor="middle"
            style={{ fontFamily: "var(--ui)" }}
          >
            {householdName}
          </text>
        ) : null}

        {items.map((item) => (
          <Body
            key={item.id}
            item={item}
            today={resolvedToday}
            reducedMotion={reducedMotion}
            onClick={onBodyClick}
            onHover={onBodyHover}
          />
        ))}
      </svg>
    </div>
  );
});
