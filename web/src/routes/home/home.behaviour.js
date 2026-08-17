/**
 * The home screen's behaviour, carried across from design/v19/home.html with
 * its logic intact.
 *
 * This code is imperative DOM by design — it creates elements, writes
 * transforms directly, relaxes overlapping constellations apart and flies a
 * camera. Rewriting it as reactive markup is the same translation step that
 * lost the design in #408, arriving by another door. So no framework owns this
 * subtree: it is mounted once, handed the document, and left alone.
 *
 * Two deliberate departures from the mockup, neither of which can move a pixel:
 *
 *   1. The galaxy is a parameter rather than a constant — see $lib/data/workspace.js (#446).
 *   2. The mockup's inline on* attributes are wired here as listeners instead.
 *      Inline handlers need their functions to be globals; a module has none.
 */
import { fillStarTiles } from "$lib/sky.js";
import { placeGalaxy } from "./placement.js";
import { mountSkies, seedFromWorkspace } from "./skies.js";

/**
 * The sun's address (§15, the 08-17 morning batch): the centre body of the
 * dial is the household it belongs to, and clicking it goes to that
 * household's own screen — the built /household/<id>.
 *
 * A function rather than a literal in two places because the sun is written
 * twice: once by the markup, from the workspace's active household, and once
 * by a flight, which lands the camera on a different household and must
 * re-point the sun as it re-letters the name.
 */
export const sunHref = (id) => `/household/${encodeURIComponent(id)}`;

