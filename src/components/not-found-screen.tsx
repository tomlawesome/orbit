"use client";

import Link from "next/link";
import { FamilyScreen } from "@/components/family-screen";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

/**
 * The not-found screen (design/family/404.html, "off the chart").
 *
 * Chosen over the three alternates for the reasons recorded in the commit
 * message: it is the only one of the four whose meaning survives outside
 * its artwork — a real heading, a reassuring second line and one obvious
 * way home — while the giant numerals and the tumbling derelict stay
 * decorative behind it. The others carry their message inside enormous
 * fixed-coordinate SVG scenes that neither reflow nor re-theme.
 *
 * Like every family screen it is content-free: a visitor who lands on a
 * mistyped household or document URL learns only that the page is not
 * there, never whether it exists.
 */
export function NotFoundScreen() {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <FamilyScreen phase="none" ribbon="404 · Off the chart">
      <div className={`family-adrift${reducedMotion ? " still" : ""}`} aria-hidden="true">
        <p className="family-numerals">404</p>
        <div className="family-derelict">
          <svg width="230" height="70" viewBox="0 0 230 70" focusable="false">
            <path
              className="family-derelict-trail"
              d="M -180 46 C -90 20 -30 54 16 30"
              fill="none"
              stroke="var(--ink-faint)"
              strokeWidth="1.5"
            />
            <g className="family-derelict-hull">
              <circle cx="26" cy="26" r="13" fill="var(--family-limb)" />
              <circle cx="21" cy="21" r="4" fill="var(--ink-mid)" opacity=".45" />
              <ellipse
                cx="26"
                cy="26"
                rx="22"
                ry="6.5"
                transform="rotate(-18 26 26)"
                fill="none"
                stroke="var(--ink-faint)"
                strokeWidth="1"
              />
            </g>
          </svg>
        </div>
      </div>

      <p className="family-eyebrow">Off the chart</p>
      <h1>This page has drifted off the chart</h1>
      <p className="family-message">But your sky is exactly where you left it.</p>
      <Link className="family-link" href="/">
        <span aria-hidden="true">↖ </span>Return to your orbit
      </Link>
    </FamilyScreen>
  );
}
