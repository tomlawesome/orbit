/**
 * THE TRANSPORT (#866): the film's face.
 *
 * Round 5's second fix, verbatim from its README: "The edge-to-edge bar is
 * gone. The transport is a 470x44 pill centred at the bottom: play/pause and
 * stop at the left, the time bar with its chapter ticks, the current
 * chapter's name above the playhead, `m:ss / m:ss` at the right. Painted
 * marks are small; hit targets are not — the buttons are 32px circles, and
 * each tick is an 18x38 transparent button around its 1x8 painted mark."
 *
 * Everything round 4 proved is kept and is kept here: space toggles, Esc
 * stops, tick jumps land on their chapters, hovering a tick names it (the
 * chapter label yields while it does), the focus ring. The pill recedes to
 * 38% while the film plays and returns on hover, focus or pause; the
 * stopped and ended state keeps the 16% ghost, which hover also brings back.
 *
 * It paints from the PLAYER's budget, never from the wall clock — see
 * player.js. This module owns no timing of its own at all: it is told when a
 * frame happened and reads three numbers.
 *
 * Built imperatively and mounted on demand, as veil.js is, so the film can
 * be put up over any route without a component being in the tree first. The
 * one stylesheet it injects covers what inline style cannot say — `:hover`,
 * `:focus-visible`, the tick's painted `::after` mark, and the label
 * yielding to a tip.
 *
 * ROUND 7 (#1097): a reader who cannot see the film gets its script instead
 * — every chapter's lines, as ordinary readable text, after the controls —
 * and one announcement when the film starts, saying what is happening, how
 * to stop it, and that the script is there. See
 * design/v19/tour/round-7/README.md for the ruling this draws.
 */
import { isPocket } from "$lib/pocket/media.js";
import { startFilmLoop } from "./clock.js";

const BAR_ID = "orbit-tour-transport";
const STYLE_ID = "orbit-tour-transport-styles";
/** Above veil.js's sheet (2000) and the film's own chrome (2100). */
const Z_INDEX = 2200;

/** Round 7 (#1097): the script and its announcement. */
const SCRIPT_ID = `${BAR_ID}-script`;
const START_COPY = "Orbit's tour is playing on screen: a short film over "
  + "your own sky, with a transport at the bottom. Press Escape to stop "
  + 'it. The full script is in the tour transport, under "Tour script".';
const STOPPED_COPY = "Tour stopped. Your sky is back.";
const FINISHED_COPY = "Tour finished. Your sky is back.";

