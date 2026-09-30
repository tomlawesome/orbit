<script>
  import Grain from "$lib/Grain.svelte";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { createStars } from "./stumble.js";

  /**
   * The stumble (#1139): a server fault draws its own digits, tumbling —
   * "Orbit lost control", not "you did something wrong". Same family
   * grammar as the 404 (world, heading, two lines) but nothing here is
   * filtered and nothing is built at mount: the scene is plain static
   * markup, so the server's HTML is already the finished picture. Motion is
   * CSS transform/opacity only (stumble.css).
   *
   * Built from the #1139 design notes, owned here from that point on.
   */
  let { status } = $props();

  const CX = [560, 800, 1040];
  const stars = createStars();
  const digits = $derived(String(status).split(""));
</script>

<div class="stumble">
  <div class="world">
    <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id="stargl" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#e8edff" stop-opacity=".45"/>
          <stop offset="100%" stop-color="#e8edff" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="haze" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#3f7ac4" stop-opacity="0"/>
          <stop offset="97.5%" stop-color="#3f7ac4" stop-opacity="0"/>
          <stop offset="97.9%" stop-color="#3f7ac4" stop-opacity=".28"/>
          <stop offset="99%" stop-color="#3f7ac4" stop-opacity=".08"/>
          <stop offset="100%" stop-color="#3f7ac4" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="body" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#020409"/>
          <stop offset="95%" stop-color="#020409"/>
          <stop offset="97.6%" stop-color="#0a1428"/>
          <stop offset="98.8%" stop-color="#1d3f70"/>
          <stop offset="99.4%" stop-color="#4a86cf" stop-opacity=".8"/>
          <stop offset="99.8%" stop-color="#b9dbff" stop-opacity=".5"/>
          <stop offset="100%" stop-color="#b9dbff" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="glyphg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f2ecdd"/>
          <stop offset="100%" stop-color="#b8ac8e"/>
        </linearGradient>
      </defs>

      <!-- Stars: a static field from createStars() (stumble.js), computed on
           the server too so the HTML arrives with the sky already drawn. -->
      <g class="stars">
        <g fill="#dbe2f5">
          {#each stars.far as st, j (j)}
            <circle cx={st.x.toFixed(1)} cy={st.y.toFixed(1)} r={st.r.toFixed(2)} opacity={st.o.toFixed(2)}/>
          {/each}
        </g>
        <g fill="#e8edff">
          {#each stars.near as st, j (j)}
            <circle cx={st.x.toFixed(1)} cy={st.y.toFixed(1)} r={(st.r * 3.4).toFixed(1)} fill="url(#stargl)"/>
            <circle cx={st.x.toFixed(1)} cy={st.y.toFixed(1)} r={st.r.toFixed(2)} opacity={st.o.toFixed(2)}/>
          {/each}
        </g>
      </g>

      <!-- The limb: the haze and the planet's body, tilted together. -->
      <g class="limb" transform="rotate(-9 800 500)">
        <circle cx="800" cy="1960" r="1430" fill="url(#haze)" class="haze-breathe"/>
        <circle cx="800" cy="1960" r="1400" fill="url(#body)"/>
      </g>

      <!-- Loose parts: three drifting glyphs, the 404's debris grammar. -->
      <g fill="#cdd6ee" font-family="'JetBrains Mono',monospace" font-size="15">
        <g class="part-a"><text x="700" y="430">.</text></g>
        <g class="part-b"><text x="1120" y="470">-</text></g>
        <g class="part-c"><text x="480" y="640">'</text></g>
      </g>

      <!-- The craft: the status's own digits, each tumbling on its own
           period with two faint, turned and grown afterimages. -->
      <g class="craft">
        {#each CX as cx, i (i)}
          <g class="digit d{i}">
            <text x={cx} y="610" text-anchor="middle" font-family="'Space Grotesk',sans-serif"
                  font-weight="600" font-size="300" fill="#e8dcbc" opacity=".08"
                  transform="translate({cx} 505) rotate(-12) scale(1.06) translate({-cx} -505)">{digits[i]}</text>
            <text x={cx} y="610" text-anchor="middle" font-family="'Space Grotesk',sans-serif"
                  font-weight="600" font-size="300" fill="#e8dcbc" opacity=".16"
                  transform="translate({cx} 505) rotate(-6) scale(1.03) translate({-cx} -505)">{digits[i]}</text>
            <text x={cx} y="610" text-anchor="middle" font-family="'Space Grotesk',sans-serif"
                  font-weight="600" font-size="300" fill="url(#glyphg)">{digits[i]}</text>
          </g>
        {/each}
      </g>
    </svg>
  </div>

  <h1 class="stumbled">Orbit stumbled</h1>
  <div class="line-a">Something went wrong on Orbit's side.</div>
  <!-- `try again` is this same address, reloaded (#1139 notes §4.3), not a route to resolve. -->
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
  <div class="line-b"><a class="again" href={page.url.pathname + page.url.search} data-sveltekit-reload>try again</a><span class="dot" aria-hidden="true">·</span><a class="home" href={resolve("/")}>return home &rarr;</a></div>

  <Grain slope={0.09} />

  <div class="vignette" style="background:radial-gradient(ellipse at 50% 45%,transparent 42%,rgba(0,0,0,.5) 100%)"></div>
</div>
