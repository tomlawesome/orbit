import { expect, type Page } from "@playwright/test";

/**
 * #849: keyboard-audit machinery shared between the desktop walk
 * (v19-keyboard.spec.ts) and the pocket walk (v19-keyboard-pocket.spec.ts).
 * Moved here verbatim from v19-keyboard.spec.ts so both files import the same
 * code rather than keeping two copies in sync by hand — nothing below changes
 * what it asserts.
 *
 * Injected once per document (addInitScript runs again on every hard
 * navigation) so the heavy lifting — deciding what is really visible,
 * describing whatever currently has focus — lives in one place rather than
 * being re-typed into every page.evaluate below.
 */

const INTERACTIVE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const AUDIT_SCRIPT = `
(function () {
  var SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};

  function isReallyVisible(el) {
    /* visibility is read on the element alone: it inherits, but a child may
       opt back in (a drawer's handle stays visible while its drawer is
       hidden), so an ancestor's "hidden" says nothing on its own. */
    if (getComputedStyle(el).visibility === "hidden") return false;
    var node = el;
    while (node) {
      var cs = getComputedStyle(node);
      if (cs.display === "none" || parseFloat(cs.opacity) === 0) return false;
      if (node !== el && cs.overflow !== "visible") {
        var arect = node.getBoundingClientRect();
        if (arect.width === 0 || arect.height === 0) return false;
      }
      node = node.parentElement;
    }
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    var fixed = el, hasFixedAncestor = false;
    while (fixed) {
      if (getComputedStyle(fixed).position === "fixed") { hasFixedAncestor = true; break; }
      fixed = fixed.parentElement;
    }
    if (hasFixedAncestor) {
      var vw = window.innerWidth, vh = window.innerHeight;
      if (rect.right <= 0 || rect.left >= vw || rect.bottom <= 0 || rect.top >= vh) return false;
    }
    return true;
  }

  function describe(el) {
    var label = el.getAttribute("aria-label") || el.getAttribute("title") ||
      (el.textContent || "").trim().slice(0, 48) || (el.id ? "#" + el.id : "") || el.tagName;
    var parts = [], node = el, hops = 0;
    while (node && hops < 8) {
      if (node.id) { parts.unshift("#" + node.id); break; }
      var parent = node.parentElement;
      if (!parent) { parts.unshift(node.tagName); break; }
      var idx = Array.prototype.indexOf.call(parent.children, node) + 1;
      parts.unshift(node.tagName + ":nth-child(" + idx + ")");
      node = parent;
      hops += 1;
    }
    return { key: parts.join(">"), label: el.tagName.toLowerCase() + ' "' + label + '"' };
  }

  function focusVisible(el) {
    var cs = getComputedStyle(el);
    var outlined = cs.outlineStyle !== "none" && cs.outlineWidth !== "0px";
    var shadowed = Boolean(cs.boxShadow) && cs.boxShadow !== "none";
    return outlined || shadowed;
  }

  window.__kb = {
    collect: function (rootSelector, excludeSelector) {
      var scope = rootSelector ? document.querySelector(rootSelector) : document;
      if (!scope) return [];
      var nodes = Array.prototype.slice.call(scope.querySelectorAll(SELECTOR));
      return nodes
        .filter(function (el) { return !(excludeSelector && el.closest(excludeSelector)); })
        .filter(isReallyVisible)
        .map(describe);
    },
    focused: function (excludeSelector) {
      var el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      var info = describe(el);
      info.focusVisible = focusVisible(el);
      info.excluded = Boolean(excludeSelector && el.closest(excludeSelector));
      return info;
    },
  };
})();
`;

export async function installKeyboardAudit(p: Page) {
  await p.addInitScript(AUDIT_SCRIPT);
  /* addInitScript only takes effect from the NEXT navigation; called before
     any navigation happens on a fresh test page, so the very first goto
     already has it installed. */
}

export type Described = { key: string; label: string };
export type FocusedInfo = Described & { focusVisible: boolean; excluded: boolean };
type KbWindow = typeof window & {
  __kb: { collect(root: string | null, exclude: string | null): Described[]; focused(exclude: string | null): FocusedInfo | null };
};

export async function collectVisible(p: Page, root: string | null = null, exclude: string | null = null): Promise<Described[]> {
  return p.evaluate(([r, x]) => (window as unknown as KbWindow).__kb.collect(r, x), [root, exclude] as const);
}