export function mountHome({ galaxy, primary, fixtures = false, workspace = "" }) {
  /*
   * Shadows the global so every bare addEventListener() below — the mockup's
   * own keydown, scroll and resize handlers — is registered against this
   * controller and torn down with the screen. The mockup's code is unchanged;
   * it simply resolves a different binding.
   */
  const controller = new AbortController();
  const addEventListener = (type, handler, options) =>
    window.addEventListener(type, handler, {
      ...(typeof options === "object" ? options : null),
      signal: controller.signal,
    });

  /*
   * A mockup is one document per screen, so leaving it destroys everything the
   * page wrote. Here <body> and the stylesheets outlive the screen, so
   * anything home writes outside its own subtree has to be handed back on the
   * way out or it follows the reader to the next screen - which is how a
   * blurred scrim survived a trip to /create. Timers are tracked for the same
   * reason: a flight that lands after unmount writes to nodes that are gone.
   */
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };


  /* ---- the galaxy: fixed coordinates, five households max (product cap) ---- */
  const GALAXY = galaxy;
  let camera = primary ?? Object.keys(galaxy)[0];
  let flying = false;
  const hero = document.getElementById("hero");

  /*
   * WHAT THE PACK SKIES LISTEN TO (§15, the sky wave).
   *
   * Three packs now paint their own sky behind this one (skies.js), and two of
   * them have to follow what happens in here: the galactic plane rides the same
   * camera as the starfield at its own slower parallax, and the terminator has
   * to re-material the constellations after a flight has moved them. The sheets
   * those two come from reach for window.pointSky and window.renderGalaxy,
   * because an inline script in a mockup has nowhere else to look. A module has
   * no globals, so the two moments are published as subscriptions instead and
   * the engines that care subscribe. Nothing else about either function moves.
   */
  const cameraWatchers = new Set(), galaxyWatchers = new Set();
  const subscribe = (set) => (fn) => { set.add(fn); return () => set.delete(fn); };
  const announce = (set) => { for (const fn of set) fn(); };

  /* the starfield offset is a pure function of the camera position, so a
     flight animates between two truths and there is nothing to snap back */
  function pointSky(){
    /* A workspace with no household yet has no camera position: the sky
       stays at origin and the galaxy renders nothing. The real journey for
       that user — label-only constellations and "Request to join" — is #453;
       until it lands the screen must degrade, not throw. */
    if (!GALAXY[camera]) return;
    const [cx, cy] = GALAXY[camera].pos;
    document.getElementById("cam-far").style.transform = `translate(${-cx * .3}px, ${-cy * .3}px)`;
    document.getElementById("cam-near").style.transform = `translate(${-cx * .65}px, ${-cy * .65}px)`;
    announce(cameraWatchers);
  }

  function renderGalaxy(settle){
    for (const old of hero.querySelectorAll(".minisys")) old.remove();
    if (!GALAXY[camera]) return; // no household yet — see pointSky (#453)
    const w = hero.clientWidth, h = hero.clientHeight;
    /* .dialwrap's offsetWidth, not the dial's bounding rect: the rect includes
       transforms, and the chart is mid-fanfare (POL-1) on first render, so
       measuring it there yields a keep-out sized for a chart that is still
       growing. offsetWidth is the settled layout box. */
    /* +88, not +46: the keep-out must clear the constellation's own ring
       (r 40 around the anchor), not just its centre point — the centre kept
       clear while the ring sat on the dial (owner, 2026-08-16). */
    const keepOut = (hero.querySelector(".dialwrap")?.offsetWidth || 640) / 2 + 88;

    /*
     * THE FIXED MAP (#428, ratified 2026-08-16). The whole arrangement is one
     * pure function of the household set, the camera and the viewport — see
     * placement.js for the law and for why it had to stop being computed
     * inline here. Nothing in this function may nudge a position afterwards:
     * a flight re-renders, and a re-render that could arrive at a different
     * answer is exactly the sky reshuffling itself.
     *
     * The camera's own constellation is in the answer and dropped here: you
     * never see it, because you are inside it.
     */
    const placed = placeGalaxy({ galaxy: GALAXY, camera, width: w, height: h, keepOut })
      .filter((point) => !point.isCamera);

    for (const { id: key, household: hh, dim, ox, oy } of placed) {
      const div = document.createElement("div");
      div.className = "minisys" + (settle ? " settle" : "");
      div.setAttribute("role", "button");
      div.setAttribute("aria-label", "Fly to " + hh.name);
      /*
       * The label and its leader always extend AWAY from the dial (owner,
       * 2026-08-16): a constellation left of centre reads leftward (the
       * original layout, ring at svg x 118), one right of centre is the
       * horizontal mirror (ring at x 92, text end-anchored). mirror() maps
       * any drawn x through the 210-wide viewBox.
       */
      const away = ox > 0;
      const mx = (x) => (away ? 210 - x : x);
      const ringX = mx(118);
      // anchored so the RING CENTRE sits at the bearing point — a flight
      // translating by -delta therefore lands the ring centre EXACTLY on the
      // hero centre, concentric with the dial's sun
      div.style.left = (w / 2 + ox - ringX) + "px";
      div.style.top = (h / 2 + oy - 95) + "px";
      div.style.setProperty("--tox", ox + "px");
      div.style.setProperty("--toy", oy + "px");
      /* A custom property rather than a flat opacity, so a pack can lift the
         floor without losing the distance gradient. See home.css. */
      div.style.setProperty("--dim", dim);
      const label = hh.name.toUpperCase();
      const tw = Math.min(150, label.length * 6.6);
      // the arrow extends underneath the text, then veers toward the ring
      const veerFor = (width) => (away
        ? `M 206 21 H ${200 - width} L ${184 - width} 40`
        : `M 4 21 H ${width + 10} L ${width + 26} 40`);
      div.innerHTML = `<svg width="210" height="160" viewBox="0 0 210 160">
        <text x="${mx(6)}" y="14" font-size="9.5" letter-spacing=".14em"${away ? ' text-anchor="end"' : ""} style="fill:var(--accent-text)" opacity=".85">${label}</text>
        <path d="${veerFor(tw)}" fill="none" style="stroke:var(--accent)" stroke-width="1" opacity=".55"/>
        <circle class="msring" cx="${ringX}" cy="95" r="40" fill="none" style="stroke:var(--chart-line)" stroke-opacity=".5" stroke-width="1"/>
        <circle cx="${ringX}" cy="95" r="3" style="fill:var(--ink)" opacity=".8"/>
        ${hh.planets.map(([px, py, pr, tok]) =>
          `<circle cx="${ringX + px}" cy="${95 + py}" r="${pr}" style="fill:var(${tok})" opacity=".55"/>`).join("")}
      </svg>`;
      div.addEventListener("click", () => flyTo(key, div));
      hero.appendChild(div);
      /*
       * The leader rule runs under the label and then veers to the ring, so
       * its length has to match the label. `tw` above estimates that from the
       * character count at the mockup's own font size; once the text is in the
       * document its real width is knowable, so measure it and correct the
       * path. That makes the label size themeable — the engraved packs set a
       * larger one — without the rule ending short of the word.
       */
      const text = div.querySelector("text");
      const measured = Math.min(150, text.getComputedTextLength());
      if (measured) {
        div.querySelector("path").setAttribute("d", veerFor(measured));
      }
    }
    /* the marks are new nodes, so anything that dresses them — dawn's crossing
       redraws the ones lying in the night in starlight — has to be told */
    announce(galaxyWatchers);
  }

  function flyTo(key, mini){
    if (flying) return;
    flying = true;
    const [cx, cy] = GALAXY[camera].pos;
    const dx = GALAXY[key].pos[0] - cx, dy = GALAXY[key].pos[1] - cy;
    hero.style.setProperty("--flyx", dx + "px");
    hero.style.setProperty("--flyy", dy + "px");
    hero.classList.add("flying");
    mini.classList.add("target");
    camera = key;
    pointSky();               // the starfield streams to the new truth
    // one continuous motion in two beats that overlap by a breath: the flight
    // lands the ring centre EXACTLY concentric with the dial's sun, and only
    // then does the chart grow out of that shared centre — slow and deliberate
    later(() => {
      document.getElementById("dial-name").textContent = GALAXY[key].name;
      /* The sun wears the name, and the pair is one identity (§15, 08-17), so
         the way in changes in the same beat the name does — a dial reading
         one household while its sun opened another would be a lie. */
      document.querySelector(".sun-link")?.setAttribute("href", sunHref(key));
      document.getElementById("who-role").textContent = GALAXY[key].name + " · " +
        (GALAXY[key].role ?? "member");
      hero.classList.add("arriving");   // dial pinned at centre, under the ring
      mini.classList.add("dissolve");   // the ring hands the centre to the chart
      const dial = document.querySelector(".dial");
      dial.style.animation = "none"; void dial.offsetWidth;
      dial.style.animation = "bloom 2.4s cubic-bezier(.22,.61,.21,1) 1";
    }, 1120);
    later(() => {
      const wrap = hero.querySelector(".dialwrap");
      wrap.style.transition = "none";
      hero.classList.remove("flying");
      hero.classList.remove("arriving");
      void wrap.offsetWidth;
      wrap.style.transition = "";
      renderGalaxy(true);     // home appears on the reverse bearing of the flight
      flying = false;
    }, 1600);
  }

  /* ---- starfield: the shared two-layer tiled field ($lib/sky.js, #445) ---- */
  fillStarTiles(document.getElementById("fartile"), document.getElementById("neartile"));

  function setTheme(name, button){
    document.documentElement.dataset.theme = name;
    for (const other of button.parentElement.querySelectorAll("button"))
      other.setAttribute("aria-pressed", String(other === button));
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries)
      if (entry.isIntersecting) entry.target.classList.add("seen");
  }, { threshold: 0.15 });
  for (const group of document.querySelectorAll(".group")) observer.observe(group);
  /* POL-6 + POL-4: callout tooltip and bidirectional highlight */
  const callout = document.createElement("div");
  callout.className = "callout";
  callout.innerHTML = '<span class="line"></span><b></b> <small></small><button class="chip"></button>';
  document.body.appendChild(callout);
  for (const link of document.querySelectorAll(".body-link")) {
    link.addEventListener("mouseenter", () => {
      const rect = link.getBoundingClientRect();
      const dial = document.querySelector(".dial").getBoundingClientRect();
      const rightSide = rect.left + rect.width / 2 >= dial.left + dial.width / 2;
      callout.querySelector("b").textContent = link.dataset.title;
      callout.querySelector("small").textContent = link.dataset.t + " · " + link.dataset.cost;
      callout.classList.toggle("side-right", rightSide);
      callout.classList.toggle("side-left", !rightSide);
      callout.style.left = rightSide ? (rect.right + 34) + "px" : "";
      callout.style.right = rightSide ? "" : (innerWidth - rect.left + 34) + "px";
      callout.style.top = (rect.top - 14) + "px";
      const docs = link.dataset.docs;
      callout.classList.toggle("has-docs", Boolean(docs));
      if (docs) {
        const chip = callout.querySelector(".chip");
        chip.textContent = "◆ " + docs + " documents";
        chip.onclick = () => openDocsByTitle(link.dataset.title);
      }
      callout.classList.add("show");
      document.getElementById(link.dataset.body)?.classList.add("lit");
      document.querySelector("#" + link.dataset.body)?.classList.add("lit");
    });
    link.addEventListener("mouseleave", () => {
      setTimeout(() => { if (!callout.matches(":hover")) {
        callout.classList.remove("show");
        document.querySelector("#" + link.dataset.body)?.classList.remove("lit");
      }}, 160);
    });
  }
  for (const item of document.querySelectorAll(".item[id]")) {
    item.addEventListener("mouseenter", () => {
      document.querySelector('.body-link[data-body="' + item.id + '"]')?.classList.add("lit");
    });
    item.addEventListener("mouseleave", () => {
      document.querySelector('.body-link[data-body="' + item.id + '"]')?.classList.remove("lit");
    });
  }
  /* POL-5: constellations on section-header hover */
  const homeHeader = [...document.querySelectorAll(".group h3")]
    .find((h) => h.textContent.includes("Needs attention"));
  if (homeHeader) {
    homeHeader.addEventListener("mouseenter", () => document.body.classList.add("constellation-lit"));
    homeHeader.addEventListener("mouseleave", () => document.body.classList.remove("constellation-lit"));
  }
  function replayArrival(){
    const dial = document.querySelector(".dial");
    dial.style.animation = "none"; void dial.offsetWidth;
    dial.style.animation = "";
  }
  function restoreOrbit(){
    document.getElementById("b-closest").classList.add("restored");
    const comet = document.getElementById("comet");
    comet.classList.remove("fly"); void comet.getBBox; comet.classList.add("fly");
  }
  /* POL-9 */
  function openPalette(open){
    document.getElementById("palette").classList.toggle("open", open);
  }
  addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "k") {
      event.preventDefault(); document.getElementById("explore").focus();
    }
  });
  function openDocsByTitle(title){
    callout.classList.remove("show");
    document.getElementById("docview-title").textContent = title;
    document.getElementById("docview").classList.add("open");
  }
  callout.addEventListener("mouseleave", () => callout.classList.remove("show"));
  const healthStates = ["healthy","degraded","offline"];
  let healthIndex = 1;
  function applyHealth(){
    document.body.classList.toggle("health-degraded", healthStates[healthIndex]==="degraded");
    document.body.classList.toggle("health-offline", healthStates[healthIndex]==="offline");
    const word = healthStates[healthIndex]==="healthy" ? "status" :
      healthStates[healthIndex]==="offline" ? "offline" : "degraded";
    document.querySelector("#edge-health span").textContent = word;
    if (healthStates[healthIndex]==="healthy") document.getElementById("statusdrawer").classList.remove("open");
  }
  function cycleHealth(){ healthIndex = (healthIndex+1)%3; applyHealth(); }
  applyHealth();
  function toggleAccount(button){
    const card = document.getElementById("account");
    const open = card.classList.toggle("open");
    button.setAttribute("aria-expanded", String(open));
  }
  /* title -> pack name, the mapping the swatch buttons encode:
     "star-chart" is starchart, "after dark" is afterdark. */
  const packOf = (button) => button.title.replace(/[\s-]/g, "");

  function setSwatch(name, button){
    document.documentElement.dataset.theme = name;
    for (const other of button.parentElement.querySelectorAll("button"))
      other.setAttribute("aria-pressed", String(other === button));
    /* Survive a refresh. See the note in app.html: the server holds the real
       preference once the shell is wired; this is the pre-paint cache. */
    try { localStorage.setItem("orbit-theme", name); } catch (e) {}
    /* The constellation leaders are measured from the rendered label, and
       the engraved packs size that label differently, so re-measure. */
    if (!flying) renderGalaxy(false);
  }

  /* The markup ships with star-chart pressed, because that is what the mockup
     draws. If the reader restored a different pack before paint, the pressed
     swatch and the live theme disagree until they click - so reconcile once. */
  (function syncSwatches(){
    const active = document.documentElement.dataset.theme;
    for (const button of document.querySelectorAll(".swatches button"))
      button.setAttribute("aria-pressed", String(packOf(button) === active));
  })();
  function toggleCreate(button){
    const drawer = document.getElementById("createdrawer");
    const open = drawer.classList.toggle("open");
    button.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("create-open", open);
    button.querySelector("span").textContent = open ? "close" : "create";
  }
  /*
   * One light-dismiss rule for the whole screen (owner, 2026-08-14), amending
   * CON-18 and the "Drawer rules" in design/owner-decisions.md, which gave
   * click-outside to the create drawer alone.
   *
   * Click anywhere outside an open overlay and it closes; Escape closes;
   * opening or clicking into one closes the others, so only ever one sits over
   * the hero. This invents no UI and moves nothing at rest - the scrim stays
   * create-only exactly as ratified. It reuses the state the design already
   * has: the `open` class, toggleCreate() for the create drawer (never bare
   * class removal, or body.create-open strands and the screen stays blurred),
   * and the same [aria-expanded] bookkeeping the scroll retract does.
   */
  const OVERLAY_HIT = [
    ["#createdrawer", "create"],
    ["#statusdrawer", "statusdrawer"],
    ["#keydrawer", "keydrawer"],
    ["#docview", "docview"],
    ["#account", "account"],
    ["button.orb", "account"],
  ];

  function closeOverlays(keep){
    if (keep !== "create" && document.body.classList.contains("create-open"))
      toggleCreate(document.getElementById("nstar"));
    for (const id of ["statusdrawer", "keydrawer"]) {
      if (id === keep) continue;
      const drawer = document.getElementById(id);
      if (drawer?.classList.contains("open")) {
        drawer.classList.remove("open");
        drawer.querySelector("[aria-expanded]")?.setAttribute("aria-expanded", "false");
      }
    }
    if (keep !== "docview") document.getElementById("docview")?.classList.remove("open");
    if (keep !== "account") {
      const account = document.getElementById("account");
      if (account?.classList.contains("open")) {
        account.classList.remove("open");
        document.querySelector("button.orb")?.setAttribute("aria-expanded", "false");
      }
    }
  }

  addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return closeOverlays(null);
    const hit = OVERLAY_HIT.find(([selector]) => target.closest(selector));
    /* Runs after the element's own handler, so a handle has already toggled
       its drawer by now and this only clears the others. */
    closeOverlays(hit ? hit[1] : null);
  });

  addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeOverlays(null);
  });
  /* v17, amended §14: any scroll movement sends every drawer home */
  let lastY = scrollY;
  addEventListener("scroll", () => {
    if (Math.abs(scrollY - lastY) > 4) {
      for (const id of ["statusdrawer", "keydrawer"]) {
        const drawer = document.getElementById(id);
        if (drawer.classList.contains("open")) {
          drawer.classList.remove("open");
          drawer.querySelector("[aria-expanded]")?.setAttribute("aria-expanded", "false");
        }
      }
      if (document.body.classList.contains("create-open"))
        toggleCreate(document.getElementById("nstar"));
    }
    lastY = scrollY;
  }, { passive: true });

  /* ---- §15/#480: the descent — scroll is altitude ------------------------
   * The universal scroll-descent law, read off the scrollbar rather than off a
   * clock: monotonic by construction, exact at both ends, and identical on the
   * way back up. Nothing here eases or lerps, because a lag would read as the
   * backdrop chasing the page rather than the page moving through it.
   *
   * The quantity is the same one every sibling descent publishes — --descent,
   * 0 at the dial and 1 once the drop is spent — and what a pack DOES with it
   * is the pack's own business (retrograde has no corridor to turn, so it
   * spends --descent bringing its two side grids in from nothing; see
   * home.css). Parked at the top is not "descending by zero" but the
   * approved dial screen, so .descending is off entirely at scroll 0 and not
   * one descent rule is in effect there.
   */
  /*
   * §15, the sky wave: ONE HANDLER, FIVE MORE QUANTITIES. Three packs joined the
   * descent in the same batch and each measures the drop differently — after
   * dark's plane spends the same --descent retrograde's walls do, dawn's
   * terminator wants a second, slower reading of how far down the whole PAGE you
   * are, and clouds' cloud sea wants three because going through a deck has a
   * before, an inside and an after. The cloud-sea sheet's own build note asks for
   * exactly this ("in the app this is the same handler for both dawn scroll
   * proposals; the constants are the only tuning"), and it is the right shape
   * anyway: one read of the scrollbar per frame, five numbers off it, every
   * appearance decision left in the stylesheet. Nothing below chooses a colour.
   *
   * Every one of them is a POSITION, not a clock. So they are monotonic by
   * construction, exact at both ends, identical on the way back up, and a
   * reduced-motion reader keeps all of them — someone who has turned motion off
   * still has to know which way is down. What reduced motion drops is the
   * flourish, and that is decided in CSS, except for --mist: being put INSIDE a
   * cloud is not a position, it is an effect, so it is the one quantity this
   * function zeroes for that reader.
   */
  const doc = document.documentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smooth = (t) => t * t * (3 - 2 * t);
  /* the cloud passage is the shorter of four-fifths of a screen and two-fifths
     of the page: a tall screen must not make it feel like a long fall, and a
     short manifest must not leave you still inside the cloud at the end */
  const PASS_SCREEN = 0.80, PASS_PAGE = 0.42;
  function readDescent(){
    const max = Math.max(1, doc.scrollHeight - innerHeight);
    const s = Math.min(max, Math.max(0, scrollY));
    /* spent over one viewport of scrolling — or 45% of the page, whichever
       comes first, so even a short manifest is read in the turned room */
    const descent = Math.min(1, s / Math.min(innerHeight, max * 0.45));
    doc.style.setProperty("--descent", descent.toFixed(4));

    /* dawn's warm shift is the whole depth's work, not the first flick's: it
       starts a little way in — under a sky that is still on its way out — and
       only spends the last of the pinky-orange at the very bottom of the page.
       The exponent keeps the top of the run slower still. */
    const p = clamp01((s / max - 0.12) / 0.88);
    doc.style.setProperty("--depth", Math.pow(p, 1.35).toFixed(4));

    /* clouds: the deck coming up past you, the blue arriving underneath it, and
       the long slow loss of height once you are through */
    const len = Math.max(1, Math.min(innerHeight * PASS_SCREEN, max * PASS_PAGE));
    const pass = clamp01(s / len);
    const below = smooth(clamp01((s - len * 0.30) / (len * 0.78)));
    const deep = smooth(clamp01((s - len) / Math.max(1, max - len)));
    /* inside it: a single soft rise and fall across the passage */
    const mist = still.matches ? 0
      : Math.sin(Math.PI * clamp01((pass - 0.08) / 0.78)) * 0.66;
    doc.style.setProperty("--pass", pass.toFixed(4));
    doc.style.setProperty("--below", below.toFixed(4));
    doc.style.setProperty("--deep", deep.toFixed(4));
    doc.style.setProperty("--mist", mist.toFixed(4));

    doc.classList.toggle("descending", s > 0);
  }
  still.addEventListener("change", readDescent, { signal: controller.signal });
  let descentQueued = false;
  addEventListener("scroll", () => {
    if (descentQueued) return;
    descentQueued = true;
    requestAnimationFrame(() => { descentQueued = false; readDescent(); });
  }, { passive: true });
  addEventListener("resize", readDescent);
  readDescent();

  pointSky();
  renderGalaxy(false);
  addEventListener("resize", () => { if (!flying) renderGalaxy(false); });

  /*
   * THE PACK SKIES (§15, the sky wave). Stood up after the galaxy exists, because
   * the terminator's guard measures the rendered dial and its tint measures the
   * rendered marks — before this line there is nothing for either to read. Only
   * the live pack's engine runs; star chart and retrograde build nothing at all.
   */
  const skies = mountSkies({
    /* alive per load in the product; pinned to the workspace under
       ORBIT_FIXTURES, which is the sheets' own build note and the only way the
       fidelity gate can compare two screenshots of a seeded stream. The clock
       is pinned by the same switch, and only by it. */
    seed: fixtures ? seedFromWorkspace(workspace) : null,
    pinClock: fixtures,
    onCamera: subscribe(cameraWatchers),
    onGalaxy: subscribe(galaxyWatchers),
  });

  /* ---- wiring that replaces the mockup's inline on* attributes ---- */
  const on = (target, type, handler) =>
    target?.addEventListener(type, handler, { signal: controller.signal });

  const star = document.getElementById("nstar");

  on(document.querySelector("button.orb"), "click", (event) =>
    toggleAccount(event.currentTarget));
  on(star, "click", (event) => toggleCreate(event.currentTarget));
  on(document.querySelector(".scrim"), "click", () => toggleCreate(star));

  /* title -> theme name: "star-chart" is the starchart pack, "after dark" afterdark */
  for (const swatch of document.querySelectorAll(".swatches button")) {
    on(swatch, "click", (event) =>
      setSwatch(packOf(event.currentTarget), event.currentTarget));
  }

  const explore = document.getElementById("explore");
  on(explore, "focus", () => openPalette(true));
  on(explore, "blur", () => setTimeout(() => openPalette(false), 150));

  /* both drawer handles ride their own drawer, which is their parent */
  for (const handle of document.querySelectorAll(".drawer > button.handle")) {
    on(handle, "click", (event) => {
      const open = event.currentTarget.parentElement.classList.toggle("open");
      event.currentTarget.setAttribute("aria-expanded", String(open));
    });
  }

  on(document.querySelector("#docview .close"), "click", () =>
    document.getElementById("docview").classList.remove("open"));

  /*
   * Hand the document back exactly as home found it. Everything below lives
   * outside home's own subtree, so Svelte does not remove it and it would
   * otherwise follow the reader to the next screen: the body classes home
   * writes, the callout node it appends to <body> (which accumulated one copy
   * per visit), the flight timers, and the group observer.
   */
  return () => {
    controller.abort();
    for (const id of timers) clearTimeout(id);
    timers.clear();
    observer.disconnect();
    callout.remove();
    /* the pack sky goes before the document is handed back, so its own teardown
       still has the layers it has to empty (§15, the sky wave) */
    skies();
    cameraWatchers.clear();
    galaxyWatchers.clear();
    document.body.classList.remove(
      "create-open", "constellation-lit", "health-degraded", "health-offline",
    );
    /* The descent is written on <html>, which outlives the screen, so it is
       handed back too — otherwise a reader who scrolls home and then leaves
       carries a stale altitude to the next screen (#480). All five quantities,
       not just the first: the sky wave added four more and a stale --deep would
       follow the reader to a screen with no cloud under it. */
    doc.classList.remove("descending");
    for (const prop of ["--descent", "--depth", "--pass", "--below", "--deep", "--mist"])
      doc.style.removeProperty(prop);
  };
}

