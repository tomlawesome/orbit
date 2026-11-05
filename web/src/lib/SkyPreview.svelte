<script>
  /*
   * The live sky under Settings > Planets (#1461), drawn as core.js `render`
   * draws it (design/v19/home-sun/round-6/src/core.js, the phone scene the
   * mock-up uses for both dialects), with the app's own geometry: the seated
   * pocket placements from chart.js (`dialBodiesOf`) and the label placer.
   * Planets sit by the reader's driver (#1462) and wear today's band colours; on the phone only the planets the pocket dial draws; section colour comes with #1463.
   * A picture, not a control: no hover, no callouts, nothing to focus.
   */
  import { dialBodiesOf } from "$lib/data/chart.js";
  import { pocketBodiesOf } from "../routes/home/pocket-dial.js";
  import { SKY_SCENES, skyLabelsOf } from "$lib/data/sky-labels.js";
  import { skyMeasure } from "$lib/sky-measure.js";

  /** @type {{ household: any, today: string, labelDays: number, skyDriver?: "due" | "warning", planetSize?: "cost" | "importance", firstWarningDays?: ?number, dialect: "desk" | "pocket", uid?: string }} */
  let { household, today, labelDays, skyDriver = "due", planetSize = "cost", firstWarningDays = null, dialect, uid = "pv" } = $props();

  const sc = SKY_SCENES.pocket, S = sc.S;
  const U = { RIM: 166, ZERO: 62, CLEAR: 24, SUN_R: 7 };
  const fx = (/** @type {number} */ n) => Math.round(n * 10) / 10;
  const c = (/** @type {number} */ u) => fx(u * S);
  const sky = skyMeasure(dialect);
  const name = $derived(household?.name ?? "");
  /* The planets the real dial of this dialect draws: the desk draws them all, the
     pocket its own filter (pocketBodiesOf), so the picture and its names follow. */
  const bodies = $derived.by(() => {
    const all = dialBodiesOf(household ?? null, { today, skyDriver, planetSize, firstWarningDays });
    return dialect === "pocket" ? pocketBodiesOf(all) : all;
  });
  /* the mock-up's scene px: the dial's seat, centred on the scene's own middle */
  const planets = $derived(bodies.map((b) => ({
    ...b, x: fx(sc.CX + (b.pocketPlacement.x - 190) * S), y: fx(sc.CY + (b.pocketPlacement.y - 190) * S), r: fx(b.pocketSize * S),
  })));
  const names = $derived(
    $sky.current
      ? skyLabelsOf(bodies.map((b) => ({ id: b.id, title: b.title, days: b.days, drivingDays: b.drivingDays, place: b.pocketPlacement, radius: b.pocketSize })),
          { scene: "pocket", labelDays, name, nameAt: { y: 212, size: sc.name }, measure: $sky.current, px: true })
      : { labels: [], font: sc.font, scale: 1 },
  );
  const SPHERES = new Set(["ruby", "jade", "amber", "sky"]);
  /** The planet's own colour by paint, for the hollow draw (#1463). */
  const INK = { ruby: "var(--overdue)", amber: "var(--due-soon)", sky: "var(--upcoming)", jade: "var(--ok)" };
  const hollowInk = (/** @type {{ paint: string }} */ p) => /** @type {Record<string,string>} */ (INK)[p.paint] ?? "var(--ink-mid)";
  const shine = (/** @type {{ x: number, y: number, r: number }} */ p) => p.r >= 4;
  const nameY = $derived(fx(sc.CY + 22 * S));
  const nameSize = $derived(fx(sc.name * S));
</script>

