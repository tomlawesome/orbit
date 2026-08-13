"use client";

import { ShellDrawer } from "@/components/shell-drawer";

/**
 * CON-12 — the north star. Creation lives in the sky: a full-width drawer
 * from the top whose handle is the star itself (design/v19/home.html).
 * With the topbar gone this is the shell's "Add item" affordance at every
 * breakpoint; the manifest keeps its own compact add button for thumbs.
 *
 * Deliberately NOT implemented from the mockup: the four type chips
 * (renewal / service / inspection / something else) and a live document
 * drop target. Both would need the item editor to accept a seeded item,
 * and seeding it flips it from "Add an item" to "Edit item" — a change to
 * a component this slice does not own. Rather than ship four buttons that
 * all do the same thing, the drawer states plainly what belongs here and
 * offers the one real route. Tracked as a follow-up.
 */

export interface CreateDrawerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onOpenFullForm(): void;
}

export function CreateDrawer({ open, onOpenChange, onOpenFullForm }: CreateDrawerProps) {
  return (
    <ShellDrawer
      id="createdrawer"
      side="top"
      modal
      label="Add to your orbit"
      handleLabel="Add to your orbit"
      handleClassName="nstar"
      open={open}
      onOpenChange={onOpenChange}
      handle={
        <>
          <svg width="30" height="30" viewBox="-15 -15 30 30" aria-hidden="true" className="nstar-glint">
            <circle r="9" fill="var(--ink)" opacity=".12" />
            <path
              d="M 0 -12 L 1.7 -1.7 L 12 0 L 1.7 1.7 L 0 12 L -1.7 1.7 L -12 0 L -1.7 -1.7 Z"
              fill="var(--ink)"
              opacity=".9"
            />
            <circle r="2" fill="var(--ink)" />
          </svg>
          <span aria-hidden="true">create</span>
        </>
      }
    >
      <div className="create-inner">
        <h2 className="create-title">Add to your orbit</h2>
        <p className="create-lede">
          Renewals, services, inspections, certificates — anything with a date worth keeping.
        </p>
        <button type="button" className="create-full" onClick={onOpenFullForm}>
          Open the full form
        </button>
        <p className="create-note">
          Have the paperwork already? Start the item here, then attach the document — Orbit reads what it can.
        </p>
      </div>
    </ShellDrawer>
  );
}
