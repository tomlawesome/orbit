import { describe, expect, it } from "vitest";

import { archiveTotalBytesDefault } from "orbit/server/archive-retention";

/*
 * #1792 audit finding FR-4: the default space for all exports is a whole
 * number of GiB, rounded up: max(1 GiB, ceil(2 x household quota in GiB)).
 * The admin editor shows it in whole GB, so a fractional default would be
 * stored as an override on an hours-only save.
 */
const GIB = 1_073_741_824;

describe("#1792 FR-4: archiveTotalBytesDefault", () => {
  it("rounds twice a 2.25 GiB quota (4.5 GiB) up to 5 GiB", () => {
    expect(archiveTotalBytesDefault({ householdQuotaBytes: 2.25 * GIB })).toBe(5 * GIB);
  });

  it("keeps an exact whole number and the 1 GiB floor", () => {
    expect(archiveTotalBytesDefault({ householdQuotaBytes: 5 * GIB })).toBe(10 * GIB);
    expect(archiveTotalBytesDefault({ householdQuotaBytes: 0.25 * GIB })).toBe(1 * GIB);
  });
});
