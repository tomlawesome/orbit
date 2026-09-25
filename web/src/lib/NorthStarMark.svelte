<script>
  /* First, with no comment of its own: Svelte hoists $props.id() and would
     carry a leading doc comment into the compiled declaration (#1120). */
  const uid = $props.id();
  /**
   * The north star's mark (#1120): the desk's create handle, drawn in its
   * three forms, one per pack family: the four-point glint, retrograde's
   * wireframe beacon and clouds' sounding balloon (§15). Lifted out of
   * home's +page.svelte so the pocket's north star (NorthStar.svelte) draws
   * the same mark rather than a copy; the pack chooses the form in CSS here.
   * The gradient id is per instance, so two marks in one document (the
   * desk's and the pocket's, one of them hidden) never share a reference.
   * @typedef {{ size?: number }} Props
   */
  /** @type {Props} */
  let { size = 30 } = $props();
</script>

<svg class="nsmark" width={size} height={size} viewBox="-15 -15 30 30" aria-hidden="true">
  <defs>
    <linearGradient id="{uid}-edge" x1="0" y1="-11" x2="0" y2="11" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="var(--upcoming)"/>
      <stop offset=".55" stop-color="var(--upcoming)"/>
      <stop offset="1" stop-color="var(--accent)"/>
    </linearGradient>
  </defs>
  <!-- the mark has THREE forms and only one is ever up: the four-point
       glint every pack has always had, retrograde's neon wireframe beacon
       (§15/#480), and clouds' sounding balloon (§15, the roster ruling:
       "clouds needs ... its own custom symbols"). The pack chooses between
       them in CSS. -->
  <g class="glint classic" style="transform-origin:0 0">
    <circle r="9" fill="var(--ink)" opacity=".12"/>
    <path d="M 0 -12 L 1.7 -1.7 L 12 0 L 1.7 1.7 L 0 12 L -1.7 1.7 L -12 0 L -1.7 -1.7 Z"
          fill="var(--ink)" opacity=".9"/>
    <circle r="2" fill="var(--ink)"/>
  </g>
  <g class="glint tron" style="transform-origin:0 0">
    <circle r="9.5" fill="var(--upcoming)" opacity=".06"/>
    <path d="M 0 -11 L 7.6 0 L 0 11 L -7.6 0 Z" fill="none"
          stroke="url(#{uid}-edge)" stroke-width="1.5" stroke-linejoin="miter"/>
    <path d="M 0 -4.6 L 3.2 0 L 0 4.6 L -3.2 0 Z" fill="none"
          stroke="var(--accent)" stroke-width="1" opacity=".9"/>
    <g stroke="url(#{uid}-edge)" stroke-width="1.3" stroke-linecap="round" opacity=".75">
      <line x1="-13.4" y1="0" x2="-10" y2="0"/>
      <line x1="10" y1="0" x2="13.4" y2="0"/>
    </g>
  </g>
  <!-- CLOUDS' OWN MARK — THE SOUNDING BALLOON (§15: every theme earns its
       own symbols; only star-chart and after dark share theirs).

       WHY IT CANNOT BE A STAR. This pack's sky is DAYLIGHT above a cloud
       deck. There is no north star up there to steer by, and drawing one
       anyway is the exact failure §12 forbids — a mark on the screen that
       is not true of what the screen is showing. So the question the mark
       has to answer is the honest one: at altitude, in daylight, what do
       you send UP to put something new into the sky? A sounding. A pilot
       balloon carrying an instrument, released to add one real reading to
       the record — which is what this handle does when it opens the create
       drawer, said in the vocabulary the pack already speaks.

       WHAT IT KEEPS FROM THE GLINT, and why. Retrograde's beacon held the
       old mark's silhouette on purpose ("still reads as a beacon at a
       glance"), and the reasoning travels: this is the same 30px box, the
       same vertical axis, and the two reticle ticks sit at exactly the same
       ±13.4 the glint's horizontal arms did, so the mark's footprint in the
       chrome is unchanged and the eye finds it in the same place. What
       moves is only what it is made of.

       WHAT IT IS MADE OF, and why that is not decoration. Light packs do
       not glow — that law is older than this pack (#426: weight instead of
       luminosity, flat ink instead of gloss) — so the balloon is drawn,
       not lit: the envelope a thin engraved outline with a single pale
       highlight where the low sun catches its shoulder, the rigging two
       hairlines, and the instrument a small SOLID box in the accent at the
       bottom of the axis. The solid box is the one loud element and it is
       load-bearing twice over: it is the only filled shape, so it is what
       the eye lands on, and it sits at the low end of the axis, pointing
       at the drawer the handle pulls — the same job the tron diamond's
       downward vertex does in retrograde. Nothing here is added for
       prettiness; take any one part away and the mark stops reading as an
       instrument going up. -->
  <g class="glint sonde" style="transform-origin:0 0">
    <!-- the envelope: a real pilot balloon is a slightly pear-shaped
         sphere, wider than it is tall at the shoulder and drawn in by the
         neck, which is what stops this reading as a lollipop -->
    <path d="M 0 -12.6 C 5.2 -12.6 7.4 -8.6 7.4 -5.4
             C 7.4 -2.1 4.4 .1 1.5 1.6 L -1.5 1.6
             C -4.4 .1 -7.4 -2.1 -7.4 -5.4
             C -7.4 -8.6 -5.2 -12.6 0 -12.6 Z"
          fill="none" stroke="var(--ink)" stroke-width="1.3"
          stroke-linejoin="round" opacity=".9"/>
    <!-- the shoulder the low sun catches. One stroke, on the sunward side
         only, because there is one light source in this sky and it is the
         reason the pack exists -->
    <path d="M -4.6 -9.4 C -3.2 -11.2 -1.6 -11.8 -.2 -11.9"
          fill="none" stroke="var(--sun)" stroke-width="1.1"
          stroke-linecap="round" opacity=".85"/>
    <!-- the rigging: two hairlines from the neck to the instrument -->
    <g stroke="var(--ink)" stroke-width=".9" opacity=".78">
      <line x1="-1.5" y1="1.9" x2="-1.1" y2="7.2"/>
      <line x1="1.5" y1="1.9" x2="1.1" y2="7.2"/>
    </g>
    <!-- the instrument: the one solid shape, in the create colour, at the
         low end of the axis, pointing at the drawer -->
    <rect x="-3.1" y="7.2" width="6.2" height="5" rx="1.1"
          fill="var(--accent-text)"/>
    <!-- and the reticle ticks, at the glint's own ±13.4 -->
    <g stroke="var(--ink)" stroke-width="1.2" stroke-linecap="round" opacity=".78">
      <line x1="-13.4" y1="0" x2="-10" y2="0"/>
      <line x1="10" y1="0" x2="13.4" y2="0"/>
    </g>
  </g>
</svg>

<style>
  .nsmark{overflow:visible}
  .tron,.sonde{display:none}
  :global([data-theme=retrograde]) .classic{display:none}
  :global([data-theme=retrograde]) .tron{display:block;filter:drop-shadow(0 0 3px var(--bloom))}
  :global([data-theme=clouds]) .classic{display:none}
  :global([data-theme=clouds]) .sonde{display:block}
</style>
