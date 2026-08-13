"use client";

import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { usePrefersReducedMotion } from "@/lib/use-reduced-motion";

/**
 * The v19 shell drawer primitive (design/v19/home.html, CON-7 + CON-12).
 *
 * A drawer is a "rail": one fixed, sliding element that carries BOTH the
 * panel and its handle, so the handle rides the drawer exactly as the
 * ratified mockup specifies ("the word IS the handle"). The rail is always
 * mounted — that is what keeps the handle on screen when the drawer is
 * shut, and what lets the open/close motion be a real CSS transform
 * transition rather than a mount/unmount pop.
 *
 * Because the panel stays in the DOM while closed it is marked `inert`,
 * which removes it from the accessibility tree and from the tab order, so
 * a shut drawer is exactly as invisible to a screen reader or keyboard
 * user as it is to the eye.
 *
 * Accessibility contract:
 *  - the handle is the trigger: `aria-expanded` + `aria-controls`;
 *  - opening moves focus into the panel, closing returns it to the handle;
 *  - Escape closes (listened for at the document, so it works even when a
 *    non-modal drawer left focus behind);
 *  - a `modal` drawer dims the page behind a scrim and traps Tab inside
 *    the rail; a non-modal drawer instead closes on an outside pointer
 *    press, and never steals the tab order it does not own.
 */

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** The tabbable descendants of `root`, skipping anything explicitly hidden. */
export function shellFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => !element.closest("[hidden], [inert], [aria-hidden='true']"));
}

export type DrawerSide = "left" | "right" | "top";

export interface ShellDrawerProps {
  /** Stable id for the panel, referenced by the handle's `aria-controls`. */
  id: string;
  side: DrawerSide;
  /** Accessible name for the drawer surface. */
  label: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Modal drawers scrim the page and trap focus; informational ones do not. */
  modal?: boolean;
  /** Accessible name for the handle (its visible word is usually shorter). */
  handleLabel: string;
  handleClassName?: string;
  handle: ReactNode;
  children: ReactNode;
}

export function ShellDrawer({
  id,
  side,
  label,
  open,
  onOpenChange,
  modal = false,
  handleLabel,
  handleClassName,
  handle,
  children,
}: ShellDrawerProps) {
  const reducedMotion = usePrefersReducedMotion();
  const railRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);

  const wasOpen = useRef(open);
  const restoreFocusOnClose = useRef(true);

  const close = useCallback((returnFocus = true) => {
    restoreFocusOnClose.current = returnFocus;
    onOpenChange(false);
  }, [onOpenChange]);

  /**
   * Focus goes back on the handle whenever the drawer shuts — including
   * when something else shuts it, such as the create drawer handing over
   * to the item editor. Doing it here rather than only inside `close()`
   * is what stops focus being orphaned on `document.body` when the panel
   * holding it slides away, and it gives whatever opens next a real,
   * still-connected element to return to afterwards.
   */
  useEffect(() => {
    const previouslyOpen = wasOpen.current;
    wasOpen.current = open;
    if (open || !previouslyOpen) return;
    const returnFocus = restoreFocusOnClose.current;
    restoreFocusOnClose.current = true;
    if (!returnFocus || typeof document === "undefined") return;
    const active = document.activeElement;
    const focusWasHere = !active || active === document.body || panelRef.current?.contains(active);
    if (!focusWasHere) return;
    handleRef.current?.focus();
  }, [open]);

  // Focus moves into the panel on open. The panel itself is the fallback so
  // a drawer with nothing tabbable (an all-text status readout) still lands
  // the reader inside the surface it just announced.
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const frame = window.requestAnimationFrame(() => {
      const [first] = shellFocusable(panelRef.current);
      (first ?? panelRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  // Escape is bound at the document rather than the rail: a non-modal
  // drawer does not hold focus, so a rail-scoped handler would silently
  // stop working the moment the reader tabbed back out to the page.
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  // Non-modal drawers have no scrim to click, so an outside press is what
  // dismisses them. Focus is not pulled back to the handle here: the user
  // is already pointing somewhere else on the page.
  useEffect(() => {
    if (!open || modal || typeof document === "undefined") return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && railRef.current?.contains(event.target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, modal, close]);

  function handleRailKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!open || !modal || event.key !== "Tab") return;
    const focusable = shellFocusable(railRef.current);
    if (!focusable.length) return;
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    if (activeIndex < 0) {
      event.preventDefault();
      focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
      return;
    }
    if (event.shiftKey && activeIndex === 0) {
      event.preventDefault();
      focusable[focusable.length - 1]?.focus();
    } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
      event.preventDefault();
      focusable[0]?.focus();
    }
  }

  return (
    <>
      {modal && open && (
        <button
          className="scrim shell-scrim"
          type="button"
          aria-label={`Close ${label}`}
          onClick={() => close()}
        />
      )}
      <div
        ref={railRef}
        className={`drawer-rail drawer-rail-${side}${open ? " open" : ""}`}
        data-motion={reducedMotion ? "reduced" : "full"}
        onKeyDown={handleRailKeyDown}
      >
        <div
          ref={panelRef}
          id={id}
          className={`drawer drawer-${side}`}
          role={modal ? "dialog" : "region"}
          aria-modal={modal && open ? true : undefined}
          aria-label={label}
          tabIndex={-1}
          inert={!open}
        >
          {children}
        </div>
        <button
          ref={handleRef}
          type="button"
          className={`handle${handleClassName ? ` ${handleClassName}` : ""}`}
          aria-expanded={open}
          aria-controls={id}
          aria-label={handleLabel}
          onClick={() => (open ? close() : onOpenChange(true))}
        >
          {handle}
        </button>
      </div>
    </>
  );
}
