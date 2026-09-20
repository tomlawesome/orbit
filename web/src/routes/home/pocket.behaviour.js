import { signOut } from "$lib/data/workspace.js";
import { screenScope } from "$lib/teardown.js";
import { packOf, setSwatch, syncSwatches } from "./swatches.js";

/**
 * The mobile dialect's behaviour, carried across from
 * design/family/mobile-home.html and owned here from that point on.
 *
 * CON-10's grammar in one function: on a phone the callout is a bottom sheet,
 * and the first tap on a body raises it rather than navigating. The second tap
 * — approach — is drawn nowhere yet, so `open` and `documents` stay inert
 * rather than leading somewhere invented.
 *
 * One departure from the mockup: it passed the sheet's copy as arguments to an
 * inline `onclick`, which needs a global to reach. The copy now rides the
 * element as data, and is written with `textContent` rather than the mockup's
 * `innerHTML` — the attribute is already entity-decoded by the parser, so the
 * result is identical and nothing here can inject markup.
 * #852 added the account menu; #1074 moved it out into mountPocketAccount()
 * below, because it is chrome rather than household data and has to be bound
 * on the empty sky too, where this function never runs. This one still
 * enforces the half of the rule that is its own: only one of
 * `#sheet`/`#maccount` is ever open, so raising a sheet closes the menu and
 * opening the menu closes the sheet.
 * @param {{
 *   approve?: (id: string) => void,
 *   dismiss?: (id: string) => void,
 *   account?: ReturnType<typeof mountPocketAccount>,
 * }} [handlers]
 */
export function mountPocket({ approve, dismiss, account } = {}) {
  const { on, teardown } = screenScope();

  /* #851: the dial bodies and suggestion markers are SVG <circle>/<g>
     elements carrying tabindex="0" and role="button" (pocket.svelte) so Tab
     can reach them, but a real button also activates on Enter and Space —
     neither of which an SVG element does natively. One shared binder for
     both listener kinds, rather than a click handler and a hand-copied
     keydown handler kept in sync by hand. */
  /** @type {(target: EventTarget | null | undefined, handler: (event: Event) => void) => void} */
  const onActivate = (target, handler) => {
    on(target, "click", handler);
    on(target, "keydown", (event) => {
      const key = /** @type {KeyboardEvent} */ (event).key;
      if (key !== "Enter" && key !== " " && key !== "Spacebar") return;
      event.preventDefault();
      handler(event);
    });
  };

  const sheet = /** @type {HTMLElement} */ (document.getElementById("sheet"));
  const title = /** @type {HTMLElement} */ (document.getElementById("sh-title"));
  const meta = /** @type {HTMLElement} */ (document.getElementById("sh-meta"));
  const fields = /** @type {HTMLElement} */ (document.getElementById("sh-fields"));
  const actsItem = /** @type {HTMLElement} */ (document.getElementById("sh-acts-item"));
  const actsSugg = document.getElementById("sh-acts-sugg");
  const amend = document.getElementById("sh-amend");

  /* #852: the account menu, #1074: no longer mounted here — the caller owns
     it, because it has to exist on the empty sky too, where this function
     never runs. All that is left is the one-overlay-at-a-time rule, which
     needs both directions: `closeMenu` shuts the menu when a sheet opens,
     and `account.onOpen` below shuts the sheet when the menu opens. Absent
     only in a test that mounts this dialect on its own. */
  const closeMenu = account?.close ?? (() => {});

  const resetSuggestionActs = () => {
    for (const button of /** @type {HTMLElement[]} */ (actsSugg?.querySelectorAll("[data-sugg-act]") ?? [])) {
      delete button.dataset.armed;
      button.textContent = button.dataset.suggAct === "approve" ? "Add to orbit" : "Dismiss";
    }
  };

  for (const body of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-sheet-title]"))) {
    onActivate(body, () => {
      title.textContent = /** @type {string} */ (body.dataset.sheetTitle);
      meta.textContent = /** @type {string} */ (body.dataset.sheetMeta);
      fields.replaceChildren();
      actsItem.hidden = false;
      if (actsSugg) actsSugg.hidden = true;
      if (amend) amend.hidden = true;
      closeMenu(); // #852: only one sheet open at a time
      sheet.classList.add("open");
    });
  }

  /* #466: a signal raises the SUGGESTION sheet — the pocket's review
     surface. Copy is cloned from a Svelte-rendered template, never built
     from strings; the two-tap grammar matches the desk rows (#434). */
  /** @type {string | null | undefined} */
  let activeSuggestion = null;
  for (const trigger of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-sheet-sugg]"))) {
    onActivate(trigger, () => {
      const id = trigger.dataset.sheetSugg;
      const template = /** @type {HTMLTemplateElement | null} */ (
        document.querySelector(`[data-sugg-template="${CSS.escape(/** @type {string} */ (id))}"]`)
      );
      if (!template) return;
      activeSuggestion = id;
      title.textContent = /** @type {string} */ (template.dataset.title);
      meta.textContent = /** @type {string} */ (template.dataset.meta);
      fields.replaceChildren(template.content.cloneNode(true));
      actsItem.hidden = true;
      if (actsSugg) actsSugg.hidden = false;
      if (amend) { amend.hidden = false; amend.setAttribute("href", `/item/${id}`); }
      resetSuggestionActs();
      closeMenu(); // #852: only one sheet open at a time
      sheet.classList.add("open");
    });
  }
  for (const button of /** @type {HTMLElement[]} */ (actsSugg?.querySelectorAll("[data-sugg-act]") ?? [])) {
    on(button, "click", () => {
      if (!activeSuggestion) return;
      const act = button.dataset.suggAct;
      if (!button.dataset.armed) {
        button.dataset.armed = "1";
        button.textContent = act === "approve" ? "tap again to approve" : "tap again to dismiss";
        return;
      }
      (act === "approve" ? approve : dismiss)?.(activeSuggestion);
      close();
    });
  }

  const close = () => {
    sheet.classList.remove("open");
    resetSuggestionActs();
  };
  /* The other half of the one-overlay rule (#1074): opening the account menu
     puts this sheet away. Registered rather than passed in, because the menu
     is mounted before this dialect is and outlives a dialect switch. */
  if (account) account.onOpen = close;
  for (const button of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-sheet-close]"))) {
    on(button, "click", close);
  }

  /* A sheet you cannot dismiss with the key that dismisses everything else is
     a trap. The mockup had no keyboard to worry about; the product does. */
  on(window, "keydown", (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === "Escape") close();
  });

  return () => {
    /* Hand the menu's hook back: the menu outlives this dialect, and a stale
       `close` would reach into a sheet that is no longer mounted (#1074). */
    if (account) account.onOpen = null;
    teardown();
  };
}

