#!/usr/bin/env python3
"""Builds g-log-tuner.html, h-importance-weights.html and i-importance-hues.html
from src/core.css + src/core.js (one geometry, one label placer, one data story)
and the per-direction parts below.  python3 build.py"""
import pathlib

here = pathlib.Path(__file__).parent
CSS = (here / 'src/core.css').read_text()
CORE = (here / 'src/core.js').read_text()


def core(variant):
    """src/core.js carries the demo extras for G only. Lines between //@g and
    //@hi (or //@end) are G's; lines between //@hi and //@end are H's and I's
    (the plain core, no extras). The marker lines themselves never ship."""
    out, mode = [], None
    for line in CORE.splitlines(keepends=True):
        mark = line.strip()
        if mark in ('//@g', '//@hi'):
            mode = mark[3:]
        elif mark == '//@end':
            mode = None
        elif mode is None or mode == variant:
            out.append(line)
    return ''.join(out)

HEAD = '''<!doctype html>
<html lang="en" data-theme="afterdark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
{css}
{extra_css}
</style>
</head>
'''

# ---------------------------------------------------------------- G
G_CSS = '''
.panel{flex:none;width:330px;margin-top:18px;background:var(--panel-raised);border:1px solid var(--line);border-radius:14px;padding:18px 18px 14px}
.panel h2{font:600 11px var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3);margin-bottom:12px}
.panel fieldset{border:0;margin:0 0 16px;padding:0}
.panel legend{font:600 13px var(--ui);color:var(--ink);padding:0;margin-bottom:7px}
.seg{display:flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}
.seg label{flex:1;text-align:center;font:12.5px var(--ui);color:var(--ink-2);padding:7px 4px;cursor:pointer;border-left:1px solid var(--line);position:relative}
.seg label:first-child{border-left:0}
.seg input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer}
.seg label:has(input:checked){background:rgba(125,211,252,.16);color:var(--ink)}
.seg label:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:-2px}
.hint{font-size:11.5px;color:var(--ink-3);margin-top:6px;line-height:1.45}
.slide{margin-bottom:16px}
.slide .row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px}
.slide .row b{font:600 13px var(--ui);color:var(--ink)}
.slide .row output{font:12.5px var(--mono);color:var(--accent)}
.slide input{width:100%;accent-color:var(--accent);margin:0}
.slide .ends{display:flex;justify-content:space-between;font:11px var(--mono);color:var(--ink-3)}
.slide.off{opacity:.4}
.read{width:100%;border-collapse:collapse;font:12px var(--mono);color:var(--ink-2);margin-top:2px}
.read th{font-weight:400;color:var(--ink-3);text-align:left;padding:3px 0;border-bottom:1px solid var(--line)}
.read td{padding:4px 0}
.read td:last-child,.read th:last-child{text-align:right}
.read .sum{color:var(--ink);padding:0 0 8px;font-size:12.5px}
'''