export async function currentFocus(p: Page, exclude: string | null = null): Promise<FocusedInfo | null> {
  return p.evaluate((x) => (window as unknown as KbWindow).__kb.focused(x), exclude);
}

type Match = { selector?: string; tag?: string; textIncludes?: string };

/** Blurs whatever has focus, then Tabs to the first element matching `match`,
 *  failing loudly if Tab never gets there. Purely keyboard: no `.focus()`,
 *  no click. */
export async function tabTo(p: Page, match: Match, { cap = 60, screen = "" }: { cap?: number; screen?: string } = {}) {
  /* Deliberately does NOT blur first. Blurring to force a clean start works
     once per page load (auditTabOrder does exactly that, right after a real
     navigation) but a SECOND blur-to-nothing after Tab has already wrapped
     the whole document once puts headless Chromium's focus-cycle state into
     a limbo where every further Tab press leaves `document.activeElement`
     on <body> — verified by instrumenting this loop: 60 presses, 60 "BODY"
     reads, immediately after a prior full-page audit had already completed
     one wrap. Real browsers hand the wrap off to their own chrome (the
     address bar) and back; there is no such chrome for CDP-dispatched keys
     to hand off to, so re-arming that hand-off with another blur() is what
     breaks, not tabbing onward from wherever focus already, legitimately,
     is. Continuing from the current position is both the fix and the more
     honest keyboard idiom: a real reader never blurs themselves either. */
  for (let i = 0; i < cap; i += 1) {
    await p.keyboard.press("Tab");
    const matched = await p.evaluate((m) => {
      const el = document.activeElement;
      if (!(el instanceof Element)) return false;
      if (m.selector && !el.matches(m.selector)) return false;
      if (m.tag && el.tagName !== m.tag) return false;
      if (m.textIncludes && !(el.textContent || "").includes(m.textIncludes)) return false;
      return true;
    }, match);
    if (matched) return;
  }
  throw new Error(`${screen}: Tab never reached the requested control within ${cap} presses`);
}

/**
 * Walks Tab from a blurred start until it returns to the first control
 * reached (proving no trap) or `cap` is exhausted (proving one), recording
 * every stop's focus-visible state along the way. Compares the visited set
 * against every visible interactive control the screen (or `root`, for a
 * scoped panel) actually shows. Uses soft assertions so all four checks —
 * reachability both ways, no-trap, focus-visibility — are reported together
 * rather than the first failure hiding the rest.
 */
export async function auditTabOrder(p: Page, screen: string, { root = null, exclude = null }: { root?: string | null; exclude?: string | null } = {}) {
  const expected = await collectVisible(p, root, exclude);
  const expectedKeys = new Set(expected.map((e) => e.key));

  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  const visited: FocusedInfo[] = [];
  const seenKeys = new Set<string>();
  let firstKey: string | null = null;
  let cycled = false;
  /* Generous on purpose: a screen whose closed overlays leak their contents
     into the tab order (opacity:0/pointer-events:none without tabindex="-1"
     or inert — see the file header) can have far more real stops than
     `expected` alone suggests. The cap exists to bound a genuine infinite
     loop, not to cut the walk short before it has had a fair chance to
     cycle back. */
  const cap = Math.max(expected.length + 10, 60);
  let lastKey: string | null = null;
  for (let i = 0; i < cap; i += 1) {
    let info: FocusedInfo | null = null;
    /* A Tab press occasionally resolves before Chromium has finished moving
       focus (observed on this host: the very next read reports the SAME
       element again). That is automation flake, not a trap — a real trap
       keeps returning to the same one or two elements even after a beat, so
       retrying a genuine no-op press costs nothing and does not mask one. */
    /* Six, not three: Chromium's native <input type="date"> is one control
       with four internal Tab stops (day, month, year, picker), and the
       audit must walk through it rather than call it a trap. */
    for (let retry = 0; retry < 6; retry += 1) {
      await p.keyboard.press("Tab");
      await p.waitForTimeout(20); // pacing this loop matters, not just its length
      info = await currentFocus(p, exclude);
      if (!info || info.key !== lastKey) break;
      await p.waitForTimeout(50);
    }
    if (!info) continue; // focus passed through browser chrome; keep pressing rather than giving up
    lastKey = info.key;
    /* `exclude` names a region the screen shows but this audit is not
       proving (an unbounded list, say): its controls are left out of
       `expected`, so a stop inside it must be walked through rather than
       reported as "reached but not visible" — which is exactly what happened
       on the runner, where other specs had created accounts the household
       page then listed (pipeline 487, job 3948). */
    if (info.excluded) continue;
    if (firstKey === null) firstKey = info.key;
    else if (info.key === firstKey) { cycled = true; break; }
    if (seenKeys.has(info.key)) break; // revisited something that wasn't the start: stuck
    seenKeys.add(info.key);
    visited.push(info);
  }

  const visitedKeys = new Set(visited.map((v) => v.key));
  const missing = expected.filter((e) => !visitedKeys.has(e.key));
  const extra = visited.filter((v) => !expectedKeys.has(v.key));
  const invisible = visited.filter((v) => !v.focusVisible);

  /* Plain expect, not expect.soft: collected into one array and asserted
     once, so every one of the four checks still gets reported together
     without leaning on Playwright's own soft-assertion bookkeeping. */
  const problems: string[] = [];
  if (missing.length) problems.push(`shown but never reached by Tab: ${missing.map((m) => m.label).join(", ")}`);
  if (extra.length) problems.push(`Tab reached a control the screen does not show as visible: ${extra.map((e) => e.label).join(", ")}`);
  if (!cycled) problems.push(`Tab never cycled back to the first control after ${visited.length} stops — possible focus trap`);
  if (invisible.length) problems.push(`no visible focus indicator (outline/box-shadow) while focused: ${invisible.map((v) => v.label).join(", ")}`);
  expect(problems, screen).toEqual([]);

  return visited;
}

