/**
 * The drifting starfield behind the hero-sky dial (issue #327, spec:
 * docs/design/v19/home.html, POL-11 "constant drift"). Two tiled depth
 * layers of generated stars, each duplicated once and translated by
 * exactly one tile width so the loop is seamless (no snap, no reversal);
 * drift is perceptible within a few seconds at these durations (the v18
 * owner rule POL-11 records — ported unchanged from the mockup, which
 * already tuned them against that rule).
 *
 * Star placement uses a small seeded PRNG (not `Math.random()`), so the
 * server-rendered and client-hydrated markup are byte-identical and never
 * mismatch. Both layer opacity and the vignette reuse the `--stars` token
 * (#325) — already 0 for the light packs (atlas/dawn) — so the sky and
 * its vignette fade out together with no per-component theme branching.
 * `prefers-reduced-motion: reduce` stills the drift entirely (POL-11).
 */

const TILE_WIDTH = 1600;
const TILE_HEIGHT = 1000;

function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

interface Star {
  cx: number;
  cy: number;
  r: number;
  opacity: number;
}

function generateStars(
  seed: number,
  count: number,
  radius: readonly [number, number],
  opacity: readonly [number, number],
): Star[] {
  const rng = makeRng(seed);
  return Array.from({ length: count }, () => ({
    cx: Number((rng() * TILE_WIDTH).toFixed(1)),
    cy: Number((rng() * TILE_HEIGHT).toFixed(1)),
    r: Number((radius[0] + rng() * (radius[1] - radius[0])).toFixed(2)),
    opacity: Number((opacity[0] + rng() * (opacity[1] - opacity[0])).toFixed(2)),
  }));
}

// Same seeds/counts/ranges as the v19 mockup's generator (docs/design/v19/home.html).
const FAR_STARS = generateStars(17170812, 95, [0.4, 0.9], [0.12, 0.35]);
const NEAR_STARS = generateStars(88451913, 46, [0.8, 1.5], [0.3, 0.7]);

function StarLayer({ stars }: { stars: Star[] }) {
  return (
    <>
      {stars.map((star, index) => (
        <circle key={index} cx={star.cx} cy={star.cy} r={star.r} opacity={star.opacity} />
      ))}
    </>
  );
}

export function Starfield() {
  return (
    <div className="starfield" aria-hidden="true">
      <style>{`
        .starfield{position:absolute;inset:0;overflow:hidden;pointer-events:none;opacity:var(--stars);transition:opacity .4s;z-index:0}
        .starfield svg{position:absolute;inset:0;width:100%;height:100%}
        .starfield .sf-far{animation:sf-drift 400s linear infinite}
        .starfield .sf-near{animation:sf-drift 195s linear infinite}
        @keyframes sf-drift{to{transform:translateX(-${TILE_WIDTH}px)}}
        .starfield .vignette{position:absolute;inset:0;opacity:var(--stars);
          background:radial-gradient(ellipse at 50% 34%, transparent 55%, rgba(0,0,0,.28) 100%)}
        @media (prefers-reduced-motion: reduce){
          .starfield .sf-far,.starfield .sf-near{animation:none!important}
        }
      `}</style>
      <svg viewBox={`0 0 ${TILE_WIDTH} ${TILE_HEIGHT}`} preserveAspectRatio="xMidYMid slice">
        <g className="sf-far" fill="var(--ink)">
          <g><StarLayer stars={FAR_STARS} /></g>
          <g transform={`translate(${TILE_WIDTH},0)`}><StarLayer stars={FAR_STARS} /></g>
        </g>
        <g className="sf-near" fill="var(--ink)">
          <g><StarLayer stars={NEAR_STARS} /></g>
          <g transform={`translate(${TILE_WIDTH},0)`}><StarLayer stars={NEAR_STARS} /></g>
        </g>
      </svg>
      <div className="vignette" />
    </div>
  );
}