G_DESK = '''
<section class="scene-desk">
  <div class="desk-head"><h1>Home sky · log tuner</h1><p>Harlow Home · today is 13 Aug 2026 (the fixture’s pinned date) · mock-up, not the app</p><span class="tag">round 4 · G</span></div>
  <div class="desk-body">
    <div class="stage" id="gstage"><div id="gsky"></div></div>
    <aside class="panel" aria-label="Sky controls (desk only)">
      <h2>Sky controls</h2>
      <fieldset><legend>Distance scale</legend>
        <div class="seg"><label><input type="radio" name="mode" value="linear">linear (today)</label><label><input type="radio" name="mode" value="log" checked>log</label></div>
      </fieldset>
      <div class="slide" id="s-tau"><div class="row"><b>Close-up: the next</b><output id="o-tau"></output></div><input id="tau" type="range" min="7" max="90" step="1" value="30" aria-label="Close-up, in days"><div class="ends"><span>7 d</span><span>90 d</span></div></div>
      <div class="slide" id="s-D"><div class="row"><b>Horizon D</b><output id="o-D"></output></div><input id="D" type="range" min="180" max="1095" step="5" value="730" aria-label="Horizon D in days"><div class="ends"><span>180 d</span><span>1095 d</span></div></div>
      <fieldset><legend>Driving date</legend>
        <div class="seg"><label><input type="radio" name="driver" value="due" checked>due date</label><label><input type="radio" name="driver" value="warn">my warning date</label></div>
        <p class="hint">Warning date = due date − 30 days, for every item in this mock-up. It moves position and bearing; colour still follows the real due date.</p>
      </fieldset>
      <fieldset><legend>Planet labels</legend>
        <div class="seg"><label><input type="radio" name="labels" value="off">off</label><label><input type="radio" name="labels" value="near" checked>near only</label><label><input type="radio" name="labels" value="all">all</label></div>
        <p class="hint">Near only = planets inside the 30-day ring.</p>
      </fieldset>
      <fieldset><legend>Demo items</legend>
        <div class="seg"><label><input type="radio" name="extras" value="off" checked>household only</label><label><input type="radio" name="extras" value="on">plus far-off extras</label></div>
        <p class="hint">The 16 extras are invented, to judge the scale only: 2 overdue and 14 ahead, out to 1500 days. They are not in the Harlow fixture.</p>
      </fieldset>
      <table class="read" aria-live="polite"><thead><tr><th colspan="3" class="sum" id="sum"></th></tr><tr><th>mark</th><th>ring radius</th><th></th></tr></thead><tbody id="readout"></tbody></table>
    </aside>
  </div>
</section>
<section class="scene-phone">
  <div class="phone">
    <div class="bar"><b>Harlow Home</b><span>sky</span></div>
    <div class="stage" id="pstage"><div id="psky"></div></div>
    <p class="note">Log scale at the starting values (close-up 30 d, horizon 730 d), driven by the due date. Labels: near only. The controls are desk-only.</p>
  </div>
</section>
'''

G_JS = '''
const q = new URLSearchParams(location.search);
const st = {
  mode: q.get('mode') || 'log', tau: +(q.get('tau') || 30), D: +(q.get('D') || 730),
  driver: q.get('driver') || 'due', labels: q.get('labels') || 'near',
  extras: ['on', '1'].includes(q.get('extras')) ? 'on' : 'off',
};
const paintG = (it, g) => {
  const col = `var(${SKY.BAND_VAR[SKY.bandOf(it.days)]})`;
  return `<circle cx="${g.x}" cy="${g.y}" r="${g.r}" fill="${col}" stroke="var(--bg)" stroke-width="2"/>${shine(g.x, g.y, g.r)}`;
};
const gsky = document.getElementById('gsky');
function drawDesk() {
  const { geo } = SKY.render(gsky, { scene: 'desk', mode: st.mode, tau: st.tau, D: st.D, driver: st.driver, labels: st.labels, extras: st.extras === 'on', rings: true, paint: paintG });
  document.getElementById('o-tau').textContent = st.tau + ' days';
  document.getElementById('o-D').textContent = st.D + ' days';
  document.getElementById('tau').value = st.tau;
  document.getElementById('D').value = st.D;
  document.getElementById('s-tau').classList.toggle('off', st.mode === 'linear');
  document.getElementById('s-D').classList.toggle('off', st.mode === 'linear');
  document.getElementById('tau').disabled = st.mode === 'linear';
  document.getElementById('D').disabled = st.mode === 'linear';
  document.getElementById('sum').textContent = st.mode === 'linear'
    ? 'linear (today) \\u00b7 rim at 166'
    : `\\u03c4 ${st.tau} d \\u00b7 D ${st.D} d \\u00b7 rim beyond D`;
  const p = { mode: st.mode, tau: st.tau, D: st.D };
  document.getElementById('readout').innerHTML = [7, 30, 90, 365].map((d) =>
    `<tr><td>${d}-day ring</td><td>r ${SKY.radiusU(d, p).toFixed(1)}</td><td>${(SKY.radiusU(d, p) * SKY.SCENES.desk.S).toFixed(0)} px</td></tr>`).join('')
    + `<tr><td colspan="2">on the rim</td><td>${geo.filter((g) => g.rim).length} of ${geo.length}</td></tr>`;
  for (const [name, val] of [['mode', st.mode], ['driver', st.driver], ['labels', st.labels], ['extras', st.extras]]) {
    for (const r of document.querySelectorAll(`input[name=${name}]`)) r.checked = r.value === val;
  }
  document.body.dataset.crowded = gsky.dataset.crowded;
}
for (const name of ['mode', 'driver', 'labels', 'extras']) {
  for (const r of document.querySelectorAll(`input[name=${name}]`)) r.addEventListener('change', () => { st[name] = r.value; drawDesk(); });
}
document.getElementById('tau').addEventListener('input', (e) => { st.tau = +e.target.value; drawDesk(); });
document.getElementById('D').addEventListener('input', (e) => { st.D = +e.target.value; drawDesk(); });
function drawPhone() {
  SKY.render(document.getElementById('psky'), { scene: 'phone', mode: 'log', tau: 30, D: 730, driver: 'due', labels: 'near', rings: true, paint: paintG });
}
'''