/**
 * THE POCKET ACCOUNT MENU (#852, and #1074 for where it lives).
 *
 * `#morb` toggles the `#maccount` bottom sheet; its nav links are plain
 * `<a href>`s, its THEME row imports the same setSwatch/packOf the desk
 * swatches use (./swatches.js), and its sign-out drives `signOut()` the way
 * Chrome.svelte's sub-screen orb does — two taps, the second one revoking
 * the session before it navigates. Home's own desk orb hands sign-out to the
 * ratified descent flight instead, but that flight belongs to +page.svelte's
 * state and this dialect has nothing to withdraw from the pocket sky, so —
 * like Chrome.svelte's sub-screens — it goes straight to the door.
 *
 * It used to live inside mountPocket, which /home only runs for a reader who
 * HAS a household; on the empty sky the sheet was drawn in full and answered
 * nothing. Its own mount now, bound by +page.svelte on every branch. The
 * only thing it still shares with mountPocket is the one-overlay-at-a-time
 * rule, and the handle carries both directions of it: `close` so the dialect
 * can shut the menu when its own sheet opens, and `onOpen` — which a dialect
 * sets and clears — so opening the menu shuts that sheet. On the empty sky
 * nothing sets `onOpen`, because there is no sheet to put away.
 *
 * @returns {{ close: () => void, teardown: () => void, onOpen: (() => void) | null }}
 */
export function mountPocketAccount() {
  const { on, teardown } = screenScope();
  const morb = document.getElementById("morb");
  const maccount = document.getElementById("maccount");
  const close = () => {
    maccount?.classList.remove("open");
    morb?.setAttribute("aria-expanded", "false");
  };
  const handle = { close, teardown, onOpen: /** @type {(() => void) | null} */ (null) };
  if (!morb || !maccount) return handle;

  const openMenu = () => {
    handle.onOpen?.(); // #852: only one sheet open at a time
    maccount.classList.add("open");
    morb.setAttribute("aria-expanded", "true");
  };
  on(morb, "click", () => (maccount.classList.contains("open") ? close() : openMenu()));

  /* Tapping outside the open menu closes it — the same light-dismiss rule
     every other overlay in the product carries (home.behaviour.js's
     OVERLAY_HIT, Chrome.svelte's own account-close handler). */
  on(window, "click", (event) => {
    if (!maccount.classList.contains("open")) return;
    const target = /** @type {Node | null} */ (event.target);
    if (target && (maccount.contains(target) || morb.contains(target))) return;
    close();
  });

  /* Escape closes the menu and, if focus was inside it, returns focus to
     `#morb` — #853's rule (home.behaviour.js's OVERLAY_OPENER), rebuilt
     here rather than imported because pocket's own overlay set (`#sheet`,
     `#maccount`) is not shared code. */
  on(window, "keydown", (event) => {
    if (/** @type {KeyboardEvent} */ (event).key !== "Escape") return;
    if (!maccount.classList.contains("open")) return;
    const focusWasInside = maccount.contains(document.activeElement);
    close();
    if (focusWasInside) morb.focus();
  });

  /* THEME: the same setSwatch/packOf home.behaviour.js's desk swatches use
     (./swatches.js, moved there rather than copied). */
  for (const swatch of /** @type {NodeListOf<HTMLElement>} */ (maccount.querySelectorAll(".mswatches button"))) {
    on(swatch, "click", (event) =>
      setSwatch(
        packOf(/** @type {HTMLElement} */ (event.currentTarget)),
        /** @type {HTMLElement} */ (event.currentTarget),
      ));
  }
  syncSwatches(maccount);

  const signoutButton = document.getElementById("msignout");
  const signoutProblem = /** @type {HTMLElement | null} */ (document.getElementById("msignout-problem"));
  let armedOut = false;
  on(signoutButton, "click", async () => {
    if (!armedOut) {
      armedOut = true;
      if (signoutButton) signoutButton.textContent = "tap again to sign out";
      return;
    }
    if (signoutProblem) { signoutProblem.hidden = true; signoutProblem.textContent = ""; }
    try {
      await signOut();
    } catch (error) {
      armedOut = false;
      if (signoutButton) signoutButton.textContent = "sign out →";
      if (signoutProblem) {
        signoutProblem.textContent = /** @type {any} */ (error)?.message ?? "still signed in — try again";
        signoutProblem.hidden = false;
      }
      return;
    }
    location.href = "/logout";
  });

  return handle;
}
