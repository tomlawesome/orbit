# ADR-0042: One layout switch: 840 px wide, 480 px tall

**Status:** Accepted (owner decision 45, design/owner-decisions.md §45)
**Date:** 2026-11-05
**Relates to:** #1382 (one layout switch); #1371 (door phone layout, decision 3c)

## Context

Orbit has two layouts, phone and desk. Two different rules chose between them:
the app switched at 900 px wide or 600 px tall, and the door at 600 px wide or
480 px tall (decision 3c, #1371). The same window could get the phone layout on
one screen and the desk layout on the next.

## Decision

1. **One rule.** The phone layout shows when the window is under 840 px wide or
   under 480 px tall. The desk layout shows otherwise.
   - Phone: `(max-width: 839.98px), (max-height: 479.98px)`.
   - Desk: `(min-width: 840px) and (min-height: 480px)`.
2. **Source.** Material 3 window size classes (compact below 600, medium from
   600, expanded from 840; compact height below 480). Apple's size classes
   match.
3. **Window size alone decides.** No user-agent, pointer or hover test.
   Orbit has two layouts, so there is nothing else to choose between.
4. **It replaces** decision 3c's 600 px door switch (#1371) and the app's
   900/600 switch. `POCKET_QUERY`, the home page's `DESK` query and every
   phone/desk `@media` use the pair above.
5. **In-layout widths stay.** 880, 560, 420 and 620 (settings, administration,
   household, relay), 681 (Reader), 1200 (wide preview) and 800 tall (door
   phone) narrow one layout. They do not choose between phone and desk.

## Consequences

- A 768 px upright tablet now gets the phone layout on both the door and home.
- Windows 840-900 px wide now get the desk layout, with a smaller home dial
  (home.css sizes it from `100vw`, as #485 set).
- Windows 480-600 px tall now get the desk layout too. #670 (owner ruling
  2026-09-02) had set the tall switch at 600 px because the desk dial, sized
  from width only, overflowed those windows. Owner answer 60a (2026-11-05,
  #1382 note 52898): the dial now also shrinks with the window's height
  (home.css, `100vh - 40px`), so it fits whole; windows 680 px tall or more
  are unchanged.
- The static not-found and stumble screens (web/static/screens) use the same
  pair.
- A 1024x768 window keeps the desk layout.

Refs #1382, owner decision 45.
