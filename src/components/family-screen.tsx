"use client";

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { PREFERENCE_EVENT, THEME_STORAGE_KEY } from "@/components/dashboard-utils";
import { Starfield } from "@/components/starfield";
import { themePreferenceSchema, type ThemePack } from "@/lib/preferences";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

/**
 * The shared surface for Orbit's "family" screens — everything either side
 * of the authenticated workspace: sign-in, signed-out, not-found, the
 * service-unavailable/maintenance state and the sign-in error page.
 * Spec: design/family/{login,logout,404,maintenance}.html over
 * design/family/family.css, continuous with design/v19/home.html.
 *
 * These screens are rendered to visitors Orbit knows nothing about, so they
 * carry no household data of any kind — only the mark, one sentence, and
 * one action. Everything they show is either a literal in this file or a
 * message handed in by the caller.
 */

const DEFAULT_PACK: ThemePack = "starchart";

/** The sky beneath the copy. `rise` is first light (sign in), `set` is the
 *  sun going down (signed out), `eclipse` is the sun occluded (Orbit could
 *  not open safely), `none` leaves the starfield alone (not found). */
export type FamilyPhase = "rise" | "set" | "eclipse" | "none";

/**
 * Resolves the stored appearance preference to a theme pack. Signed-out
 * visitors have no session to read a preference from, so the family screens
 * fall back to the default pack — but a returning member who chose Dawn and
 * signed out should not be thrown into a black screen on the way out, and
 * their pack is already in this browser's local storage from the
 * authenticated app (`components/appearance-preference.ts`).
 *
 * Exported for direct unit coverage; nothing but the hook below uses it.
 */
export function resolveFamilyThemePack(stored: string | null): ThemePack {
  if (!stored) return DEFAULT_PACK;
  try {
    const parsed = themePreferenceSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data.theme : DEFAULT_PACK;
  } catch {
    return DEFAULT_PACK;
  }
}

function readStoredTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Server-rendered markup always uses the default pack, so hydration is
 *  stable; `useSyncExternalStore` then re-renders with the stored pack. */
function serverTheme(): string | null {
  return null;
}

export function useFamilyThemePack(): ThemePack {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) onStoreChange();
    };
    const handlePreference = (event: Event) => {
      if ((event as CustomEvent<string>).detail === THEME_STORAGE_KEY) onStoreChange();
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(PREFERENCE_EVENT, handlePreference);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(PREFERENCE_EVENT, handlePreference);
    };
  }, []);
  return resolveFamilyThemePack(useSyncExternalStore(subscribe, readStoredTheme, serverTheme));
}

/** The Orbit mark, drawn from theme tokens so it reads on every pack.
 *  (`public/orbit-mark.svg` is a fixed-colour asset owned by the shell.) */
export function OrbitGlyph({ size = 46 }: { size?: number }) {
  return (
    <svg className="family-glyph" width={size} height={size} viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <circle cx="100" cy="100" r="72" fill="none" stroke="var(--ink-mid)" strokeWidth="9" />
      {/* --family-link, not raw --accent: the pack accents are tuned as
          line-work on their own surface and atlas's bronze only reaches
          2.76:1 there, under the 3:1 floor for a graphic. */}
      <circle cx="163" cy="63.5" r="20" fill="var(--family-link)" />
    </svg>
  );
}

/**
 * The limb of the world with the sun at it. Purely decorative: hidden
 * outright on packs that switch celestial art off (`--celestial: none`),
 * drawn from `--sun`/`--warm`/`--bg` on the packs that keep it, and never
 * placed behind the copy — the whole scene lives in the bottom band.
 *
 * The mockup's "first light" entrance (design/family/login.html) is a fade
 * from black rather than a loop; `usePrefersReducedMotion` skips straight
 * to the lit state when the visitor asks for less motion, and family.css
 * repeats that as a media query for the no-JS case.
 */