/** Dismisses the first-run tour if it turns up — see the desktop file's
 *  header note on why it is skipped rather than proven here. */
/* This host runs other agents' work concurrently (builds, other browser
   suites against this same shared acceptance stack), and a page load that
   is normally sub-second has been observed taking well over 15s under that
   contention with no error anywhere — no failed request, no console error,
   just a renderer not getting scheduled. Per testing-and-ci's own rule, a
   wall-clock budget nobody would notice widening is not the bar being
   tested here; `#explore` either attaches or it doesn't, and that is still
   asserted, just given room to be true on a slow host rather than a fast
   one. `test.setTimeout` in every test below is widened to match. */
export const SETTLE_TIMEOUT = 60_000;

export async function dismissTourIfShown(p: Page) {
  /* Ask the record, not the screen: the card is drawn only after /home has
     fetched /api/settings/tour, so an instant "is it visible?" right after
     navigation says no on a fresh account and the walk then runs under the
     tour. A reader who has never taken it is about to see it — wait for
     the card; one who has is not — move on. */
  const record = await p.request.get("/api/settings/tour").then((r) => r.json() as Promise<{ tour?: { tourSeenAt: string | null } }>).catch(() => null);
  if (!record || record.tour?.tourSeenAt) return;
  const tour = p.locator(".tourcard");
  await expect(tour).toBeVisible({ timeout: SETTLE_TIMEOUT });
  await p.keyboard.press("Escape");
  await expect(tour).toBeHidden();
}


/** Desktop-only: `#explore` is drawn by the desk dialect
 *  (web/src/routes/home/+page.svelte); the pocket dialect has no such
 *  element (see pocket.svelte), so v19-keyboard-pocket.spec.ts settles on
 *  /home with its own, pocket-shaped wait rather than this one. */
export async function settled(p: Page) {
  await dismissTourIfShown(p);
  /* The ratified launch flight plays over an authenticated return; wait for
     it to hand off to the settled dial before anything measures the page
     (Flight.svelte removes "launching" at the end of its own sequence). */
  await p.waitForFunction(() => !document.body.classList.contains("launching"), null, { timeout: SETTLE_TIMEOUT });
  /* #explore sits in the branch home/+page.svelte renders whenever `view`
     is not yet an empty-sky household (true from the very first paint,
     since `view` starts null) — so its presence is really just "home
     rendered its normal markup at all", independent of whether the async
     readHome() read has resolved yet. */
  await p.locator("#explore").waitFor({ state: "attached", timeout: SETTLE_TIMEOUT });
}