G_BOOT = '''
drawDesk(); drawPhone();
'''

# ------------------------------------------------------------ H / I
HI_CSS = '''
.hi-body{max-width:1180px;margin:0 auto;padding:0 24px;display:flex;flex-direction:column;align-items:center}
.hi-body .legend{margin-top:2px;text-align:center}
.hi-body .legend .key{justify-content:center}
.pal{display:flex;gap:14px;font:11.5px var(--mono);color:var(--ink-3);align-items:center}
'''

HI_DESK = '''
<section class="scene-desk">
  <div class="desk-head"><h1>Home sky · {name}</h1><p>Harlow Home · today is 13 Aug 2026 (the fixture’s pinned date) · hover a planet · mock-up, not the app</p><span class="tag">round 4 · {letter}</span></div>
  <div class="hi-body">
    <div class="stage" id="gstage"><div id="gsky"></div></div>
    <div class="legend"><div class="rule">Colour shows importance · distance shows time · size shows yearly cost</div><div class="key" id="gkey"></div></div>
  </div>
</section>
<section class="scene-phone">
  <div class="phone">
    <div class="bar"><b>Harlow Home</b><span>sky</span></div>
    <div class="stage" id="pstage"><div id="psky"></div></div>
    <div class="legend"><div class="rule">Colour shows importance · distance shows time · size shows yearly cost</div><div class="key" id="pkey"></div></div>
    <p class="note">On a phone a planet opens with two taps, not a hover; the callout is the desk’s.</p>
  </div>
</section>
'''