export function FamilyHorizon({ phase }: { phase: Exclude<FamilyPhase, "none"> }) {
  const reducedMotion = usePrefersReducedMotion();
  const [lit, setLit] = useState(false);

  // Under reduced motion the `.still` class holds the scene at full opacity
  // from the first frame, so this timer only ever drives the fade-in.
  useEffect(() => {
    const timer = window.setTimeout(() => setLit(true), reducedMotion ? 0 : 120);
    return () => window.clearTimeout(timer);
  }, [reducedMotion]);

  return (
    <div
      className={`family-horizon${lit ? " lit" : ""}${reducedMotion ? " still" : ""}`}
      data-phase={phase}
      aria-hidden="true"
    >
      <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" focusable="false">
        <defs>
          <radialGradient id="family-sun-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--sun)" stopOpacity=".9" />
            <stop offset="45%" stopColor="var(--sun)" stopOpacity=".45" />
            <stop offset="100%" stopColor="var(--sun)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="family-sun-wide" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--warm)" stopOpacity=".28" />
            <stop offset="55%" stopColor="var(--warm)" stopOpacity=".1" />
            <stop offset="100%" stopColor="var(--warm)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="family-ray" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--sun)" stopOpacity=".22" />
            <stop offset="60%" stopColor="var(--sun)" stopOpacity=".05" />
            <stop offset="100%" stopColor="var(--sun)" stopOpacity="0" />
          </linearGradient>
          <filter id="family-soft" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="18" />
          </filter>
          <filter id="family-rim-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>

        {/* Light beyond the limb, drawn first so the world occludes it. */}
        <g className="family-horizon-light">
          {phase === "rise" && (
            <g className="family-horizon-rays" filter="url(#family-soft)" fill="url(#family-ray)">
              <path d="M 800 924 L 736 356 L 776 364 Z" />
              <path d="M 800 924 L 856 512 L 896 536 Z" />
              <path d="M 800 924 L 512 616 L 560 584 Z" />
              <path d="M 800 924 L 1092 452 L 1048 428 Z" />
            </g>
          )}
          <circle cx="800" cy={phase === "set" ? 986 : 922} r="520" fill="url(#family-sun-wide)" />
          <circle cx="800" cy={phase === "set" ? 986 : 922} r="190" fill="url(#family-sun-core)" />
        </g>

        {/* The world: everything below the limb is night. */}
        <circle cx="800" cy="3920" r="3000" fill="var(--family-limb)" />
        <circle
          className="family-horizon-rim"
          cx="800"
          cy="3920"
          r="3000"
          fill="none"
          stroke={phase === "eclipse" ? "var(--degraded)" : "var(--sun)"}
          strokeWidth="8"
          strokeOpacity=".3"
          filter="url(#family-rim-glow)"
        />
        <circle
          className="family-horizon-rim"
          cx="800"
          cy="3920"
          r="3000"
          fill="none"
          stroke={phase === "eclipse" ? "var(--degraded)" : "var(--sun)"}
          strokeWidth="2.4"
          strokeOpacity={phase === "rise" ? ".85" : ".5"}
        />

        {/* Maintenance: the sun occluded, a thin corona still burning. */}
        {phase === "eclipse" && (
          <g className="family-horizon-eclipse">
            <circle cx="800" cy="806" r="230" fill="var(--warm)" opacity=".1" filter="url(#family-soft)" />
            <circle cx="800" cy="806" r="112" fill="var(--family-limb)" />
            <circle cx="800" cy="806" r="112" fill="none" stroke="var(--degraded)" strokeWidth="2" strokeOpacity=".75" />
            <circle cx="800" cy="806" r="118" fill="none" stroke="var(--warm)" strokeWidth="10" strokeOpacity=".18" filter="url(#family-rim-glow)" />
          </g>
        )}
      </svg>
    </div>
  );
}

export function FamilyScreen({
  phase = "rise",
  ribbon,
  children,
}: {
  phase?: FamilyPhase;
  ribbon: string;
  children: ReactNode;
}) {
  const pack = useFamilyThemePack();
  return (
    <div className="family-screen" data-theme={pack} data-phase={phase}>
      <div className="family-sky" aria-hidden="true">
        <Starfield />
        {phase === "none" ? null : <FamilyHorizon phase={phase} />}
      </div>
      <main className="family-stage">
        <p className="family-lockup">
          <OrbitGlyph />
          <span>orbit</span>
        </p>
        {children}
      </main>
      {/* A landmark, not a loose paragraph, so every word on these screens
          sits inside one. */}
      <footer className="family-ribbon">{ribbon}</footer>
    </div>
  );
}