/**
 * Opens `toggle` by keyboard, Tabs INTO the panel it reveals (`panel`) so
 * focus genuinely leaves the toggle, then presses Escape and checks both
 * that the panel closed and that focus came back to the toggle — the real
 * test of "Escape returns focus to the opener", not the trivially-passing
 * version where Escape is pressed before focus ever moved. Soft, so every
 * overlay on a screen gets checked even if an earlier one fails.
 *
 * The two read-only drawers (status, key) hold no focusable control beyond
 * their own handle — `collectVisible(panel)` including the toggle itself is
 * how that is told apart from a panel like create's or the account menu's,
 * which have real content to tab into. Only the latter shape is asked "does
 * Tab actually land inside you next" — asking a one-control panel the same
 * question would report a false "did not put contents in the tab order"
 * against a panel that never had any contents to place there.
 */
export async function auditLightDismiss(p: Page, screen: string, toggle: string, panel: string) {
  await tabTo(p, { selector: toggle }, { screen });
  await p.keyboard.press("Enter");
  await expect.soft(p.locator(panel), `${screen}: opening ${toggle} did not reveal ${panel}`).toHaveClass(/open/);

  const contents = await collectVisible(p, panel);
  if (contents.length > 1) {
    await p.keyboard.press("Tab");
    const enteredPanel = await p.evaluate((sel) => Boolean(document.activeElement?.closest(sel)), panel);
    expect.soft(enteredPanel, `${screen}: opening ${toggle} did not put ${panel}'s own contents next in the Tab order`).toBe(true);
  }

  await p.keyboard.press("Escape");
  await expect.soft(p.locator(panel), `${screen}: Escape did not close ${panel}`).not.toHaveClass(/open/);
  await expect.soft(p.locator(toggle).first(), `${screen}: Escape did not return focus to ${toggle}`).toBeFocused();
}

/** Tabs through the whole create form in DOM order, filling the fields a
 *  reader actually would (name, type, key date, a closing note) and leaving
 *  the rest at their defaults — shared so every create test drives the
 *  identical keyboard sequence on its own fresh page. */
export async function fillCreateForm(page: Page, name: string) {
  await page.goto("/create");

  await tabTo(page, { selector: "#f-name" }, { screen: "create form" });
  await page.keyboard.type(name);
  await expect(page.locator("#disclose")).toHaveClass(/open/);

  /* Tab through all five type chips, in DOM order (service, renewal,
     inspection, suggestion, document), activating "service". */
  await page.keyboard.press("Tab"); // service
  const typeButton = await currentFocus(page);
  expect(typeButton?.label.includes("service"), "create: expected the type chips in DOM order").toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator('#types button[data-type="service"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Tab"); // renewal
  await page.keyboard.press("Tab"); // inspection
  await page.keyboard.press("Tab"); // suggestion
  await page.keyboard.press("Tab"); // document
  await page.keyboard.press("Tab"); // dropzone — left un-activated; a native file picker isn't keyboard-scriptable here

  await page.keyboard.press("Tab"); // f-provider — left blank, optional
  await page.keyboard.press("Tab"); // f-ref — left blank, optional
  await page.keyboard.press("Tab"); // f-date
  expect(await page.evaluate(() => document.activeElement?.id), "create: expected the key-date field next").toBe("f-date");
  /* Tab still reaches the field by keyboard alone; setting its value goes
     through Playwright's supported `fill()` rather than typed digits, since
     a native `<input type="date">` reads typed digits in whatever segment
     order the OS/browser locale uses (this Chromium reads DD-MM-YYYY, not
     the MM-DD-YYYY assumed by an earlier draft), making a typed sequence a
     locale bug in the test, not a thing this file should assert about. */
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  await page.locator("#f-date").fill(dueDate);
  await expect(page.locator("#f-date")).toHaveValue(dueDate);

  /* A filled date input keeps focus for several more Tabs (its day, month,
     year and picker stops); leave it the way a keyboard user does, by
     pressing Tab until focus lands on the next control. */
  for (let i = 0; i < 6 && (await page.evaluate(() => document.activeElement?.id)) === "f-date"; i += 1) {
    await page.keyboard.press("Tab");
  }
  expect(await page.evaluate(() => document.activeElement?.id), "create: expected the recurrence select after the date").toBe("f-recur");
  await page.keyboard.press("Tab"); // f-cost — left blank, optional
  await page.keyboard.press("Tab"); // f-reminder select — left at its default
  await page.keyboard.press("Tab"); // f-assign select — left at its default (household)
  await page.keyboard.press("Tab"); // f-notes
  await page.keyboard.type("added by the keyboard-only pass");
}
