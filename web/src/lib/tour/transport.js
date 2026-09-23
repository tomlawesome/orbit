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
   the same rule tour.css states. */
const STYLES = `
#${BAR_ID}{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);
  width:470px;height:44px;z-index:${Z_INDEX};box-sizing:border-box;
  display:flex;align-items:center;gap:2px;padding:0 16px 0 8px;
  background:var(--panel-raised);backdrop-filter:blur(14px);
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
#${BAR_ID} .now{position:absolute;top:8px;left:0;white-space:nowrap;
  font:9.5px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--ink-quiet)}
#${BAR_ID} .tip{position:absolute;top:8px;left:0;white-space:nowrap;opacity:0;
  font:9.5px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--accent);
  transition:opacity .15s ease}
#${BAR_ID} .tip.on{opacity:1}
#${BAR_ID} .track.tipping .now{opacity:0}
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
`;

/**
 * @param {object} options
 * @param {import("./player.js").FilmPlayer} options.player
 * @param {import("./clock.js").FilmClock} options.clock
 * @param {Document} [options.doc]
 * @param {boolean} [options.loop] drive the clock from real frames (off in tests)
 */
export function mountTransport({ player, clock, doc = document, loop = true }) {
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLES;
    doc.head.appendChild(style);
  }

  const bar = doc.createElement("div");
  bar.id = BAR_ID;
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Tour transport");

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
  track.append(rail, fill, now, tip, head);

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

  bar.append(pp, stop, scriptBtn, track, readout, scriptRegion, status);
  doc.body.appendChild(bar);

  /** @type {HTMLButtonElement[]} */
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
    const labelWidth = now.offsetWidth;
    now.style.left = `${Math.max(0, Math.min(t * width - labelWidth / 2, width - labelWidth))}px`;
  }

  /**
   * One tick per chapter, placed at the reading its chapter starts on. The
   * painted mark is 1x8; the button around it is 18x38, which is the widest
   * the tick spacing allows without two of them overlapping.
   */
  function buildTicks() {
    for (const old of ticks) old.remove();
    ticks = player.chapters().map((one, k) => {
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
        tip.style.left = `${Math.max(0, Math.min(x - tip.offsetWidth / 2, track.clientWidth - tip.offsetWidth))}px`;
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
    setRecede();
  }

  /** Round 7 (#1097): whether the reader pressed stop (the pill's own
   *  button, or Escape) -- the announcement's only way to tell a stop from
   *  a natural finish, since the player exposes `ended()` but not which. */
  let stoppedByUser = false;

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      player.toggle();
    } else if (event.key === "Escape") {
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
  doc.addEventListener("keydown", onKeydown);

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
      doc.removeEventListener("keydown", onKeydown);
      bar.remove();
    },
  };
}