/** m:ss, as the mockup prints it. @param {number} ms */
export function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* Not one colour below is new: every value is a pack token from packs.css,
   the same rule tour.css states. The blur is written both ways (#1174): iOS
   Safari before 18 knows only `-webkit-backdrop-filter`, and without it the
   pill at its 38% recede is a see-through box with the page's words showing
   through its own. */
const STYLES = `
#${BAR_ID}{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);
  width:470px;height:44px;z-index:${Z_INDEX};box-sizing:border-box;
  display:flex;align-items:center;gap:2px;padding:0 16px 0 8px;
  background:var(--panel-raised);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  border:1px solid var(--line);border-radius:22px;opacity:1;transition:opacity .6s ease}
#${BAR_ID}.dim{opacity:.38}
#${BAR_ID}.gone{opacity:.16}
#${BAR_ID}.dim:hover,#${BAR_ID}.dim:focus-within,
#${BAR_ID}.gone:hover,#${BAR_ID}.gone:focus-within{opacity:1}
#${BAR_ID} button{background:none;border:0;padding:0;margin:0;cursor:pointer;color:var(--ink);
  display:flex;align-items:center;justify-content:center}
#${BAR_ID} .pp,#${BAR_ID} .stp{width:32px;height:32px;border-radius:50%}
#${BAR_ID} .pp:focus-visible,#${BAR_ID} .stp:focus-visible{outline:1.5px solid var(--accent);outline-offset:1px}
#${BAR_ID} .pp svg{width:12px;height:12px}
#${BAR_ID} .stp svg{width:10px;height:10px}
#${BAR_ID} .pp svg,#${BAR_ID} .stp svg{display:block;fill:currentColor}
#${BAR_ID} .pp:hover,#${BAR_ID} .stp:hover{color:var(--accent)}
#${BAR_ID} .track{position:relative;flex:1;height:44px;margin-left:4px}
#${BAR_ID} .rail{position:absolute;left:0;right:0;top:29px;height:2px;background:var(--line-soft)}
#${BAR_ID} .fill{position:absolute;left:0;top:29px;height:2px;width:0;background:var(--accent)}
#${BAR_ID} .head{position:absolute;top:27px;left:0;width:6px;height:6px;margin-left:-3px;border-radius:50%;
  background:var(--accent);box-shadow:0 0 8px color-mix(in srgb,var(--accent) 45%,transparent)}
#${BAR_ID} .tick{position:absolute;top:6px;width:18px;height:38px;margin-left:-9px;padding:0;
  background:none;border:0;cursor:pointer}
#${BAR_ID} .tick::after{content:"";position:absolute;left:50%;top:20px;width:1px;height:8px;
  margin-left:-.5px;background:var(--ink-faint)}
#${BAR_ID} .tick:hover::after,#${BAR_ID} .tick.here::after{background:var(--accent)}
#${BAR_ID} .tick:focus-visible{outline:1.5px solid var(--accent);outline-offset:-8px;border-radius:8px}
/* #1083: .now/.tip moved from .track's own children to bar's (see the JS
   construction's own note) — 80px is exactly where .track's own left edge
   already sat (32px play/pause + 2px gap + 32px stop + 2px gap + track's own
   4px margin-left), so this is the same rendered position as before, not a
   new one. */
#${BAR_ID} .now{position:absolute;top:8px;left:80px;white-space:nowrap;
  font:9.5px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--ink-quiet)}
#${BAR_ID} .tip{position:absolute;top:8px;left:80px;white-space:nowrap;opacity:0;
  font:9.5px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--accent);
  transition:opacity .15s ease}
#${BAR_ID} .tip.on{opacity:1}
/* :has(), not a descendant combinator: .now is bar's own child now, a
   sibling of .track rather than nested in it (#1083). */
#${BAR_ID}:has(.track.tipping) .now{opacity:0}
#${BAR_ID} .clock{font:10px var(--mono);letter-spacing:.12em;color:var(--ink-quiet);
  white-space:nowrap;margin-left:8px}
@media (prefers-reduced-motion: reduce){
  #${BAR_ID},#${BAR_ID} .tip{transition-duration:0s}
}
/* Round 7 (#1097): app.css's own .sr-only rule, verbatim, repeated here
   because this module injects its own stylesheet and must not depend on
   one it did not bring -- the script and its announcement stay clipped to
   nothing, always. */
#${BAR_ID} .vh{position:absolute;width:1px;height:1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap}
/* The Script button is drawn the way a skip link is: the .vh clip above
   until it has focus, then shown in the pill's own type beside Stop -- so
   the picture the fidelity frames photograph does not change for anyone
   who has not tabbed to it. */
#${BAR_ID} .scr{font:9.5px var(--mono);letter-spacing:.16em;text-transform:uppercase}
#${BAR_ID} .scr:focus{position:static;width:auto;height:auto;overflow:visible;
  clip:auto;padding:0 6px}
#${BAR_ID} .scr:focus-visible{outline:1.5px solid var(--accent);outline-offset:1px;border-radius:4px}

/* ---- #1083 §4: the pocket transport --------------------------------------
   Same DOM, same elements, a second stylesheet: nothing here touches a desk
   selector's own declaration above, and this block only ever applies under
   the pocket's own switch (media.js's POCKET_QUERY, repeated here because a
   stylesheet cannot read a JS constant).

   THE ROW SPLIT. .words is drawn by the desk row's own children rather than
   a new wrapper: every child is pulled out of the flex row and given an
   explicit place in one of the two rows (row one: y 1-19, the pill's own
   padding-top to the row's own height; row two: y 19-63), so nothing here
   is a new element, only where the existing ones sit. Row two's own
   children (the buttons, the rail) are positioned EXPLICITLY at top:19px
   rather than left to the desk's own centring rule, which spreads a 44px
   button across the WHOLE 62px pill and lands it under row one's own strip
   (#1083, pocket-measure's own "covered by" finding on the ARRIVE frame:
   .now and .pp overlapped because centring, not the row split, was placing
   the button). .now/.tip are bar's own children (moved there for Addendum
   A/the "label spills out of its box" fix — see the JS construction's own
   note), so row one is just their own left/top against the bar, the same
   as .clock's own right/top reaches the opposite corner. */
@media (max-width:900px),(max-height:600px){
  #${BAR_ID}{
    left:var(--p-gutter,16px);right:var(--p-gutter,16px);bottom:calc(12px + env(safe-area-inset-bottom));
    transform:none;width:auto;height:64px;box-sizing:border-box;
    padding:1px 8px;gap:0;border-radius:18px;
    transition:opacity .2s ease}
  /* #1083 owner's fix (round 8, 1a): a fade between places, never a slide —
     the JS move (below) drives this transition's actual duration per move;
     this base rule only stops the .6s desk recede fade from firing during a
     reposition. Reduced motion: instant either way (clock.js's own idiom). */
  @media (prefers-reduced-motion:reduce){ #${BAR_ID}{transition:none} }
  #${BAR_ID}.top{bottom:auto;top:calc(10px + env(safe-area-inset-top))}
  #${BAR_ID}.raised{bottom:calc(var(--tour-raise,64px) + 12px)}
  #${BAR_ID} .pp,#${BAR_ID} .stp{position:absolute;top:19px;width:44px;height:44px;border-radius:12px}
  #${BAR_ID} .pp{left:8px}
  #${BAR_ID} .stp{left:56px}
  #${BAR_ID} .pp svg{width:12px;height:12px}
  #${BAR_ID} .stp svg{width:10px;height:10px}
  /* The rail: the one slider target, 44px tall, full width after the
     buttons (8 pad + 44 + 4 gap + 44 + 8 gap = 108). */
  #${BAR_ID} .track{position:absolute;left:108px;right:0;top:19px;height:44px;margin:0;touch-action:none}
  #${BAR_ID} .rail{top:21px}
  #${BAR_ID} .fill,#${BAR_ID} .head{top:21px}
  #${BAR_ID} .now,#${BAR_ID} .tip{position:absolute;top:1px;left:8px;right:auto;
    font:12px var(--mono);letter-spacing:.14em;overflow:hidden;white-space:nowrap}
  /* round 3's own guard: no ellipsis on the pocket's chapter name. */
  #${BAR_ID} .now{text-overflow:clip}
  #${BAR_ID} .clock{position:absolute;top:1px;right:8px;margin-left:0;font:12px var(--mono)}
  /* The twelve ticks are painted marks here, not buttons (§4.2's Call): a
     44px hit box around an 18px spacing would overlap its neighbours, and
     the rail itself is the one keyboard/pointer target. */
  #${BAR_ID} .tick{position:absolute;top:19px;width:1px;height:6px;margin-left:-.5px;
    background:var(--ink-faint);border-radius:0;pointer-events:none}
  /* The desk's own tick is a 18x38 button with an invisible face and a
     painted ::after dash (this same stylesheet's desk-only rule, above);
     the pocket's own tick is that dash drawn directly, an <i> with no face
     to hide behind, and would otherwise inherit that ::after too — a second,
     spurious mark below the one just drawn (#1083, found on the running
     demo). */
  #${BAR_ID} .tick::after{content:none}
  #${BAR_ID} .tick.aim{top:17px;height:10px;background:var(--accent)}
  #${BAR_ID} .now.aim{color:var(--accent)}
}
`;

/**
 * @param {object} options
 * @param {import("./player.js").FilmPlayer} options.player
 * @param {import("./clock.js").FilmClock} options.clock
 * @param {Document} [options.doc]
 * @param {boolean} [options.loop] drive the clock from real frames (off in tests)
 * @param {() => boolean} [options.hasFilmOpenedSheet] (#1083 §4.6) whether
 *   the film itself currently owns an open sheet (vocabulary.js's `open()`/
 *   `close()` undo list) — an Escape while a sheet is up that the film did
 *   NOT open is the reader closing their own, and must not also stop the
 *   film.
 */
export function mountTransport({
  player,
  clock,
  doc = document,
  loop = true,
  hasFilmOpenedSheet = () => false,
}) {
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLES;
    doc.head.appendChild(style);
  }

  /* #1083 §4.2/§4.4: decided once, at mount, the same as the film's own
     dialect is fixed at mount (CON-10) — the pill's shape and recede are
     already CSS-media-driven and need no JS branch, but the tick's element
     type and the docking/slider wiring below do. */
  const pocket = isPocket();

  const bar = doc.createElement("div");
  bar.id = BAR_ID;
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Tour transport");
  /* #1083 §3.7: stays pressable while a kit sheet inerts the rest of the
     page (focus.js's `inertPage` already skips this attribute). */
  if (pocket) bar.setAttribute("data-pocket-above", "");

  const pp = doc.createElement("button");
  pp.type = "button";
  pp.className = "pp";
  const ppIcon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  ppIcon.setAttribute("viewBox", "0 0 12 12");
  pp.appendChild(ppIcon);

  const stop = doc.createElement("button");
  stop.type = "button";
  stop.className = "stp";
  stop.setAttribute("aria-label", "Stop");
  stop.setAttribute("title", "Stop · esc");
  stop.innerHTML = '<svg viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" rx="1"/></svg>';

  /* Round 7 (#1097): the Script button, after Stop -- the keyboard route to
     the script for a reader already on the pill. */
  const scriptBtn = doc.createElement("button");
  scriptBtn.type = "button";
  scriptBtn.className = "vh scr";
  scriptBtn.textContent = "Script";
  scriptBtn.setAttribute("aria-label", "Script");
  scriptBtn.setAttribute("aria-controls", SCRIPT_ID);

  const track = doc.createElement("div");
  track.className = "track";
  const rail = doc.createElement("div");
  rail.className = "rail";
  const fill = doc.createElement("div");
  fill.className = "fill";
  const now = doc.createElement("div");
  now.className = "now";
  const tip = doc.createElement("div");
  tip.className = "tip";
  const head = doc.createElement("div");
  head.className = "head";
  track.append(rail, fill, head);

  const readout = doc.createElement("div");
  readout.className = "clock";
  readout.textContent = "0:00 / 0:00";

  /* Round 7 (#1097): the script itself, after the controls -- one thing to
     a reader, the transport then its script (design/v19/tour/round-7's own
     rule). Visually hidden, never `display:none`, never `aria-hidden`: a
     reader reaches it by heading navigation or the Script button above. */
  const scriptRegion = doc.createElement("div");
  scriptRegion.id = SCRIPT_ID;
  scriptRegion.className = "vh";
  scriptRegion.setAttribute("role", "region");
  scriptRegion.setAttribute("aria-label", "Tour script");
  const scriptHeading = doc.createElement("h2");
  scriptHeading.textContent = "Tour script";
  /* Focusable only by script -- the Script button's whole job. */
  scriptHeading.tabIndex = -1;
  scriptRegion.appendChild(scriptHeading);
  scriptBtn.addEventListener("click", () => scriptHeading.focus());

  /* The announcement (round 7): mounted empty with the pill so the element
     exists before its text ever changes -- Dawn.svelte's `.state` and
     Newcomer's `.note` follow the same rule (#788, §23). Filled once the
     film actually starts, never on the clock's own timer. */
  const status = doc.createElement("div");
  status.className = "vh";
  status.setAttribute("role", "status");

  /* #1083: .now/.tip are bar's own children, not track's — a text node's
     accessible box must sit inside whatever element contains it
     (pocket-measure's own "label spills out of its box" finding), and .now
     sitting in row one while .track sits in row two means it cannot be
     track's descendant on the pocket. Positioned relative to bar in both
     dialects; see the desk/pocket rules below for the two placements. */
  bar.append(pp, stop, scriptBtn, track, now, tip, readout, scriptRegion, status);
  doc.body.appendChild(bar);

  /** Buttons on desk, painted `<i>` marks on the pocket (#1083 §4.2).
   *  @type {(HTMLButtonElement | HTMLElement)[]} */
  let ticks = [];

  function setIcon() {
    const playing = clock.playing();
    ppIcon.innerHTML = playing
      ? '<rect x="1" y="0" width="3.5" height="12"/><rect x="7.5" y="0" width="3.5" height="12"/>'
      : '<path d="M1 0 L12 6 L1 12 Z"/>';
    pp.setAttribute("aria-label", playing ? "Pause" : "Play");
    pp.setAttribute("title", `${playing ? "Pause" : "Play"} · space`);
  }

  /** The pill recedes while the film plays and returns whenever it is not. */
  function setRecede() {
    bar.classList.toggle("dim", clock.playing() && !player.ended());
    bar.classList.toggle("gone", player.ended());
  }

  function paint() {
    const total = player.total();
    const cursor = player.cursor();
    const t = total ? Math.min(1, cursor / total) : 0;
    const width = track.clientWidth || 1;
    fill.style.width = `${t * width}px`;
    head.style.left = `${t * width}px`;
    readout.textContent = `${mmss(Math.min(cursor, total))} / ${mmss(total)}`;
    /* On desk, .now tracks the playhead along the rail. On the pocket, row
       one is a fixed strip (chapter name left, clock right, §4.1) — the CSS
       already places it, and an inline `left` here would fight that.
       #1083: .now is bar's own child now, not track's (see the JS
       construction's own note), so the offset this computes WITHIN the
       rail's own width is added to the rail's own offset within the bar. */
    if (!pocket) {
      const labelWidth = now.offsetWidth;
      const withinTrack = Math.max(0, Math.min(t * width - labelWidth / 2, width - labelWidth));
      now.style.left = `${track.offsetLeft + withinTrack}px`;
    }
  }

  /**
   * One tick per chapter, placed at the reading its chapter starts on.
   *
   * On desk, the painted mark is 1x8 and the button around it is 18x38, the
   * widest the tick spacing allows without two of them overlapping.
   *
   * #1083 §4.2's Call: on the pocket the ticks are painted `<i>` marks, not
   * buttons — twelve 44px hit boxes cannot fit a 250px rail without lying
   * about their hit box, and the rail itself (below) is the one slider
   * target and the keyboard route the desk's tick buttons were. Decided by
   * `isPocket()` at mount, same as the rest of this module's own dialect.
   */
  function buildTicks() {
    for (const old of ticks) old.remove();
    ticks = player.chapters().map((one, k) => {
      if (pocket) {
        const tick = doc.createElement("i");
        tick.className = "tick";
        track.insertBefore(tick, head);
        return tick;
      }
      const tick = doc.createElement("button");
      tick.type = "button";
      tick.className = "tick";
      tick.title = one.name;
      tick.setAttribute("aria-label", `Chapter ${k + 1}: ${one.name}`);
      tick.addEventListener("click", () => player.jump(k));
      const name = () => {
        tip.textContent = one.name;
        tip.classList.add("on");
        track.classList.add("tipping");
        const total = player.total();
        const x = total ? (player.offsets()[k] / total) * track.clientWidth : 0;
        /* #1083: .tip is bar's own child now, not track's — see paint()'s
           own note on the same offset. */
        const withinTrack = Math.max(0, Math.min(x - tip.offsetWidth / 2, track.clientWidth - tip.offsetWidth));
        tip.style.left = `${track.offsetLeft + withinTrack}px`;
      };
      const unname = () => {
        tip.classList.remove("on");
        track.classList.remove("tipping");
      };
      tick.addEventListener("mouseenter", name);
      tick.addEventListener("focus", name);
      tick.addEventListener("mouseleave", unname);
      tick.addEventListener("blur", unname);
      track.insertBefore(tick, head);
      return tick;
    });
    placeTicks();
  }

  /* ---- #1083 §4.2: the pocket's rail, the one slider target -------------- */

  /** The chapter whose offset is closest to the reading `clientX` maps to
   *  along the rail. @param {number} clientX */
  function nearest(clientX) {
    const rect = track.getBoundingClientRect();
    const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    const reading = ratio * player.total();
    const offsets = player.offsets();
    let best = 0;
    let bestDist = Infinity;
    offsets.forEach((offset, k) => {
      const dist = Math.abs(offset - reading);
      if (dist < bestDist) { bestDist = dist; best = k; }
    });
    return best;
  }

  /** @type {number | null} */
  let aimIndex = null;

  /** While aiming, the aimed tick's mark grows and `.now` shows the aimed
   *  chapter's name in the accent; on release it shows the playing chapter
   *  again (`unaim`, via `markChapter`). @param {number} index */
  function aim(index) {
    aimIndex = index;
    ticks.forEach((tick, k) => tick.classList.toggle("aim", k === index));
    now.textContent = (player.chapters()[index]?.name ?? "").toUpperCase();
    now.classList.add("aim");
  }

  function unaim() {
    if (aimIndex === null) return;
    aimIndex = null;
    ticks.forEach((tick) => tick.classList.remove("aim"));
    now.classList.remove("aim");
    markChapter(player.chapter());
  }

  /** A `pointerdown` anywhere on the bar brings it fully opaque for 1.2s
   *  (§4.3), whether or not it lands on the rail. */
  let touchTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  function touchBar() {
    bar.classList.add("touched");
    if (touchTimer) clearTimeout(touchTimer);
    touchTimer = setTimeout(() => { bar.classList.remove("touched"); touchTimer = null; }, 1200);
  }

  /** @type {number | null} */
  let trackPointerId = null;
  /** @param {PointerEvent} event */
  function onTrackPointerDown(event) {
    trackPointerId = event.pointerId;
    track.setPointerCapture?.(event.pointerId);
    track.classList.add("touched");
    touchBar();
    aim(nearest(event.clientX));
  }
  /** @param {PointerEvent} event */
  function onTrackPointerMove(event) {
    if (event.pointerId !== trackPointerId) return;
    aim(nearest(event.clientX));
  }
  /** @param {PointerEvent} event */
  function onTrackPointerUp(event) {
    if (event.pointerId !== trackPointerId) return;
    trackPointerId = null;
    track.classList.remove("touched");
    const index = nearest(event.clientX);
    unaim();
    player.jump(index);
    touchBar();
  }
  /** @param {PointerEvent} event */
  function onTrackPointerCancel(event) {
    if (event.pointerId !== trackPointerId) return;
    trackPointerId = null;
    track.classList.remove("touched");
    unaim();
  }
  /** ArrowRight/ArrowLeft jump ±1 chapter, Home/End first/last (§4.2).
   *  @param {KeyboardEvent} event */
  function onTrackKeydown(event) {
    const last = player.chapters().length - 1;
    if (event.key === "ArrowRight") { event.preventDefault(); player.jump(Math.min(last, player.chapter() + 1)); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); player.jump(Math.max(0, player.chapter() - 1)); }
    else if (event.key === "Home") { event.preventDefault(); player.jump(0); }
    else if (event.key === "End") { event.preventDefault(); player.jump(last); }
  }

  if (pocket) {
    track.setAttribute("role", "slider");
    track.tabIndex = 0;
    track.setAttribute("aria-label", "Chapter");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(player.chapters().length - 1));
    track.addEventListener("pointerdown", onTrackPointerDown);
    track.addEventListener("pointermove", onTrackPointerMove);
    track.addEventListener("pointerup", onTrackPointerUp);
    track.addEventListener("pointercancel", onTrackPointerCancel);
    track.addEventListener("keydown", onTrackKeydown);
  }

  /* ---- #1083 §4.4: dock and stand ----------------------------------------
     The transport owns this; chapters never say it. Feature-detected off the
     real DOM (a kit sheet's `.p-sheet-layer.open`, `/create`'s `.pk-bar`),
     never off the dialect flag, so it costs nothing extra on desk — neither
     selector is ever present there. */
  /** @type {"home" | "top" | "raised"} */
  let dockState = "home";
  let leaveTopTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  /** @type {Element | null} */
  let observedBar = null;
  /** @type {ResizeObserver | null} */
  let barResizeObserver = null;
  /** @type {MutationObserver | null} */
  let dockObserver = null;

  const sheetOpen = () => Boolean(doc.querySelector(".p-sheet-layer.open"));
  const footBar = () => doc.querySelector(".pk-bar");
  const stillMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function updateRaiseOffset() {
    const pkBar = footBar();
    if (!pkBar) return;
    bar.style.setProperty("--tour-raise", `${Math.round(pkBar.getBoundingClientRect().height)}px`);
  }

  function ensureBarObserved() {
    const pkBar = footBar();
    if (pkBar === observedBar) return;
    barResizeObserver?.disconnect();
    observedBar = pkBar;
    if (pkBar && typeof ResizeObserver === "function") {
      barResizeObserver = new ResizeObserver(() => { if (dockState === "raised") updateRaiseOffset(); });
      barResizeObserver.observe(pkBar);
    }
    updateRaiseOffset();
  }

  /** @param {"home" | "top" | "raised"} state */
  function applyDockState(state) {
    dockState = state;
    bar.classList.toggle("top", state === "top");
    bar.classList.toggle("raised", state === "raised");
    if (state === "raised") { ensureBarObserved(); updateRaiseOffset(); }
    setRecede();
  }

  /** Moving is a fade, not a slide (owner's Call, round 8): opacity to 0 in
   *  150ms at the old place, reposition, opacity to its recede level in
   *  200ms. Reduced motion: instant.
   *
   *  Going to `.top` is the one exception (owner's fix 1): it happens the
   *  instant a sheet's own `.open` appears, never waiting out the 150ms fade
   *  first — a pill still sliding into place as the sheet rises is exactly
   *  the clash the docking exists to avoid. The position changes at once;
   *  only its opacity still eases in.
   *
   *  @param {"home" | "top" | "raised"} next
   *  @param {{ immediate?: boolean }} [o] */
  function moveDock(next, o = {}) {
    if (next === dockState) return;
    if (stillMotion() || o.immediate) {
      applyDockState(next);
      if (o.immediate && !stillMotion()) {
        bar.style.transition = "none";
        bar.style.opacity = "0";
        void bar.offsetHeight;
        bar.style.transition = "opacity 200ms ease";
        bar.style.opacity = "";
      }
      return;
    }
    bar.style.transition = "opacity 150ms ease";
    bar.style.opacity = "0";
    setTimeout(() => {
      applyDockState(next);
      void bar.offsetHeight;
      bar.style.transition = "opacity 200ms ease";
      bar.style.opacity = "";
    }, 150);
  }

  function evaluateDock() {
    if (sheetOpen()) {
      if (leaveTopTimer) { clearTimeout(leaveTopTimer); leaveTopTimer = null; }
      if (dockState !== "top") moveDock("top", { immediate: true });
      return;
    }
    if (dockState === "top") {
      /* owner's fix 1: leave .top only once the sheet's own fade (--p-rise,
         300ms) has finished. */
      if (!leaveTopTimer) {
        leaveTopTimer = setTimeout(() => {
          leaveTopTimer = null;
          moveDock(footBar() ? "raised" : "home");
        }, 350);
      }
      return;
    }
    const next = footBar() ? "raised" : "home";
    if (next !== dockState) moveDock(next);
    else ensureBarObserved();
  }

  if (pocket) {
    doc.documentElement.setAttribute("data-tour-pocket", "");
    if (typeof MutationObserver === "function") {
      dockObserver = new MutationObserver(() => evaluateDock());
      dockObserver.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
    }
    evaluateDock();
  }

  function placeTicks() {
    const total = player.total();
    ticks.forEach((tick, k) => {
      tick.style.left = `${total ? (player.offsets()[k] / total) * 100 : 0}%`;
    });
  }

  /**
   * The script (round 7, #1097): a heading and a paragraph per line, per
   * chapter, drawn from `player.script()` -- never a second copy of the
   * words a chapter plays. Rebuilt whole rather than patched, the same as
   * `buildTicks()`, because there is nothing here worth diffing.
   */
  function buildScript() {
    while (scriptRegion.lastChild && scriptRegion.lastChild !== scriptHeading) {
      scriptRegion.lastChild.remove();
    }
    const script = player.script();
    player.chapters().forEach((one, k) => {
      const heading = doc.createElement("h3");
      heading.textContent = `Chapter ${k + 1}: ${one.name}`;
      scriptRegion.appendChild(heading);
      for (const line of script[k] ?? []) {
        const p = doc.createElement("p");
        p.textContent = line;
        scriptRegion.appendChild(p);
      }
    });
  }

  /** @param {number} index */
  function markChapter(index) {
    const one = player.chapters()[index];
    now.textContent = (one?.name ?? "").toUpperCase();
    ticks.forEach((tick, k) => tick.classList.toggle("here", k === index));
    if (pocket) {
      track.setAttribute("aria-valuenow", String(index));
      track.setAttribute("aria-valuetext", `Chapter ${index + 1}: ${one?.name ?? ""}`);
    }
    setRecede();
  }

  /** Round 7 (#1097): whether the reader pressed stop (the pill's own
   *  button, or Escape) -- the announcement's only way to tell a stop from
   *  a natural finish, since the player exposes `ended()` but not which. */
  let stoppedByUser = false;

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    /* #1083 §4.6: the film's own dispatches (vocabulary.js's `close()` and
       `unread()`) are marked so this never mistakes them for the reader
       stopping the film. */
    if (/** @type {{ tourfilm?: boolean }} */ (event).tourfilm === true) return;
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      player.toggle();
    } else if (event.key === "Escape") {
      /* #1083 §4.6: a sheet up that the film did not open is the reader
         closing their own — let it pass rather than also stopping the film. */
      if (pocket && sheetOpen() && !hasFilmOpenedSheet()) return;
      event.preventDefault();
      stoppedByUser = true;
      player.stop();
    }
  }

  pp.addEventListener("click", () => player.toggle());
  stop.addEventListener("click", () => {
    stoppedByUser = true;
    player.stop();
  });
  /* #1083 §4.6: capture phase, so Esc still stops the film under a kit
     sheet, whose own capture handler (`holdSheet`, sheet.js) would otherwise
     stop propagation before a bubble-phase listener here ever saw it. Safe on
     desk: nothing there ever calls `stopPropagation` on Escape. */
  doc.addEventListener("keydown", onKeydown, { capture: true });

  /* The transport follows the player directly rather than waiting to be
     told: whoever assembles the film has no job wiring these two together. */
  const offChapter = player.onChapter(markChapter);
  const offEnd = player.onEnd(() => setRecede());
  const offFrame = clock.onFrame(paint);
  const offPlaying = clock.onPlaying(() => {
    setIcon();
    setRecede();
  });
  const stopLoop = loop ? startFilmLoop(clock) : () => {};

  /* The announcement (round 7): the start copy fires once, on the film's
     first chapter; the stop/finish copy fires every time the film ends,
     reading `stoppedByUser` and then clearing it, so a later natural finish
     after a restart is never blamed on an earlier stop. Never the film's
     own clock-driven words -- that is the ruling: nothing read at the
     reader on a timer. */
  let announcedStart = false;
  const offAnnounceStart = player.onChapter(() => {
    if (announcedStart) return;
    announcedStart = true;
    status.textContent = START_COPY;
  });
  const offAnnounceEnd = player.onEnd((ended) => {
    if (!ended) return;
    status.textContent = stoppedByUser ? STOPPED_COPY : FINISHED_COPY;
    stoppedByUser = false;
  });

  setIcon();
  buildTicks();
  buildScript();
  markChapter(player.chapter());
  paint();

  return {
    bar,
    /** Called once the film has been measured, so the ticks and the
     *  script can be placed. */
    refresh() {
      placeTicks();
      buildScript();
      markChapter(player.chapter());
      paint();
    },
    markChapter,
    setRecede,
    paint,
    destroy() {
      offChapter();
      offEnd();
      offAnnounceStart();
      offAnnounceEnd();
      offFrame();
      offPlaying();
      stopLoop();
      doc.removeEventListener("keydown", onKeydown, { capture: true });
      if (pocket) {
        track.removeEventListener("pointerdown", onTrackPointerDown);
        track.removeEventListener("pointermove", onTrackPointerMove);
        track.removeEventListener("pointerup", onTrackPointerUp);
        track.removeEventListener("pointercancel", onTrackPointerCancel);
        track.removeEventListener("keydown", onTrackKeydown);
        if (touchTimer) clearTimeout(touchTimer);
        if (leaveTopTimer) clearTimeout(leaveTopTimer);
        dockObserver?.disconnect();
        barResizeObserver?.disconnect();
        doc.documentElement.removeAttribute("data-tour-pocket");
      }
      bar.remove();
    },
  };
}
