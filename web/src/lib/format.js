/**
 * The manifest's vocabulary, shared (#445): a date, its distance in days, a
 * cost in minor units. One place, so T−161d means the same thing on every
 * screen. Pinned to the design's own today until real data arrives, so the
 * screens agree with the chart that sent you to them.
 */
export const DESIGN_TODAY = "2026-08-13";

export const day = (iso) => Math.round(Date.parse(iso + "T00:00:00Z") / 86400000);

export const tminus = (due, today = DESIGN_TODAY) => {
  const days = day(due) - day(today);
  return days < 0 ? `T+${-days}d` : `T−${days}d`;
};

export const longDate = (iso) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

export const money = (minor, currency, estimate = false) => {
  if (minor === null || minor === undefined) return "—";
  const amount = new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
  return estimate ? `~${amount}` : amount;
};

export const every = (months) =>
  months === 12 ? "every year" : months === 1 ? "every month" : `every ${months} months`;