/**
 * The labelled sky (§11, #453): a viewer with no household stands at the
 * origin of the same fixed map, and every visible household appears at its
 * identity bearing — label and ring only, no planets, no flight. Clicking
 * asks; a pending request is written on the label. The placement is the one
 * fixed map (placement.js), read from the origin instead of from a camera and
 * with no chart to keep clear.
 */
export function mountEmptySky({ galaxy, onAsk }) {
  const hero = document.getElementById("hero");
  if (!hero) return () => {};

  function render() {
    for (const old of hero.querySelectorAll(".minisys")) old.remove();
    const w = hero.clientWidth, h = hero.clientHeight;
    /*
     * The same fixed map (#428), from the origin: a viewer with no household
     * stands at the centre of the shared map rather than inside one of its
     * systems, and there is no chart to keep clear. It used to carry its own
     * copy of the placement — a vector clamp and a vector relax, both of
     * which moved constellations OFF their true bearing, which is the very
     * thing #428 forbade. One law now, or the newcomer and the member are
     * looking at two different skies.
     */
    const placed = placeGalaxy({ galaxy, camera: null, width: w, height: h, keepOut: 0 });
    for (const { id, household: hh, ox, oy } of placed) {
      const away = ox > 0;
      const mx = (x) => (away ? 210 - x : x);
      const ringX = mx(118);
      const div = document.createElement("div");
      div.className = "minisys";
      div.setAttribute("role", "button");
      div.setAttribute("aria-label", `Request to join ${hh.name}`);
      div.style.left = (w / 2 + ox - ringX) + "px";
      div.style.top = (h / 2 + oy - 95) + "px";
      const label = hh.name.toUpperCase();
      const tw = Math.min(150, label.length * 6.6);
      const veer = away ? `M 206 21 H ${200 - tw} L ${184 - tw} 40` : `M 4 21 H ${tw + 10} L ${tw + 26} 40`;
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("width", "210"); svg.setAttribute("height", "160");
      svg.setAttribute("viewBox", "0 0 210 160");
      const put = (tag, attrs, text) => {
        const el = document.createElementNS(svgNS, tag);
        for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
        if (text !== undefined) el.textContent = text;
        svg.appendChild(el);
        return el;
      };
      const name = put("text", { x: mx(6), y: 14, "font-size": "9.5", "letter-spacing": ".14em", style: "fill:var(--accent-text)", opacity: ".85" }, label);
      if (away) name.setAttribute("text-anchor", "end");
      put("path", { d: veer, fill: "none", style: "stroke:var(--accent)", "stroke-width": "1", opacity: ".55" });
      put("circle", { class: "msring", cx: ringX, cy: 95, r: 40, fill: "none", style: "stroke:var(--chart-line)", "stroke-opacity": ".5", "stroke-width": "1" });
      put("circle", { cx: ringX, cy: 95, r: 3, style: "fill:var(--ink)", opacity: ".8" });
      if (hh.requested) {
        const asked = put("text", { x: mx(6), y: 30, "font-size": "8.5", "letter-spacing": ".14em", style: "fill:var(--ink-faint)" }, "ASKED TO JOIN · WAITING");
        if (away) asked.setAttribute("text-anchor", "end");
      }
      div.appendChild(svg);
      div.addEventListener("click", () => onAsk?.(id, hh.name, hh.requested));
      hero.appendChild(div);
    }
  }

  render();
  const onResize = () => render();
  addEventListener("resize", onResize);
  return () => {
    removeEventListener("resize", onResize);
    for (const old of hero.querySelectorAll(".minisys")) old.remove();
  };
}