HI_JS = '''
const PAL = __PAL__;
const IMP_WORD = { high: 'high', normal: 'normal', low: 'low' };
function paintImp(it, g) {
  const x = g.x, y = g.y, r = g.r, imp = it.imp, overdue = it.days < 0;
  const set = PAL[imp || 'unset'];
  let s = '';
  if (!imp) {
    s += `<circle cx="${x}" cy="${y}" r="${r}" fill="${set.fill}" stroke="var(--bg)" stroke-width="2"/>`;
    s += `<circle cx="${x}" cy="${y}" r="${(r + 3.5).toFixed(1)}" fill="none" stroke="var(--ink-3)" stroke-width="1.4" stroke-dasharray="0.1 3.4" stroke-linecap="round"/>`;
    s += shine(x, y, r);
  } else {
    s += `<circle cx="${x}" cy="${y}" r="${r}" fill="${set.fill}" fill-opacity="${set.opacity}" stroke="var(--bg)" stroke-width="2"/>`;
    if (set.ring) s += `<circle cx="${x}" cy="${y}" r="${(r + 3.5).toFixed(1)}" fill="none" stroke="${set.fill}" stroke-width="2"/>`;
    s += shine(x, y, r);
  }
  if (overdue) {
    const col = set.fill, base = r + (set.ring ? 3.5 : 3);
    s += `<circle class="pulse" cx="${x}" cy="${y}" r="${base.toFixed(1)}" fill="none" stroke="${col}" stroke-width="1.5"/>`;
    s += `<circle class="dash" cx="${x}" cy="${y}" r="${(base + 4.5).toFixed(1)}" fill="none" stroke="${col}" stroke-width="1.4" stroke-dasharray="4 3" stroke-opacity=".9"/>`;
  }
  return s;
}
function impLine(it) {
  if (!it.imp) return `<span class="imp"><i style="border:1.5px dotted var(--ink-3)"></i>importance not set</span>`;
  const set = PAL[it.imp];
  return `<span class="imp"><i style="background:${set.fill};opacity:${set.opacity}"></i>Importance: ${IMP_WORD[it.imp]}</span>`;
}
function keyHtml() {
  const mk = (imp, label) => {
    const it = { imp, days: 1 };
    return `<span><svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">${paintImp(it, { x: 11, y: 11, r: 5.5 })}</svg>${label}</span>`;
  };
  return mk('high', 'high') + mk('normal', 'normal') + mk('low', 'low') + mk(null, 'not set yet');
}
function drawDesk() {
  const host = document.getElementById('gsky');
  SKY.render(host, { scene: 'desk', mode: 'log', tau: 30, D: 730, driver: 'due', labels: 'all', rings: false, pad: 4.5, paint: paintImp, hover: true, pin: pinned });
  for (const h of host.querySelectorAll('.hit')) {
    h.addEventListener('mouseenter', () => show(h.dataset.hit));
    h.addEventListener('mouseleave', () => show(pinned));
  }
  show(pinned);
}
let pinned = new URLSearchParams(location.search).get('pin') || 'svc';
function show(id) {
  const host = document.getElementById('gsky');
  SKY.callout(document.getElementById('gstage'), host, id, impLine);
}
function drawPhone() {
  SKY.render(document.getElementById('psky'), { scene: 'phone', mode: 'log', tau: 30, D: 730, driver: 'due', labels: 'near', rings: false, pad: 4.5, paint: paintImp });
}
document.getElementById('gkey').innerHTML = keyHtml();
document.getElementById('pkey').innerHTML = keyHtml();
'''

HI_BOOT = '''
drawDesk(); drawPhone();
'''

PAL_H = '''{
  high:   { fill: 'var(--accent)', opacity: 1,  ring: true },
  normal: { fill: 'var(--accent)', opacity: .7, ring: false },
  low:    { fill: 'var(--ink-3)',  opacity: 1,  ring: false },
  unset:  { fill: 'var(--ink-4)',  opacity: 1,  ring: false },
}'''
PAL_I = '''{
  high:   { fill: 'var(--ember)',  opacity: 1, ring: false },
  normal: { fill: 'var(--accent)', opacity: 1, ring: false },
  low:    { fill: 'var(--slate)',  opacity: 1, ring: false },
  unset:  { fill: 'var(--ink-4)',  opacity: 1, ring: false },
}'''

TAIL = '''
<script>
{js}
{boot_wrap}
</script>
</body>
</html>
'''

def page(title, extra_css, body, js, boot, variant):
    boot_wrap = '''(async () => {
  await Promise.all([document.fonts.load('400 12px "Inter Variable"'), document.fonts.load('400 12px "JetBrains Mono Variable"')]);
  const s = new URLSearchParams(location.search).get('scene');
  document.body.dataset.scene = s === 'phone' ? 'phone' : 'desk';
  %s
  window.__ready = true;
})();''' % boot
    out = HEAD.format(title=title, css=CSS, extra_css=extra_css) + '<body data-scene="desk">\n' + body + TAIL.format(js=core(variant) + js, boot_wrap=boot_wrap)
    return out

(here / 'g-log-tuner.html').write_text(page('Home sky: log tuner', G_CSS, G_DESK, G_JS, G_BOOT, 'g'))
(here / 'h-importance-weights.html').write_text(page(
    'Home sky: importance as weight', HI_CSS,
    HI_DESK.format(name='importance as weight', letter='H'), HI_JS.replace('__PAL__', PAL_H), HI_BOOT, 'hi'))
(here / 'i-importance-hues.html').write_text(page(
    'Home sky: importance as hue', HI_CSS,
    HI_DESK.format(name='importance as hue', letter='I'), HI_JS.replace('__PAL__', PAL_I), HI_BOOT, 'hi'))
print('built')
