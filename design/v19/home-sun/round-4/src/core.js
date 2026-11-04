/* Shared by g, h and i (build.py pastes this into each file). One data story,
   one geometry, one label placer: the three files differ only in what they
   paint and what they let you touch. */
const SKY = (() => {
  const TODAY = '2026-08-13';           // the fixture's pinned date (workspace.js fixtureToday)
  const U = { RIM: 166, ZERO: 62, CLEAR: 24, SUN_R: 7 };
  const TAU_O = 7, OVERDUE_SPAN = 60;   // the overdue mirror curve
  const SCENES = {
    desk:  { S: 1.684, W: 780, H: 640, CX: 390, CY: 320, size: [3.5, 13], font: 12, name: 10 },
    phone: { S: 0.942, W: 390, H: 372, CX: 195, CY: 186, size: [5, 12],   font: 12, name: 14 / 0.942 },
  };

  /* Harlow Home, as fixtures/workspace.js has it. importance is the mock-up's
     own field (H, I): three high, one normal, two low, one not set. */
  const ITEMS = [
    { id: 'gutter',  title: 'Gutter clearing',       due: '2026-07-28', cost: 15000,   rec: 12, docs: 0, imp: 'high' },
    { id: 'mot',     title: 'Car MOT — Volvo V60', due: '2026-08-29', cost: 5485,    rec: 12, docs: 2, imp: 'high' },
    { id: 'boiler',  title: 'Boiler service',        due: '2026-09-04', cost: 12000,   rec: 12, docs: 0, imp: 'normal' },
    { id: 'chimney', title: 'Chimney sweep',         due: '2026-10-13', cost: 9000,    rec: 12, docs: 0, imp: 'low' },
    { id: 'roof',    title: 'Roof replacement',      due: '2026-11-21', cost: 5000000, rec: 12, docs: 1, imp: 'high' },
    { id: 'smoke',   title: 'Smoke alarm batteries', due: '2026-12-13', cost: 1200,    rec: 6,  docs: 0, imp: 'low' },
    { id: 'svc',     title: 'Car full service',      due: '2027-01-21', cost: 30000,   rec: 12, docs: 2, imp: null },
  ];
  //@g
  /* Invented items for the scale question only (G's "Demo items" switch): days from
     the fixture's today, yearly cost in pounds. Not in the fixture; household
     items are never changed by them. */
  const EXTRA_ROWS = [
    ['window',   'Window cleaner',            -3,   180],
    ['bike',     'Bike service',              -20,  60],
    ['tv',       'TV licence',                2,    170],
    ['salt',     'Water softener salt',       4,    90],
    ['home-ins', 'Home insurance',            12,   640],
    ['car-ins',  'Car insurance',             18,   720],
    ['gas',      'Gas safety certificate',    45,   95],
    ['alarm',    'Smoke alarm replacement',   60,   40],
    ['eicr',     'EICR electrical check',     120,  180],
    ['lic-sam',  'Driving licence — Sam',     200,  14],
    ['pass-alex','Passport — Alex',           280,  88],
    ['b-warr',   'Boiler warranty',           420,  0],
    ['r-guar',   'Roof guarantee',            540,  0],
    ['mortgage', 'Mortgage fix ends',         800,  0],
    ['pass-sam', 'Passport — Sam',            1100, 88],
    ['will',     'Will review',               1500, 250],
  ];
  const EXTRAS = EXTRA_ROWS.map(([id, title, days, pounds]) => ({
    id, title, due: new Date(Date.parse(TODAY) + days * 864e5).toISOString().slice(0, 10),
    cost: pounds * 100, rec: 12, docs: 0, imp: null, extra: true,
  }));
  //@end
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  //@g
  [...ITEMS, ...EXTRAS].forEach((it) => { it.days = daysBetween(TODAY, it.due); });
  //@hi
  ITEMS.forEach((it) => { it.days = daysBetween(TODAY, it.due); });
  //@end

  const bandOf = (d) => (d < 0 ? 'overdue' : d <= 30 ? 'due-soon' : d <= 90 ? 'upcoming' : 'ok');
  const BAND_VAR = { overdue: '--overdue', 'due-soon': '--warm', upcoming: '--upcoming', ok: '--ok' };
  const tminus = (d) => (d < 0 ? `T+${-d}d` : `T−${d}d`);
  const money = (minor) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100);

  /* chart.js bodySize: power curve, GBP 50/yr to GBP 50,000/yr */
  const sizeU = (it, [rMin, rMax]) => {
    const yearly = (it.cost / 100) * (it.rec > 0 ? 12 / it.rec : 1);
    const k = Math.log(rMax / rMin) / Math.log(1000);
    return Math.round(Math.min(rMax, Math.max(rMin, rMin * Math.pow(yearly / 50, k))) * 10) / 10;
  };

  /* Distance in dial units. linear = today's dialPlacement; log = the lane design. */
  const radiusU = (d, p) => {
    if (p.mode === 'linear') {
      return d >= 0 ? Math.min(U.ZERO + 0.242 * d, U.RIM) : Math.max(U.CLEAR, U.ZERO - 0.625 * -d);
    }
    if (d >= 0) {
      const f = Math.min(1, Math.log(1 + d / p.tau) / Math.log(1 + p.D / p.tau));
      return U.ZERO + (U.RIM - U.ZERO) * f;
    }
    const f = Math.log(1 + -d / TAU_O) / Math.log(1 + OVERDUE_SPAN / TAU_O);
    return Math.max(U.CLEAR, U.ZERO - (U.ZERO - U.CLEAR) * f);
  };
  /* Bearing is today's law: one degree a day from twelve o'clock, clamped. */
  const bearing = (d) => (Math.max(-90, Math.min(d, 430)) - 90) * Math.PI / 180;

  const canvas = document.createElement('canvas').getContext('2d');
  const measure = (text, px) => {
    canvas.font = `400 ${px}px "Inter Variable"`;
    return canvas.measureText(text).width;
  };

  const hit = (r, c, pad) => {       // rect r against circle c
    const nx = Math.max(r.x0, Math.min(c.x, r.x1)), ny = Math.max(r.y0, Math.min(c.y, r.y1));
    return Math.hypot(nx - c.x, ny - c.y) < c.r + pad;
  };
  const overlap = (a, b, pad) => a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.y0 < b.y1 + pad && a.y1 > b.y0 - pad;

  /* Labels: set just outside the planet on its radial line, away from the sun.
     Inner planets place first; a label that would collide shifts along its own
     ring by the smallest angle that clears, and a shift longer than the label's
     own height gets a hairline leader. */
  function placeLabels(wanted, planets, fixed, sc) {
    const h = 14, gap = 4, placed = [], out = [];
    const discs = planets.map((p) => ({ x: p.x, y: p.y, r: p.pr + 1.5 }));
    const inBounds = (r) => r.x0 >= 4 && r.x1 <= sc.W - 4 && r.y0 >= 4 && r.y1 <= sc.H - 4;
    const clear = (r) => inBounds(r)
      && !placed.some((q) => overlap(r, q, 3))
      && !fixed.some((q) => overlap(r, q, 3))
      && !discs.some((c) => hit(r, c, 2));
    [...wanted].sort((a, b) => a.rpx - b.rpx).forEach((p) => {
      const w = measure(p.title, sc.font) + 2;
      const at = (th, extra) => {
        const ring = p.rpx + p.pr + gap + extra, ux = Math.cos(th), uy = Math.sin(th);
        const ax = sc.CX + ring * ux, ay = sc.CY + ring * uy, cx = ax + ux * w / 2, cy = ay + uy * h / 2;
        return { ring, r: { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 }, cx, cy };
      };
      let best = null;
      const ownClear = (r) => !hit(r, { x: p.x, y: p.y, r: p.pr + 1.5 }, 2);
      for (let k = 0; k <= 140 && !best; k++) {
        for (const sgn of (k === 0 ? [0] : [1, -1])) {
          const th = p.theta + sgn * k * Math.PI / 180;
          /* push outward only as far as clears the planet's own disc */
          let c = at(th, 0);
          for (let e = 1; e <= 30 && !ownClear(c.r); e++) c = at(th, e);
          if (clear(c.r)) { best = { ...c, deg: sgn * k }; break; }
        }
      }
      if (!best) { best = { ...at(p.theta, 0), deg: 0, crowded: true }; }
      placed.push(best.r);
      const moved = Math.abs(best.deg) * Math.PI / 180 * best.ring;
      let leader = null;
      const gapPx = (() => { const r = best.r; const nx = Math.max(r.x0, Math.min(p.x, r.x1)), ny = Math.max(r.y0, Math.min(p.y, r.y1)); return Math.hypot(nx - p.x, ny - p.y) - p.pr; })();
      if (moved > h && gapPx > 7) {
        const r = best.r;
        const nx = Math.max(r.x0, Math.min(p.x, r.x1)), ny = Math.max(r.y0, Math.min(p.y, r.y1));
        const d = Math.hypot(nx - p.x, ny - p.y) || 1;
        leader = { x1: p.x + (nx - p.x) / d * (p.pr + 1), y1: p.y + (ny - p.y) / d * (p.pr + 1), x2: nx, y2: ny };
      }
      out.push({ id: p.id, title: p.title, x: best.cx, y: best.cy, leader, crowded: Boolean(best.crowded) });
    });
    return out;
  }

  const fx = (n) => Math.round(n * 10) / 10;

  /* opts: scene, mode, tau, D, driver ('due'|'warn'), labels ('off'|'near'|'all'),
     rings (bool), paint(item, geo) -> svg, pin (item id | null) */
  function render(host, opts) {
    const sc = SCENES[opts.scene], S = sc.S;
    opts.name = opts.name || 'Harlow Home';
    const p = { mode: opts.mode, tau: opts.tau, D: opts.D };
    const shift = opts.driver === 'warn' ? 30 : 0;
    //@g
    const items = opts.extras ? ITEMS.concat(EXTRAS) : ITEMS;
    const geo = items.map((it) => {
      const d = it.days - shift;
      const ru = radiusU(d, p), th = bearing(d), rpx = ru * S;
      const sz = sizeU(it, sc.size);
      return { it, d, ru, theta: th, rpx, x: sc.CX + Math.cos(th) * rpx, y: sc.CY + Math.sin(th) * rpx, pr: sz * S, sz, rim: d >= 0 && ru >= U.RIM - 1e-6 };
    });
    /* Items on the rim: the bearing clamp stacks them on one angle, so spread them
       along the rim. The first seated keeps its own bearing; each later one takes the
       smallest angle shift (either side) that clears every planet already placed. */
    /* With the demo extras on, every planet gets the same treatment (the extras
       crowd the near bearings too): household items seat first, inner before outer,
       and only a planet that would touch one already seated is moved. Household
       only, just the rim items are spread. */
    const all = Boolean(opts.extras);
    const movers = geo.filter((g) => (all ? true : g.rim))
      .sort((a, b) => (a.it.extra ? 1 : 0) - (b.it.extra ? 1 : 0) || a.ru - b.ru || a.d - b.d);
    const seated = geo.filter((g) => !movers.includes(g));
    movers.forEach((g) => {
      const free = (th) => {
        const x = sc.CX + Math.cos(th) * g.rpx, y = sc.CY + Math.sin(th) * g.rpx;
        return seated.every((o) => Math.hypot(o.x - x, o.y - y) >= o.pr + g.pr + 3) ? { x, y } : null;
      };
      for (let k = 0; k <= 1440; k++) {
        let hit = null;
        for (const sgn of (k === 0 ? [0] : [1, -1])) {
          const th = g.theta + sgn * k * 0.25 * Math.PI / 180, f = free(th);
          if (f) { hit = { th, ...f }; break; }
        }
        if (hit) { g.theta = hit.th; g.x = hit.x; g.y = hit.y; break; }
      }
      seated.push(g);
    });
    //@hi
    const geo = ITEMS.map((it) => {
      const d = it.days - shift;
      const ru = radiusU(d, p), th = bearing(d), rpx = ru * S;
      const sz = sizeU(it, sc.size);
      return { it, d, ru, theta: th, rpx, x: sc.CX + Math.cos(th) * rpx, y: sc.CY + Math.sin(th) * rpx, pr: sz * S, sz };
    });
    //@end
    const near = radiusU(30, p) * S;           // "near only": inside the 30-day ring
    const wanted = geo.filter((g) => opts.labels === 'all' || (opts.labels === 'near' && g.rpx < near - 0.01))
      .filter((g) => g.it.id !== opts.pin)
      .map((g) => ({ id: g.it.id, title: g.it.title, rpx: g.rpx, pr: g.pr + (opts.pad || 0), theta: g.theta, x: g.x, y: g.y }));

    /* things a label must keep off: the sun's name, the ring captions */
    const fixed = [];
    const nameY = sc.CY + 22 * S, nameW = measure(opts.name, sc.name * S);
    fixed.push({ x0: sc.CX - nameW / 2, x1: sc.CX + nameW / 2, y0: nameY - sc.name * S * 0.8, y1: nameY + sc.name * S * 0.25 });
    const caps = [];
    if (opts.rings) {
      const spokes = [[7, 205], [30, 185], [90, 165], [365, 145]];
      spokes.forEach(([day, deg]) => {
        const r = radiusU(day, p) * S, a = deg * Math.PI / 180;
        caps.push({ text: `${day}d`, x: sc.CX + Math.cos(a) * r, y: sc.CY + Math.sin(a) * r, r });
      });
    }
    caps.forEach((c) => fixed.push({ x0: c.x - 14, x1: c.x + 14, y0: c.y - 7, y1: c.y + 7 }));
    const labels = placeLabels(wanted, geo.map((g) => ({ x: g.x, y: g.y, pr: g.pr + (opts.pad || 0) })), fixed, sc);

    const c = (u) => fx(u * S);
    //@g
    let svg = `<svg width="${sc.W}" height="${sc.H}" viewBox="0 0 ${sc.W} ${sc.H}" role="img" aria-label="Harlow Home sky: ${items.length} planets">`;
    //@hi
    let svg = `<svg width="${sc.W}" height="${sc.H}" viewBox="0 0 ${sc.W} ${sc.H}" role="img" aria-label="Harlow Home sky: ${ITEMS.length} planets">`;
    //@end
    svg += `<defs><radialGradient id="sunglow-${opts.scene}"><stop offset="0" stop-color="#dbe9ff" stop-opacity=".55"/><stop offset=".35" stop-color="#dbe9ff" stop-opacity=".16"/><stop offset="1" stop-color="#dbe9ff" stop-opacity="0"/></radialGradient></defs>`;
    /* the dial's furniture */
    svg += `<circle cx="${sc.CX}" cy="${sc.CY}" r="${c(U.ZERO)}" fill="rgba(248,113,113,.05)"/>`;
    svg += `<circle cx="${sc.CX}" cy="${sc.CY}" r="${c(U.RIM)}" fill="none" stroke="#2a3550" stroke-width="1.5"/>`;
    svg += `<circle cx="${sc.CX}" cy="${sc.CY}" r="${c(U.ZERO)}" fill="none" stroke="var(--overdue)" stroke-opacity=".3" stroke-dasharray="3 5"/>`;
    svg += `<circle cx="${sc.CX}" cy="${sc.CY}" r="${c(U.CLEAR)}" fill="none" stroke="var(--overdue)" stroke-opacity=".5" stroke-dasharray="2 3"/>`;
    svg += `<path d="M${sc.CX} ${sc.CY - c(U.RIM) - 3 * S} l${5.5 * S} ${-9 * S} h${-11 * S} Z" fill="var(--accent)"/>`;
    if (opts.rings) {
      [7, 30, 90, 365].forEach((day) => {
        svg += `<circle cx="${sc.CX}" cy="${sc.CY}" r="${fx(radiusU(day, p) * S)}" fill="none" stroke="var(--ink-2)" stroke-opacity=".24" stroke-width=".75"/>`;
      });
      caps.forEach((cp) => {
        svg += `<text x="${fx(cp.x)}" y="${fx(cp.y)}" dy=".35em" text-anchor="middle" font-size="10" font-family="var(--mono)" fill="var(--ink-3)" stroke="var(--bg)" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${cp.text}</text>`;
      });
    }
    /* event-horizon and today captions, tiny, below the sun on their own spokes */
    const cap = (txt, deg, ru) => {
      const a = deg * Math.PI / 180;
      return `<text x="${fx(sc.CX + Math.cos(a) * ru * S)}" y="${fx(sc.CY + Math.sin(a) * ru * S)}" dy=".35em" text-anchor="middle" font-size="10" font-family="var(--mono)" fill="var(--ink-3)" stroke="var(--bg)" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${txt}</text>`;
    };
    if (opts.scene === 'desk') {
      svg += cap('event horizon', 90, U.CLEAR + 6.8);
      svg += cap('today', 122, U.ZERO);
    }
    /* sun */
    svg += `<circle cx="${sc.CX}" cy="${sc.CY}" r="${c(22)}" fill="url(#sunglow-${opts.scene})"/>`;
    svg += `<circle cx="${sc.CX}" cy="${sc.CY}" r="${c(U.SUN_R)}" fill="var(--sun)"/><circle cx="${sc.CX}" cy="${sc.CY}" r="${c(U.SUN_R * 0.55)}" fill="var(--sun-core)"/>`;
    svg += `<text x="${sc.CX}" y="${fx(nameY)}" text-anchor="middle" font-size="${fx(sc.name * S)}" fill="var(--ink-2)" stroke="var(--bg)" stroke-width="3" paint-order="stroke" stroke-linejoin="round" font-family="var(--ui)">${opts.name}</text>`;
    /* planets, largest first so a small one never hides under a big one */
    [...geo].sort((a, b) => b.sz - a.sz).forEach((g) => {
      svg += `<g class="pl" data-pl="${g.it.id}">${opts.paint(g.it, { x: fx(g.x), y: fx(g.y), r: fx(g.pr), d: g.d })}</g>`;
    });
    labels.forEach((l) => {
      if (l.leader) svg += `<line x1="${fx(l.leader.x1)}" y1="${fx(l.leader.y1)}" x2="${fx(l.leader.x2)}" y2="${fx(l.leader.y2)}" stroke="var(--ink-3)" stroke-width="1" stroke-opacity=".8"/>`;
      svg += `<text data-label="${l.id}" x="${fx(l.x)}" y="${fx(l.y)}" dy=".35em" text-anchor="middle" font-size="${sc.font}" font-family="var(--ui)" fill="var(--ink-2)" stroke="var(--bg)" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${l.title}</text>`;
    });
    if (opts.hover) {
      geo.forEach((g) => { svg += `<circle class="hit" data-hit="${g.it.id}" cx="${fx(g.x)}" cy="${fx(g.y)}" r="${fx(Math.max(g.pr + 3, 11))}"/>`; });
    }
    svg += `</svg>`;
    host.innerHTML = svg;
    host.__geo = geo;
    host.__labels = labels;
    host.__sc = sc;
    host.dataset.crowded = labels.filter((l) => l.crowded).map((l) => l.id).join(',');
    return { geo, labels };
  }

  /* The callout: today's (title, time · cost, documents chip) plus a fourth
     line, set beside the planet on the side away from the sun's axis. */
  function callout(stage, host, id, lines) {
    let el = stage.querySelector('.callout');
    if (!el) { el = document.createElement('div'); el.className = 'callout'; stage.appendChild(el); }
    if (!id) { el.classList.remove('show'); return; }
    const g = host.__geo.find((q) => q.it.id === id), sc = host.__sc;
    const right = g.x >= sc.CX;
    el.innerHTML = `<span class="line"></span><b>${g.it.title}</b><small>${tminus(g.it.days)} · ${money(g.it.cost)}</small>`
      + `<span class="chip">◆ ${g.it.docs} ${g.it.docs === 1 ? 'document' : 'documents'}</span>${lines(g.it)}`;
    el.classList.toggle('has-docs', g.it.docs > 0);
    el.classList.toggle('side-right', right);
    el.classList.toggle('side-left', !right);
    const off = g.pr + 34;
    el.style.left = right ? `${g.x + off}px` : '';
    el.style.right = right ? '' : `${sc.W - (g.x - off)}px`;
    el.style.top = `${g.y - el.offsetHeight / 2}px`;
    el.classList.add('show');
  }

  //@g
  return { ITEMS, EXTRAS, SCENES, U, radiusU, bearing, sizeU, render, callout, tminus, money, bandOf, BAND_VAR, fx, TODAY };
  //@hi
  return { ITEMS, SCENES, U, radiusU, bearing, sizeU, render, callout, tminus, money, bandOf, BAND_VAR, fx, TODAY };
  //@end
})();

/* the highlight dot every dial body wears from r >= 4 (home +page.svelte bodyMark) */
const shine = (x, y, r) => (r >= 4 ? `<circle cx="${x - 0.2 * r}" cy="${y + 0.25 * r}" r="${(0.33 * r).toFixed(1)}" fill="rgba(255,255,255,.38)"/>` : '');
