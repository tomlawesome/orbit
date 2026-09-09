<script>
  import Grain from "$lib/Grain.svelte";
  import { onMount } from "svelte";
  import "./maintenance.css";
  import { rasteriseSvg } from "$lib/raster.js";
  import { mountTotalitySky } from "./sky.js";
  import { clock, when } from "./when.js";

  /**
   * Maintenance — totality (CON-15). An eclipse is the sky's own scheduled
   * downtime: the light goes out, briefly and predictably, then comes back.
   * The corona is only visible during totality, which is why a corona drawn on
   * a bright sun never worked. The moon's transit doubles as the progress bar
   * and the diamond ring is the service returning.
   *
   * The headline is three words, deliberately: "maintenance — back soon". The
   * visual carries the drama; the words state the fact. Beneath it, what the
   * operator has said (#526, ADR-0013 decision 8): the newest entry of the
   * open window, the expected return if one was given, and — only when there
   * is more than one entry — an arrow that opens the earlier ones. Most
   * windows have exactly one entry, and that case shows no arrow at all.
   *
   * Built from design/family/maintenance.html and owned here from that point on.
   */

  /** @type {{ data: import("./$types").PageData }} */
  let { data } = $props();

  let latest = $derived(data.maintenance.entries[0] ?? null);
  let earlier = $derived(data.maintenance.entries.slice(1));

  /* Rendered in UTC on the server and in the viewer's zone once mounted, so
     the markup never carries the server's clock and a person reads their own. */
  let local = $state(false);
  onMount(() => {
    local = true;
  });

  /** @param {"scheduled" | "started" | "update" | "resolved"} kind */
  const kindLabel = (kind) => (kind === "update" ? "" : ` · ${kind}`);

  onMount(mountTotalitySky);

  /**
   * #902 — the GPU law (§15), applied to totality. Same treatment the login
   * (#498/#499/#501) and the 404 (#764) already had, and the same shared
   * mechanism: $lib/raster.js.
   *
   * What was here: fourteen `filter="url(...)"` applications and no raster at
   * all, sitting under seven running CSS animations. Two of the filters are
   * feTurbulence + feDisplacementMap graphs (`rough`, `rough2`) on groups that
   * rotate and scale every frame, which is the most expensive shape in the
   * GPU law's list; `b2` and `b4` declared no filter region at all, which was
   * #498's first finding on the login. WebKit re-rasterises a live filter on
   * every repaint, and something on this screen is always moving.
   *
   * The rule applied, as on #764: a transform or an opacity fade never changes
   * what a filter computes — a filter's region and inputs are resolved in the
   * element's own local user space, before any ancestor transform, and opacity
   * composites after the filter chain — so a filtered thing whose only motion
   * is transform-or-fade can be rasterised once and the CSS class moved onto
   * the raster's own <image>. Every one of the fourteen qualifies, so every
   * one is rasterised and the live <filter> definitions are gone from the
   * document entirely (the same end state Dawn/Dusk reached in #501): each
   * raster body carries its own verbatim copy of the filters and gradients it
   * needs, so nothing is left in the paint tree to declare a region for.
   *
   * Split only where the screen forces it. The six prominences each flicker on
   * their own timing, so one raster of the whole `b4` group would freeze five
   * of them; they become six rasters, and `b4` is pinned to the absolute
   * (userSpaceOnUse) region the group's percentage default already resolved
   * to, so splitting the group cannot change what the blur is allowed to
   * cover. They do not overlap — not even within four standard deviations of
   * each other — so blurring them apart is the same picture as blurring them
   * together. Everything else stays exactly one raster per live group, body
   * and filter copied verbatim, which is the cheapest thing to prove identical.
   *
   * Nothing here bakes in a theme colour: `--star-near`/`--star-far` (#893)
   * are used by the starfield above, which carries no filter and is untouched,
   * and `--accent` is on the unfiltered progress arc. So no raster has to be
   * rebuilt when the pack changes, and the cache needs no colour in its key.
   */
  const F_B2 = '<filter id="b2"><feGaussianBlur stdDeviation="2"/></filter>';
  const F_B4 = '<filter id="b4"><feGaussianBlur stdDeviation="4"/></filter>';
  /* The prominences' `b4`, pinned. Its percentage default resolved against the
     bbox of all six shapes (x 621-974, y 313-613) to roughly x 586-1009,
     y 283-643 — comfortably clear of every shape plus four standard
     deviations of blur, so it never clipped. Rounded outward here and made
     absolute, so each of the six rasters gets that same region rather than a
     tight one computed from its own single shape, which WOULD have clipped. */
  const F_B4P =
    '<filter id="b4p" filterUnits="userSpaceOnUse" x="585" y="282" width="425" height="362">' +
    '<feGaussianBlur stdDeviation="4"/></filter>';
  const F_B9 =
    '<filter id="b9" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>';
  const F_B18 =
    '<filter id="b18" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="18"/></filter>';
  /* Verbatim, region and seed included. feTurbulence is a function of absolute
     user-space coordinates, and each raster below is drawn in a viewBox that
     keeps those coordinates, so the noise falls in exactly the same places it
     did live. */
  const F_ROUGH =
    '<filter id="rough" x="-40%" y="-40%" width="180%" height="180%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.011 0.019" numOctaves="3" seed="11" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="34"/><feGaussianBlur stdDeviation="5"/></filter>';
  const F_ROUGH2 =
    '<filter id="rough2" x="-40%" y="-40%" width="180%" height="180%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.02 0.008" numOctaves="3" seed="4" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="26"/><feGaussianBlur stdDeviation="2.5"/></filter>';
  const G_CORNERWARM =
    '<radialGradient id="cornerwarm" cx="50%" cy="100%" r="70%">' +
    '<stop offset="0%" stop-color="#f0b429" stop-opacity=".2"/>' +
    '<stop offset="60%" stop-color="#e2772b" stop-opacity=".07"/><stop offset="100%" stop-opacity="0"/></radialGradient>';
  const G_STREAMERFADE =
    '<linearGradient id="streamerFade" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0%" stop-color="#ffeec6" stop-opacity=".46"/>' +
    '<stop offset="45%" stop-color="#f2dcae" stop-opacity=".15"/><stop offset="100%" stop-opacity="0"/></linearGradient>';
  const G_PROMG =
    '<radialGradient id="promg" cx="50%" cy="50%" r="50%">' +
    '<stop offset="0%" stop-color="#ffb3a6" stop-opacity=".9"/>' +
    '<stop offset="55%" stop-color="#ff7d92" stop-opacity=".5"/><stop offset="100%" stop-opacity="0"/></radialGradient>';
  const G_FLAREG =
    '<radialGradient id="flareg" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ffffff"/>' +
    '<stop offset="18%" stop-color="#fff6e0" stop-opacity=".9"/>' +
    '<stop offset="100%" stop-color="#ffd98a" stop-opacity="0"/></radialGradient>';
  const P_PETAL = '<path id="petal" d="M 0 -26 C 150 -58, 330 -40, 560 -10 C 330 22, 150 34, 0 26 Z"/>';
  const P_PETAL_LONG = '<path id="petalLong" d="M 0 -20 C 210 -66, 430 -52, 700 -6 C 430 30, 210 40, 0 20 Z"/>';
  const P_WISP = '<path id="wisp" d="M 0 -8 C 160 -30, 300 -22, 430 -2 C 300 12, 160 16, 0 8 Z"/>';

  /**
   * One entry per <image data-r="..."> in the markup below: the crop box it
   * covers, in viewBox units, and the verbatim shape markup plus only the defs
   * that shape needs.
   *
   * `class=` is deliberately absent from every body, and so is any `opacity`
   * that a class animates: blend mode, opacity and animation are display-time
   * CSS applied to the live <image>, never baked into the raster. That is not
   * only tidier — `.prom` and `.ring-inner` set `opacity` in a keyframe, and a
   * CSS opacity REPLACES the presentation attribute rather than multiplying
   * it, so baking the attribute in would have dimmed both every time they
   * animated. Blur is linear, so pulling a constant opacity out in front of it
   * is the same picture either way, and the raster keeps its full 8 bits.
   *
   * Crops (#798's rule, carried over): each box is drawn around what its layer
   * actually draws plus everything its filter can add — four standard
   * deviations of blur, beyond which a Gaussian contributes nothing a pixel
   * can hold, and the displacement maps' own reach of half their scale — never
   * merely around the filter's declared region, which on this screen is
   * several times the frame. Every box clears its content on all four sides,
   * which is also what makes the swaying layers safe: their raster is cut
   * through transparent pixels, so rotating and scaling it can never drag a
   * hard edge into view.
   */
  const GROUPS = {
    horizon: {
      crop: /** @type {const} */ ([0, 700, 1600, 300]),
      defs: F_B18 + G_CORNERWARM,
      body:
        '<ellipse cx="120" cy="1010" rx="560" ry="230" fill="url(#cornerwarm)" filter="url(#b18)"/>' +
        '<ellipse cx="1480" cy="1010" rx="560" ry="230" fill="url(#cornerwarm)" filter="url(#b18)"/>' +
        '<ellipse cx="800" cy="1030" rx="900" ry="200" fill="url(#cornerwarm)" filter="url(#b18)" opacity=".8"/>',
    },
    streamersA: {
      crop: /** @type {const} */ ([-140, 110, 1880, 680]),
      defs: F_ROUGH + G_STREAMERFADE + P_PETAL + P_PETAL_LONG,
      body:
        '<g filter="url(#rough)" fill="url(#streamerFade)">' +
        '<use href="#petalLong" transform="translate(800 440) rotate(4) translate(150 0)"/>' +
        '<use href="#petal" transform="translate(800 440) rotate(-19) translate(152 0) scale(.9)"/>' +
        '<use href="#petalLong" transform="translate(800 440) rotate(168) translate(150 0) scale(1.06)"/>' +
        '<use href="#petal" transform="translate(800 440) rotate(196) translate(152 0) scale(.84)"/>' +
        '<use href="#petal" transform="translate(800 440) rotate(24) translate(150 0) scale(.62)"/>' +
        '<use href="#petal" transform="translate(800 440) rotate(149) translate(150 0) scale(.58)"/>' +
        "</g>",
    },
    streamersB: {
      crop: /** @type {const} */ ([80, 140, 1410, 600]),
      defs: F_ROUGH2 + G_STREAMERFADE + P_WISP + P_PETAL,
      body:
        '<g filter="url(#rough2)" fill="url(#streamerFade)">' +
        '<use href="#wisp" transform="translate(800 440) rotate(-8) translate(158 0) scale(1.15)"/>' +
        '<use href="#wisp" transform="translate(800 440) rotate(13) translate(158 0)"/>' +
        '<use href="#wisp" transform="translate(800 440) rotate(186) translate(158 0) scale(1.2)"/>' +
        '<use href="#wisp" transform="translate(800 440) rotate(160) translate(158 0) scale(.9)"/>' +
        '<use href="#wisp" transform="translate(800 440) rotate(-38) translate(154 0) scale(.55)"/>' +
        '<use href="#wisp" transform="translate(800 440) rotate(212) translate(154 0) scale(.5)"/>' +
        '<use href="#wisp" transform="translate(800 440) rotate(31) translate(156 0) scale(.72)"/>' +
        '<use href="#wisp" transform="translate(800 440) rotate(174) translate(156 0) scale(.66)"/>' +
        '<use href="#petal" transform="translate(800 440) rotate(-9) translate(150 0) scale(.45)"/>' +
        '<use href="#petal" transform="translate(800 440) rotate(190) translate(150 0) scale(.4)"/>' +
        "</g>",
    },
    filaments: {
      crop: /** @type {const} */ ([130, 50, 1350, 770]),
      defs: F_B2,
      body:
        '<g stroke="#f4e6c6" fill="none" filter="url(#b2)">' +
        '<path d="M 962 420 C 1120 396, 1260 400, 1420 428" stroke-width="1.1" opacity=".2"/>' +
        '<path d="M 964 452 C 1130 470, 1280 476, 1450 460" stroke-width="1" opacity=".16"/>' +
        '<path d="M 960 478 C 1100 508, 1230 520, 1330 540" stroke-width=".9" opacity=".12"/>' +
        '<path d="M 638 424 C 480 400, 340 402, 180 432" stroke-width="1.1" opacity=".2"/>' +
        '<path d="M 636 456 C 470 476, 320 480, 160 462" stroke-width="1" opacity=".15"/>' +
        '<path d="M 642 486 C 500 514, 380 524, 290 546" stroke-width=".9" opacity=".12"/>' +
        '<g stroke-width=".9">' +
        '<path d="M 782 272 C 776 210, 770 160, 758 96" opacity=".15"/>' +
        '<path d="M 800 268 C 800 200, 802 150, 804 84" opacity=".18"/>' +
        '<path d="M 818 272 C 826 208, 834 158, 846 100" opacity=".15"/>' +
        '<path d="M 764 278 C 748 224, 734 180, 712 128" opacity=".11"/>' +
        '<path d="M 836 278 C 854 222, 868 178, 892 124" opacity=".11"/>' +
        '<path d="M 784 608 C 776 664, 768 710, 754 768" opacity=".14"/>' +
        '<path d="M 802 612 C 802 676, 804 724, 806 788" opacity=".17"/>' +
        '<path d="M 820 608 C 830 668, 840 714, 854 770" opacity=".14"/>' +
        '<path d="M 762 602 C 746 652, 732 694, 710 744" opacity=".1"/>' +
        '<path d="M 838 602 C 858 654, 872 696, 896 748" opacity=".1"/>' +
        "</g></g>",
    },
    prom1: {
      crop: /** @type {const} */ ([639, 291, 78, 78]),
      defs: F_B4P + G_PROMG,
      body: '<circle cx="678" cy="330" r="17" fill="url(#promg)" filter="url(#b4p)"/>',
    },
    prom2: {
      crop: /** @type {const} */ ([905, 469, 86, 86]),
      defs: F_B4P + G_PROMG,
      body: '<circle cx="948" cy="512" r="21" fill="url(#promg)" filter="url(#b4p)"/>',
    },
    prom3: {
      crop: /** @type {const} */ ([707, 565, 70, 70]),
      defs: F_B4P + G_PROMG,
      body: '<circle cx="742" cy="600" r="13" fill="url(#promg)" filter="url(#b4p)"/>',
    },
    prom4: {
      crop: /** @type {const} */ ([908, 298, 88, 78]),
      defs: F_B4P,
      body: '<path d="M 930 350 q 26 -30 44 -2 q -18 -14 -30 6 Z" fill="#ff9d9d" filter="url(#b4p)"/>',
    },
    prom5: {
      crop: /** @type {const} */ ([599, 433, 74, 74]),
      defs: F_B4P + G_PROMG,
      body: '<circle cx="636" cy="470" r="15" fill="url(#promg)" filter="url(#b4p)"/>',
    },
    prom6: {
      crop: /** @type {const} */ ([610, 534, 84, 88]),
      defs: F_B4P,
      body: '<path d="M 662 556 q -30 22 -12 44 q 2 -22 22 -30 Z" fill="#ff8fa8" filter="url(#b4p)"/>',
    },
    chromo: {
      crop: /** @type {const} */ ([585, 225, 430, 430]),
      defs: F_B9,
      body:
        '<circle cx="800" cy="440" r="170" fill="none" stroke="#ffb46a" stroke-width="7" filter="url(#b9)"/>',
    },
    ringInner: {
      crop: /** @type {const} */ ([615, 255, 370, 370]),
      defs: F_B2,
      body:
        '<circle cx="800" cy="440" r="170" fill="none" stroke="#ffe9bd" stroke-width="3.2" filter="url(#b2)"/>',
    },
    /* The diamond ring goes in as ONE raster: `.flare` fades and scales the
       whole group together and nothing inside it moves on its own, so the
       unfiltered circles and glint strokes ride along rather than staying
       live behind an <image> that would only have to be stacked around them. */
    flare: {
      crop: /** @type {const} */ ([575, 110, 745, 475]),
      defs: F_B9 + F_B4 + F_B2 + G_FLAREG,
      body:
        '<circle cx="948" cy="348" r="230" fill="url(#flareg)"/>' +
        '<circle cx="948" cy="348" r="60" fill="url(#flareg)"/>' +
        '<ellipse cx="948" cy="348" rx="330" ry="7" fill="#ffd98a" opacity=".5" filter="url(#b9)"/>' +
        '<ellipse cx="948" cy="345" rx="290" ry="4" fill="#ff9a5e" opacity=".35" filter="url(#b4)"/>' +
        '<ellipse cx="948" cy="351" rx="290" ry="4" fill="#9ec5ff" opacity=".3" filter="url(#b4)"/>' +
        '<ellipse cx="948" cy="348" rx="190" ry="2.4" fill="#fffdf6" opacity=".95" filter="url(#b2)"/>' +
        '<g stroke="#fff6e0" stroke-linecap="round">' +
        '<path d="M 948 178 L 948 518" stroke-width="2.2" opacity=".75"/>' +
        '<path d="M 878 244 L 1018 452" stroke-width="1.1" opacity=".45"/>' +
        '<path d="M 1018 244 L 878 452" stroke-width="1.1" opacity=".45"/>' +
        "</g>" +
        '<circle cx="948" cy="348" r="9" fill="#ffffff"/>' +
        '<circle cx="948" cy="348" r="16" fill="none" stroke="#ffffff" stroke-width="1" opacity=".55" filter="url(#b2)"/>',
    },
  };

  /**
   * Snaps a crop box to the device-pixel grid at this scale, so the raster's
   * first pixel lands exactly on a frame pixel. Returns the box in both units.
   * @param {readonly [number, number, number, number]} crop @param {number} scale
   */
  function frameOf(crop, scale) {
    const [x, y, w, h] = crop;
    const px = Math.floor(x * scale), py = Math.floor(y * scale);
    const pw = Math.max(1, Math.ceil((x + w) * scale) - px);
    const ph = Math.max(1, Math.ceil((y + h) * scale) - py);
    return { pw, ph, x: px / scale, y: py / scale, w: pw / scale, h: ph / scale };
  }

  /** A frame's rest between rasters, so each one is its own short task. */
  const breathe = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  /** @type {HTMLDivElement} */
  let world;

  onMount(() => {
    let cancelled = false;
    /** @type {ReturnType<typeof setTimeout>} */
    let timer;
    /* A resize part-way through a build starts a new one; the older build
       must then stop landing rasters at the old scale in between the new
       one's. Each build takes a number and gives up once it is stale. */
    let generation = 0;

    async function build() {
      const mine = ++generation;
      const stale = () => cancelled || mine !== generation;
      const rect = world.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      /* Capped at 2, as Grain/Dawn/Dusk cap it: retina stays crisp without a
         3x display doubling every raster for no visible gain. The scale is
         the SAME one the outer svg's xMidYMid-slice transform applies, so
         each raster lands at the device-pixel resolution it is shown at and
         compositing it back is a 1:1 blit, not a resample. */
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = Math.max(rect.width / 1600, rect.height / 1000) * dpr;

      /* Marks this surface for the fidelity gate (screens.spec.js), which
         waits for it before screenshotting so the async decode below can
         never race a capture. Set before the first await, so it is in the
         DOM by the time mount returns and the gate cannot look too early. */
      world.dataset.rasterised = "pending";

      /* One raster per frame, not thirteen in one task (#798): each is
         rendered, encoded and set aside on its own, with a frame's rest
         before the next, so the page keeps painting through the build. The
         hrefs are then landed together in one tick, so the corona arrives as
         one picture rather than layer by layer. */
      /** @type {[string, string, HTMLImageElement][]} */
      const built = [];
      for (const [name, { crop, defs, body }] of Object.entries(GROUPS)) {
        const f = frameOf(crop, scale);
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${f.pw}" height="${f.ph}" ` +
          `viewBox="${f.x} ${f.y} ${f.w} ${f.h}"><defs>${defs}</defs>${body}</svg>`;
        const url = await rasteriseSvg(`maintenance-${name}|${f.pw}|${f.ph}`, svg, f.pw, f.ph);
        if (stale()) return;
        /* Setting an href is not showing the picture: the PNG behind it is
           decoded asynchronously, and thirteen set in one tick still paint
           one by one as each decode finishes (seen on an iPhone, #902).
           Decoding each here, while it is still this raster's own task,
           puts the bitmap in the image cache before the landing tick, so
           the hrefs below paint together. The element is kept so the cache
           cannot drop the bitmap between now and then. */
        const warm = new Image();
        warm.src = url;
        await warm.decode().catch(() => {});
        if (stale()) return;
        built.push([name, url, warm]);
        await breathe();
        if (stale()) return;
      }

      for (const [name, url] of built) {
        const img = world.querySelector(`image[data-r="${name}"]`);
        const f = frameOf(GROUPS[/** @type {keyof typeof GROUPS} */ (name)].crop, scale);
        img?.setAttribute("x", String(f.x));
        img?.setAttribute("y", String(f.y));
        img?.setAttribute("width", String(f.w));
        img?.setAttribute("height", String(f.h));
        img?.setAttribute("href", url);
      }
      world.dataset.rasterised = "ready";
    }

    function onResize() {
      clearTimeout(timer);
      timer = setTimeout(build, 120);
    }

    build();
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  });
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <title>Orbit — maintenance</title>
</svelte:head>

