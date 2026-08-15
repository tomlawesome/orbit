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

export function mountHome({ galaxy }) {
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
  let camera = "lawson";
  let flying = false;
  const hero = document.getElementById("hero");

  /* the starfield offset is a pure function of the camera position, so a
     flight animates between two truths and there is nothing to snap back */
  function pointSky(){
    const [cx, cy] = GALAXY[camera].pos;
    document.getElementById("cam-far").style.transform = `translate(${-cx * .3}px, ${-cy * .3}px)`;
    document.getElementById("cam-near").style.transform = `translate(${-cx * .65}px, ${-cy * .65}px)`;
  }

  function renderGalaxy(settle){
    for (const old of hero.querySelectorAll(".minisys")) old.remove();
    const w = hero.clientWidth, h = hero.clientHeight;
    const [cx, cy] = GALAXY[camera].pos;
    const placed = [];
    for (const [key, hh] of Object.entries(GALAXY)) {
      if (key === camera) continue;   // you never see your own constellation — you're inside it
      const dx = hh.pos[0] - cx, dy = hh.pos[1] - cy;
      const dist = Math.hypot(dx, dy);
      /*
       * CON-13, honoured properly (#428). A household is a fixed point of
       * navigation, so its BEARING is the part of its position that carries
       * meaning and nothing below is allowed to change it. Distance is
       * expressed as radius, which every later pass may negotiate freely.
       *
       * Previously the offset was clamped as a vector and then shoved about by
       * the overlap pass and the keep-out, both of which moved constellations
       * off their true bearing — so after a flight the survivors landed
       * wherever the arithmetic left them, and the sky read as reshuffled
       * rather than rotated.
       */
      placed.push({ key, hh, dist, angle: Math.atan2(dy, dx), radius: 0 });
    }

    /* How far the visible sky extends on a given bearing: the ellipse the
       clamp used to apply, expressed as a radius so it can bound one instead
       of redirecting it. */
    const reachOn = (angle) => {
      const rx = w / 2 + 40, ry = Math.max(120, h / 2 - 155);
      const c = Math.cos(angle), sn = Math.sin(angle);
      return 1 / Math.hypot(c / rx, sn / ry);
    };
    /* .dialwrap's offsetWidth, not the dial's bounding rect: the rect includes
       transforms, and the chart is mid-fanfare (POL-1) on first render, so
       measuring it there yields a keep-out sized for a chart that is still
       growing. offsetWidth is the settled layout box. */
    const keepOut = (hero.querySelector(".dialwrap")?.offsetWidth || 640) / 2 + 46;

    for (const point of placed) {
      /* Nearer households sit closer in, but never inside the chart. Where a
         bearing cannot clear the chart within the visible band — near-vertical
         on a short viewport — the keep-out wins and the constellation sits
         partly outside the band. The bearing is never the thing that gives. */
      point.radius = Math.max(keepOut, Math.min(point.dist, reachOn(point.angle)));
    }

    /* Two bearings can fold onto the same patch of sky. Separate them by
       pushing one further out and drawing the other closer in — radius only,
       so both keep their true direction. */
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], z = placed[j];
        const ax = Math.cos(a.angle) * a.radius, ay = Math.sin(a.angle) * a.radius;
        const zx = Math.cos(z.angle) * z.radius, zy = Math.sin(z.angle) * z.radius;
        const gap = Math.hypot(zx - ax, zy - ay);
        if (gap >= 230) continue;
        const push = (230 - gap) / 2;
        const inner = a.radius <= z.radius ? a : z;
        const outer = inner === a ? z : a;
        inner.radius = Math.max(keepOut, inner.radius - push);
        outer.radius = outer.radius + push;
      }
    }

    for (const { key, hh, dist, angle, radius } of placed) {
      const ox = Math.cos(angle) * radius, oy = Math.sin(angle) * radius;
      const dim = Math.max(.45, Math.min(.9, 1.05 - dist / 2600));
      const div = document.createElement("div");
      div.className = "minisys" + (settle ? " settle" : "");
      div.setAttribute("role", "button");
      div.setAttribute("aria-label", "Fly to " + hh.name);
      // anchored so the RING CENTRE (118,95 in the svg) sits at the bearing
      // point — a flight translating by -delta therefore lands the ring centre
      // EXACTLY on the hero centre, concentric with the dial's sun
      div.style.left = (w / 2 + ox - 118) + "px";
      div.style.top = (h / 2 + oy - 95) + "px";
      div.style.setProperty("--tox", ox + "px");
      div.style.setProperty("--toy", oy + "px");
      /* A custom property rather than a flat opacity, so a pack can lift the
         floor without losing the distance gradient. See home.css. */
      div.style.setProperty("--dim", dim);
      const label = hh.name.toUpperCase();
      const tw = Math.min(150, label.length * 6.6);
      // the arrow extends underneath the text, then veers toward the ring
      const veer = `M 4 21 H ${tw + 10} L ${tw + 26} 40`;
      div.innerHTML = `<svg width="210" height="160" viewBox="0 0 210 160">
        <text x="6" y="14" font-size="9.5" letter-spacing=".14em" style="fill:var(--accent)" opacity=".85">${label}</text>
        <path d="${veer}" fill="none" style="stroke:var(--accent)" stroke-width="1" opacity=".55"/>
        <circle class="msring" cx="118" cy="95" r="40" fill="none" style="stroke:var(--chart-line)" stroke-opacity=".5" stroke-width="1"/>
        <circle cx="118" cy="95" r="3" style="fill:var(--ink)" opacity=".8"/>
        ${hh.planets.map(([px, py, pr, tok]) =>
          `<circle cx="${118 + px}" cy="${95 + py}" r="${pr}" style="fill:var(${tok})" opacity=".55"/>`).join("")}
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
        div.querySelector("path")
          .setAttribute("d", `M 4 21 H ${measured + 10} L ${measured + 26} 40`);
      }
    }
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
      document.getElementById("who-role").textContent = GALAXY[key].name + " · " +
        (key === "lawson" ? "owner" : "member");
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
    document.getElementById("b-mot").classList.add("restored");
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
  /* v17: every drawer animates home when you scroll down */
  let lastY = scrollY;
  addEventListener("scroll", () => {
    if (scrollY > lastY + 4) {
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

  pointSky();
  renderGalaxy(false);
  addEventListener("resize", () => { if (!flying) renderGalaxy(false); });

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
    document.body.classList.remove(
      "create-open", "constellation-lit", "health-degraded", "health-offline",
    );
  };
}
