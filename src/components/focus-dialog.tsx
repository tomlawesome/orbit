"use client";

import {
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isVisibleFocusable(element: HTMLElement): boolean {
  const bounds = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return (
    bounds.width > 0
    && bounds.height > 0
    && bounds.right > 0
    && bounds.bottom > 0
    && bounds.left < window.innerWidth
    && bounds.top < window.innerHeight
    && style.display !== "none"
    && style.visibility !== "hidden"
    && !element.closest("[hidden], [aria-hidden='true']")
  );
}

function visibleFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector))
    .filter(isVisibleFocusable);
}

type FocusDialogProps = Omit<
  ComponentPropsWithoutRef<"aside">,
  "aria-modal" | "onKeyDown" | "role"
> & {
  onDismiss(): void;
  returnFocusFallback?: string;
};

/**
 * Applies the shared keyboard contract for Orbit's mounted modal drawers.
 */
export function FocusDialog({
  children,
  onDismiss,
  returnFocusFallback,
  ...props
}: FocusDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = visibleFocusableElements(dialog);
      const markedInitial = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]");
      const initial = markedInitial
        && !markedInitial.matches(":disabled")
        && isVisibleFocusable(markedInitial)
        ? markedInitial
        : focusable[0] ?? dialog;
      initial.focus();
    });

    return () => {
      cancelAnimationFrame(focusFrame);
      const capturedTarget = returnFocusRef.current;
      requestAnimationFrame(() => {
        const returnTarget = capturedTarget?.isConnected
          && !capturedTarget.matches(":disabled")
          && isVisibleFocusable(capturedTarget)
          ? capturedTarget
          : returnFocusFallback
            ? Array.from(document.querySelectorAll<HTMLElement>(returnFocusFallback))
              .find((element) => (
                !element.matches(":disabled")
                && isVisibleFocusable(element)
              ))
            : null;
        if (returnTarget) {
          returnTarget.focus();
        }
      });
    };
  }, [returnFocusFallback]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = visibleFocusableElements(dialog);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
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
    <aside
      {...props}
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      onKeyDown={handleKeyDown}
    >
      {children}
    </aside>
  );
}
