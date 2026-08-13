"use client";

import { ShellDrawer } from "@/components/shell-drawer";

/**
 * CON-7 (right) — the chart key. Reads the gravity dial: what the colours,
 * the shapes and the distances mean. Rendered only on the "Due next" view,
 * because that is the only view with a chart to explain.
 *
 * Swatches are decorative (`aria-hidden`); every row states its meaning in
 * words, so the key never depends on colour perception.
 */

export interface ChartKeyDrawerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

const urgency = [
  { token: "--overdue", label: "Overdue — inside the ring" },
  { token: "--warm", label: "Due soon" },
  { token: "--upcoming", label: "Upcoming" },
  { token: "--ok", label: "On track — wide orbit" },
];

export function ChartKeyDrawer({ open, onOpenChange }: ChartKeyDrawerProps) {
  return (
    <ShellDrawer
      id="keydrawer"
      side="right"
      label="Chart key"
      handleLabel="Chart key"
      handleClassName="key-handle"
      open={open}
      onOpenChange={onOpenChange}
      handle={<span>key</span>}
    >
      <h2 className="drawer-title">Chart key</h2>

      <h3 className="drawer-heading">Urgency</h3>
      <ul className="keyrows">
        {urgency.map((row) => (
          <li className="keyrow" key={row.token}>
            <span className="sw" aria-hidden="true" style={{ background: `var(${row.token})` }} />
            {row.label}
          </li>
        ))}
      </ul>

      <h3 className="drawer-heading">Physics</h3>
      <ul className="keyrows">
        <li className="keyrow">Closer to the centre means sooner.</li>
        <li className="keyrow">A bigger body means a costlier item.</li>
        <li className="keyrow">A belt means documents are attached.</li>
      </ul>

      <h3 className="drawer-heading">Reading it another way</h3>
      <p className="drawer-note">
        Every body on the chart has a matching row in the list below it. Nothing lives on the chart alone.
      </p>
    </ShellDrawer>
  );
}
