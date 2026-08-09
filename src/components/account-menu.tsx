"use client";

import { useEffect, useId, useRef, useState } from "react";

const focusableSelector = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

export interface AccountMenuProps {
  displayName: string;
  initials: string;
  isInstanceAdmin: boolean;
  onSettings(): void;
  onAdministration(): void;
  onSignOut(): void;
  logoutBusy: boolean;
}

export function AccountMenu({
  displayName,
  initials,
  isInstanceAdmin,
  onSettings,
  onAdministration,
  onSignOut,
  logoutBusy,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = `account-menu-${useId().replaceAll(":", "")}`;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const frame = window.requestAnimationFrame(() => {
      containerRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  function closeMenu(returnFocus = false) {
    setOpen(false);
    if (returnFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  function nextControlAfterMenu() {
    const menuItems = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
    );
    const focusable = Array.from(document.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => element.getClientRects().length > 0 && !element.hasAttribute("hidden"));
    const lastMenuItem = menuItems.at(-1);
    const lastMenuItemIndex = lastMenuItem ? focusable.indexOf(lastMenuItem) : -1;
    return lastMenuItemIndex >= 0 ? focusable[lastMenuItemIndex + 1] : null;
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
    );
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);

    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      const nextControl = event.shiftKey ? triggerRef.current : nextControlAfterMenu();
      if (nextControl) {
        event.preventDefault();
        setOpen(false);
        window.requestAnimationFrame(() => nextControl.focus());
      } else {
        setOpen(false);
      }
      return;
    }
    if (!items.length) return;

    let nextIndex: number | undefined;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    items[nextIndex]?.focus();
  }

  return (
    <div className="account-menu" ref={containerRef}>
      <button
        ref={triggerRef}
        className="topbar-profile"
        data-settings-return-focus
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Open account menu"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="profile-avatar">{initials}</span>
        <strong>{displayName}</strong>
      </button>

      {open && (
        <div
          id={menuId}
          className="account-menu-popup"
          role="menu"
          aria-label="Account menu"
          onKeyDown={handleMenuKeyDown}
        >
          <button
            className="account-menu-item"
            type="button"
            role="menuitem"
            onClick={() => { closeMenu(); onSettings(); }}
          >
            Settings
          </button>
          {isInstanceAdmin && (
            <button
              className="account-menu-item"
              type="button"
              role="menuitem"
              onClick={() => { closeMenu(); onAdministration(); }}
            >
              Administration
            </button>
          )}
          <button
            className="account-menu-item"
            type="button"
            role="menuitem"
            aria-disabled={logoutBusy || undefined}
            disabled={logoutBusy}
            onClick={onSignOut}
          >
            {logoutBusy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