<div class="sky"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="stargl" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="var(--star-near)" stop-opacity=".5"/>
      <stop offset="100%" stop-color="var(--star-near)" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <g class="sky-drift-far" fill="var(--star-far)"><g id="farstars"></g><use href="#farstars" x="1600"/></g>
  <g class="sky-drift-near"><g id="nearstars"></g><use href="#nearstars" x="1600"/></g>
</svg></div>

<!--
  #902: every filtered layer below is an <image> whose raster is built once at
  mount (see the script block) — the class it used to carry moves onto the
  <image>, so the sway, the breath and the flicker still run, they just move a
  picture instead of re-running a blur or a displacement map every frame. The
  live <filter> definitions are gone with them: each raster body carries its
  own copy, so the paint tree has no filter left to declare a region for.
-->
<div class="world" style="position:fixed;inset:0;z-index:1" bind:this={world}><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" style="width:100%;height:100%">
  <defs>
    <!-- totality sky: the eerie 360-degree sunset around the whole horizon -->
    <linearGradient id="duskband" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e2772b" stop-opacity="0"/>
      <stop offset="55%" stop-color="#e2772b" stop-opacity=".1"/>
      <stop offset="85%" stop-color="#f0a35a" stop-opacity=".22"/>
      <stop offset="100%" stop-color="#ffd9a0" stop-opacity=".3"/>
    </linearGradient>

    <!-- corona -->
    <radialGradient id="coronaIn" cx="50%" cy="50%" r="50%">
      <stop offset="38%" stop-color="#fff8ea" stop-opacity="0"/>
      <stop offset="41%" stop-color="#fff8ea" stop-opacity=".85"/>
      <stop offset="48%" stop-color="#ffedc8" stop-opacity=".4"/>
      <stop offset="62%" stop-color="#f5d9a0" stop-opacity=".12"/>
      <stop offset="100%" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="coronaWide" cx="50%" cy="50%" r="50%">
      <stop offset="24%" stop-color="#f7e8c8" stop-opacity=".3"/>
      <stop offset="55%" stop-color="#e8d4ae" stop-opacity=".1"/>
      <stop offset="100%" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="washg" cx="59.25%" cy="34.8%" r="85%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="30%" stop-color="#fff6e0"/>
      <stop offset="70%" stop-color="#f8dca4" stop-opacity=".75"/>
      <stop offset="100%" stop-color="#e8b25e" stop-opacity=".45"/>
    </radialGradient>
    <radialGradient id="moonshade" cx="42%" cy="60%" r="75%">
      <stop offset="0%" stop-color="#0a0c13"/>
      <stop offset="70%" stop-color="#050609"/>
      <stop offset="100%" stop-color="#010203"/>
    </radialGradient>
  </defs>

  <!-- horizon: sunset in every direction. The rect carries no filter, so it
       stays live (nothing to gain); the three warm ellipses are the raster,
       and the group keeps the opacity breath for both. -->
  <g class="horizon">
    <rect x="0" y="700" width="1600" height="300" fill="url(#duskband)"/>
    <image data-r="horizon" preserveAspectRatio="none"/>
  </g>

  <!-- wide corona haze -->
  <g class="corona-wide">
    <ellipse cx="800" cy="440" rx="760" ry="330" fill="url(#coronaWide)"/>
    <circle cx="800" cy="440" r="430" fill="url(#coronaIn)"/>
  </g>

  <!-- streamers: pulled long at the equator, brushed short at the poles.
       One raster each, because sway-a and sway-b run different periods and
       ranges — the rotation and the screen blend ride the <image>. -->
  <image class="streamers-a" data-r="streamersA" preserveAspectRatio="none"/>
  <image class="streamers-b" data-r="streamersB" opacity=".8" preserveAspectRatio="none"/>

  <!-- fine filaments and polar brushes: the iron-filing structure -->
  <image class="filaments" data-r="filaments" preserveAspectRatio="none"/>

  <!-- prominences: pink fire at the limb, behind the moon's edge. Six rasters,
       not one: each flickers on its own period, and a single raster of the
       whole b4 group would have frozen five of them into the sixth's fade.
       Order and per-shape opacity are unchanged; the shapes are far enough
       apart that blurring them separately is the same picture. -->
  <image class="prom"    data-r="prom1" preserveAspectRatio="none"/>
  <image class="prom p2" data-r="prom2" preserveAspectRatio="none"/>
  <image class="prom p3" data-r="prom3" preserveAspectRatio="none"/>
  <image class="prom p2" data-r="prom4" opacity=".6" preserveAspectRatio="none"/>
  <image class="prom p3" data-r="prom5" preserveAspectRatio="none"/>
  <image class="prom"    data-r="prom6" opacity=".5" preserveAspectRatio="none"/>

  <!-- the moon: black, with the faintest earthshine mottle -->
  <circle cx="800" cy="440" r="170" fill="url(#moonshade)"/>

  <!-- chromosphere + photon ring. The two blurred rings are rasters; the
       crisp 1.2-wide ring has no filter, so it stays a live circle. -->
  <image data-r="chromo" opacity=".22" preserveAspectRatio="none"/>
  <image class="ring-inner" data-r="ringInner" opacity=".8" preserveAspectRatio="none"/>
  <circle cx="800" cy="440" r="170" fill="none" stroke="#fffdf6" stroke-width="1.2" opacity=".95"/>

  <!-- transit is the progress bar -->
  <circle class="progress" pathLength="100" cx="800" cy="440" r="186" fill="none"
          stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" opacity=".5"
          transform="rotate(-90 800 440)"/>

  <!-- the diamond ring: service returning (demo loops). The whole group is one
       raster — the bloom, the anamorphic streak and the six-point glint all
       fade and scale together, so nothing in it needed to stay live. -->
  <image class="flare" data-r="flare" preserveAspectRatio="none"/>
  <circle class="flarewave" cx="948" cy="348" r="30" fill="none" stroke="#ffe9bd" stroke-width="2"/>
  <circle class="ringflare" cx="800" cy="440" r="170" fill="none" stroke="#ffffff" stroke-width="3.4"/>
  <rect class="wash" x="0" y="0" width="1600" height="1000" fill="url(#washg)"/>