<svg width={sc.W} height={sc.H} viewBox="0 0 {sc.W} {sc.H}" role="img"
     aria-label="{name ? `${name} sky` : "Your sky"}: {planets.length} {planets.length === 1 ? "planet" : "planets"}, {names.labels.length} {names.labels.length === 1 ? "name" : "names"} shown">
  <defs>
    <radialGradient id="{uid}-glow"><stop offset="0" stop-color="#dbe9ff" stop-opacity=".55"/><stop offset=".35" stop-color="#dbe9ff" stop-opacity=".16"/><stop offset="1" stop-color="#dbe9ff" stop-opacity="0"/></radialGradient>
    {#each [["ruby", "#ffb3ab", "#e0453e", "#7e1a1f"], ["jade", "#b8f5cf", "#2fae6a", "#12603a"], ["amber", "#ffe1a0", "#f0a52b", "#8a5a10"], ["sky", "#cfe4ff", "#6fa3ef", "#2a4f8f"]] as [id, a, b, d] (id)}
      <radialGradient id="{uid}-{id}" cx="34%" cy="30%" r="72%">
        <stop offset="0%" stop-color="var(--p-{id}-1, {a})"/><stop offset="45%" stop-color="var(--p-{id}-2, {b})"/><stop offset="100%" stop-color="var(--p-{id}-3, {d})"/>
      </radialGradient>
    {/each}
  </defs>
  <circle cx={sc.CX} cy={sc.CY} r={c(U.ZERO)} fill="rgba(248,113,113,.05)"/>
  <circle cx={sc.CX} cy={sc.CY} r={c(U.RIM)} fill="none" stroke="#2a3550" stroke-width="1.5"/>
  <circle cx={sc.CX} cy={sc.CY} r={c(U.ZERO)} fill="none" stroke="var(--overdue)" stroke-opacity=".3" stroke-dasharray="3 5"/>
  <circle cx={sc.CX} cy={sc.CY} r={c(U.CLEAR)} fill="none" stroke="var(--overdue)" stroke-opacity=".5" stroke-dasharray="2 3"/>
  <path d="M{sc.CX} {sc.CY - c(U.RIM) - 3 * S} l{5.5 * S} {-9 * S} h{-11 * S} Z" fill="var(--accent)"/>
  <circle cx={sc.CX} cy={sc.CY} r={c(22)} fill="url(#{uid}-glow)"/>
  <circle cx={sc.CX} cy={sc.CY} r={c(U.SUN_R)} fill="var(--sun)"/><circle cx={sc.CX} cy={sc.CY} r={c(U.SUN_R * 0.55)} fill="var(--sun-core)"/>
  <text x={sc.CX} y={nameY} text-anchor="middle" font-size={nameSize} fill="var(--ink-mid)" stroke="var(--bg)" stroke-width="3" paint-order="stroke" stroke-linejoin="round" font-family="var(--ui)">{name}</text>
  {#each [...planets].sort((a, b) => b.pocketSize - a.pocketSize) as p (p.id)}
    <g class="pl" data-pl={p.id}>
      {#if p.hollow}
        <circle cx={p.x} cy={p.y} r={p.r} style="fill:{hollowInk(p)};stroke:{hollowInk(p)}" fill-opacity=".22" stroke-width="1.5" stroke-dasharray="2 2.5"/>
      {:else if SPHERES.has(p.paint)}
        <circle cx={p.x} cy={p.y} r={p.r} fill="url(#{uid}-{p.paint})" stroke="var(--bg)" stroke-width="2"/>
      {:else}
        <circle cx={p.x} cy={p.y} r={p.r} fill="var(--ink-mid)" stroke="var(--bg)" stroke-width="2"/>
      {/if}
      {#if !p.hollow && shine(p)}<circle cx={fx(p.x - 0.2 * p.r)} cy={fx(p.y + 0.25 * p.r)} r={(0.33 * p.r).toFixed(1)} fill="rgba(255,255,255,.38)"/>{/if}
    </g>
  {/each}
  <g class="pv-names" aria-hidden="true">
    {#each names.labels as l (l.id)}
      {#if l.leader}
        <line x1={fx(l.leader.x1)} y1={fx(l.leader.y1)} x2={fx(l.leader.x2)} y2={fx(l.leader.y2)} stroke="var(--ink-faint)" stroke-width="1" stroke-opacity=".8"/>
      {/if}
      <text data-label={l.id} x={fx(l.x)} y={fx(l.y)} dy=".35em" text-anchor="middle" font-size={names.font} font-family="var(--ui)"
            fill="var(--ink-mid)" stroke="var(--bg)" stroke-width="3" paint-order="stroke" stroke-linejoin="round">{l.title}</text>
    {/each}
  </g>
</svg>

<style>
  svg { display: block; overflow: visible; }
  .pv-names, .pv-names :global(*) { pointer-events: none; }
</style>
