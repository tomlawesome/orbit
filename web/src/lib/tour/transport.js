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
 */
import { startFilmLoop } from "./clock.js";

const BAR_ID = "orbit-tour-transport";
const STYLE_ID = "orbit-tour-transport-styles";
/** Above veil.js's sheet (2000) and the film's own chrome (2100). */
const Z_INDEX = 2200;

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

  bar.append(pp, stop, track, readout);
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

  /** @param {number} index */
  function markChapter(index) {
    const one = player.chapters()[index];
    now.textContent = (one?.name ?? "").toUpperCase();
    ticks.forEach((tick, k) => tick.classList.toggle("here", k === index));
    setRecede();
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      player.toggle();
    } else if (event.key === "Escape") {
      event.preventDefault();
      player.stop();
    }
  }

  pp.addEventListener("click", () => player.toggle());
  stop.addEventListener("click", () => player.stop());
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

  setIcon();
  buildTicks();
  markChapter(player.chapter());
  paint();

  return {
    bar,
    /** Called once the film has been measured, so the ticks can be placed. */
    refresh() {
      placeTicks();
      markChapter(player.chapter());
      paint();
    },
    markChapter,
    setRecede,
    paint,
    destroy() {
      offChapter();
      offEnd();
      offFrame();
      offPlaying();
      stopLoop();
      doc.removeEventListener("keydown", onKeydown);
      bar.remove();
    },
  };
}