</svg></div>

<main class="notice">
  <h1 class="msg">maintenance — back soon</h1>

  {#if latest}
    <article class="latest">
      <p class="when">
        <time datetime={latest.publishedAt}>{when(latest.publishedAt, { utc: !local })}</time>{kindLabel(latest.kind)}
      </p>
      <p class="body">{latest.body}</p>
    </article>
  {/if}

  {#if data.maintenance.expectedEndAt}
    <p class="back">
      back by <time datetime={data.maintenance.expectedEndAt}>{clock(data.maintenance.expectedEndAt, { utc: !local })}</time>
    </p>
  {/if}

  {#if earlier.length > 0}
    <details class="earlier">
      <summary aria-label="Earlier updates">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </summary>
      <ol class="log">
        {#each earlier as entry (entry.id)}
          <li>
            <p class="when">
              <time datetime={entry.publishedAt}>{when(entry.publishedAt, { utc: !local })}</time>{kindLabel(entry.kind)}
            </p>
            <p class="body">{entry.body}</p>
          </li>
        {/each}
      </ol>
    </details>
  {/if}
</main>

<Grain slope={0.09} />

<div class="vignette" style="background:radial-gradient(ellipse at 50% 44%,transparent 46%,rgba(0,0,0,.42) 100%)"></div>
