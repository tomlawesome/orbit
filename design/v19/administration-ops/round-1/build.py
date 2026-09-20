#!/usr/bin/env python3
"""Builds the #1055 round-1 sheets from the ratified administration mockup.

The ratified sheet (design/v19/administration.html, §13) is read and carried
byte-for-byte: its chrome, its cards, its CSS. Only three things are spliced
in — the theme tokens are replaced by web/src/lib/packs.css verbatim (the
mockup's own inlined copy predates the clouds pack), the #1052 new-system form
is drawn resting rather than open, and the machinery card / grid gains the
layer this round proposes. Run from anywhere: `python3 build.py`.
"""
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MOCKUP = (ROOT / "design/v19/administration.html").read_text()
PACKS = (ROOT / "web/src/lib/packs.css").read_text()

# ── the ratified sheet, in pieces ────────────────────────────────────────────
head, rest = MOCKUP.split("  :root{", 1)
_, rest = rest.split("  *{box-sizing:border-box;margin:0}", 1)
ratified_css, rest = rest.split("</style>", 1)
ratified_css = "  *{box-sizing:border-box;margin:0}" + ratified_css
body, tail = rest.split('    <div class="card wide machinery">', 1)
machinery, tail = tail.split("  </div>\n\n  <div class=\"strip\">", 1)
strip_and_footer, script = tail.split("<script>", 1)

# resting sheet: the #1052 form is a press away, not open
body = re.sub(r"      <!-- Drawn OPEN for the record \(#1052\).*?(?=      <div class=\"system\">)", "", body, count=1, flags=re.S)
# After Dark is the default (web/src/lib/theme.js)
body = body.replace('title="star-chart" aria-pressed="true"', 'title="star-chart" aria-pressed="false"')
body = body.replace('title="after dark" aria-pressed="false"', 'title="after dark" aria-pressed="true"')
head = head.replace('data-theme="starchart"', 'data-theme="afterdark"')

# the Operations half as shipped (#1000 dropped the observatory link)
ops_rows = """        <div class="svc"><i style="background:var(--ok)"></i><b>orbit-app</b><small>healthy · 40s ago</small></div>
        <div class="svc"><i style="background:var(--ok)"></i><b>orbit-postgres</b><small>healthy · 40s ago</small></div>
        <div class="svc"><i style="background:var(--ok)"></i><b>orbit-clamav</b><small>healthy · scanning required</small></div>
        <div class="svc"><i style="background:var(--ok)"></i><b>orbit-tika</b><small>running</small></div>
        <div class="svc"><i style="background:var(--ok)"></i><b>scheduler</b><small>running · 12s ago</small></div>
"""

# ── shared new-layer css ─────────────────────────────────────────────────────
SHARED_CSS = """
  /* ── #1055: the pocket holds. The ratified sheet lets a .kv row with a
     trailing button and a .person row overflow 390px; the shipped route
     wraps the person row (#915). Both wraps are carried here so the new
     layer can be judged on a page that fits, and nothing above 560px moves. */
  .person{flex-wrap:wrap}
  .person .who{flex:1 1 60%}
  .person .place:first-of-type{margin-left:auto}
  @media (max-width:560px){
    .kv{flex-wrap:wrap}
    .kv > button{margin-left:auto}
    .kv > button{min-height:44px}
  }
  /* a pressed test while it runs: the button says so and breathes; nothing
     else on the row moves */
  .kv button[disabled]{cursor:default;color:var(--ink-quiet);border-color:var(--line-soft)}
  .kv button.busy{animation:breathe 1.6s ease-in-out infinite}
  @keyframes breathe{50%{opacity:.4}}
  .job i.spin{animation:breathe 1.2s ease-in-out infinite}
  .fade{animation:fadein .22s ease-out}
  @keyframes fadein{from{opacity:0;transform:translateY(-3px)}}

  /* ── sheet furniture: the scene bar (not part of the design) ─────────── */
  .demos{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9;
         display:flex;gap:4px;align-items:center;padding:6px 10px;border-radius:99px;
         background:rgba(4,6,14,.82);border:1px solid rgba(255,255,255,.08);backdrop-filter:blur(10px);
         font:10px var(--mono);letter-spacing:.06em;color:#8791b3;white-space:nowrap}
  .demos span{margin-right:4px}
  .demos button{font:10px var(--mono);letter-spacing:.06em;color:#8791b3;background:none;
                border:1px solid transparent;border-radius:99px;padding:4px 9px;cursor:pointer}
  .demos button:hover{color:#e9edf8}
  .demos button[aria-pressed=true]{color:#d8b45a;border-color:rgba(216,180,90,.35)}
  @media (max-width:560px){.demos{letter-spacing:.02em;padding:4px 6px;max-width:calc(100vw - 16px);
        overflow-x:auto}.demos span{display:none}.demos button{padding:6px 6px}}
  @media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}
  html.shot .demos{display:none}
"""

DEMOS = """
<nav class="demos" aria-label="Design demo: pick a scene">
  <span>SCENE</span>
  <button data-scene="idle" aria-pressed="true">idle</button>
  <button data-scene="checking" aria-pressed="false">checking</button>
  <button data-scene="smtp-failed" aria-pressed="false">relay failed</button>
  <button data-scene="imap-ok" aria-pressed="false">mailbox ok</button>
  <button data-scene="jobs" aria-pressed="false">jobs</button>
  <button data-scene="job-detail" aria-pressed="false">job detail</button>
  <button data-scene="retried" aria-pressed="false">after retry</button>
</nav>
"""

# ── the shared data story (content-free, as the API is) ─────────────────────
# GET /api/admin/operations returns kind, status, attempts, lastErrorCode and
# timestamps for the 25 most recently touched jobs — never a document's name,
# household or bytes. The story: the virus scanner was away 09:40–10:05; it
# is 10:12 now. One scan exhausted its five tries during the outage and one
# stage purge failed at 08:10; a re-key job is retrying; a fresh scan runs.
JOBS = [
    # dot-tone, kind (plain), state words, meta, reason (plain), key
    ("overdue", "virus scan", "failed", "scanner unreachable · 6m ago", "", "j1"),
    ("overdue", "delete bytes", "failed", "deletion failed · 2h ago", "", "j2"),
    ("warm", "re-key", "retrying", "attempt 2 of 5 · next in 40s", "", "j3"),
    ("upcoming", "virus scan", "running", "attempt 1 · 20s ago", "", "j4"),
    ("ok", "virus scan", "done", "3m ago", "", "j5"),
    ("ok", "encrypt", "done", "3m ago", "", "j6"),
]
JOB_DETAIL_WORDS = (
    "The virus scanner couldn’t be reached, five times over 26 minutes. "
    "The upload is held, unscanned, until this succeeds or it is discarded."
)
JOB_DETAIL_META = "attempt 5 of 5 · first tried 32m ago · last tried 6m ago · job 8f3a12c4"
RETRY_WORDS = "Retry queues it as attempt 1 right away. Discard rejects the document and deletes its bytes."


def write(name, css, machinery_html, extra_cards, extra_html, script_js):
    html = (
        head
        + "  " + PACKS.strip() + "\n"
        + ratified_css
        + css
        + "</style>"
        + body.replace("    <!-- §15: mail machinery sits WITH operations — one panel, two halves. -->\n", extra_cards + "    <!-- §15: mail machinery sits WITH operations — one panel, two halves. -->\n")
        + '    <div class="card wide machinery">'
        + machinery_html
        + "    </div>\n  </div>\n\n  <div class=\"strip\">"
        + strip_and_footer
        + extra_html
        + DEMOS
        + "<script>"
        + script
        .replace("</script>", script_js + "</script>")
    )
    (HERE / name).write_text(html)


# ═════════════════════════════════════════════════════════════════════════════
# A — on the row. Tests are the rows' own trailing act; the verdict is a
# second line under the row's value; document jobs are one more Operations
# row that unfolds in place, and a failed job's detail unfolds under it.
# ═════════════════════════════════════════════════════════════════════════════
A_CSS = """
  /* ── #1055 A: on the row ─────────────────────────────────────────────── */
  .kv.tested{flex-wrap:wrap;row-gap:3px}
  .kv.tested>span:first-child,.kv.tested>button{white-space:nowrap;flex:none}
  .kv.tested>b{flex:1;text-align:right}
  .kv .verdict{flex-basis:100%;font:10.5px var(--mono);color:var(--ink-quiet);letter-spacing:0;text-align:right}
  .kv .verdict:empty{display:none}
  .kv .verdict.ok{color:var(--ok-text)}
  .kv .verdict.bad{color:var(--overdue-text)}
  @media (max-width:560px){
    .kv.tested>b{flex:0 1 auto;text-align:left}.kv .verdict{text-align:left}
    #jobs-row{flex-wrap:wrap}#jobs-row b{white-space:nowrap}#jobs-row small{flex-basis:100%;order:3;padding-left:16px}
    #jobs-row .place{margin-left:auto;min-height:44px}
  }

  /* the jobs row is a service row that can unfold; its act is the People
     card's quiet text-button */
  .svc .place{font:10.5px var(--mono);color:var(--ink-quiet);background:none;border:0;cursor:pointer;padding:4px;flex:none}
  .svc .place:hover{color:var(--accent-text)}
  .svc small .n{color:var(--overdue-text)}
  .svc small .r{color:var(--warm-text)}
  .jobs{padding:2px 0 4px 16px;border-bottom:1px solid var(--line-soft);margin-bottom:6px}
  .job{display:flex;align-items:center;gap:9px;width:100%;text-align:left;font:11.5px var(--mono);
       color:var(--ink-mid);padding:6px 2px;background:none;border:0;border-radius:6px}
  button.job{cursor:pointer}
  button.job:hover{color:var(--ink)}
  button.job[aria-expanded=true]{color:var(--ink)}
  .job i{width:7px;height:7px;border-radius:50%;flex:none}
  .job b{color:var(--ink);font-weight:500;min-width:7.5em}
  .job .st{flex:1 0 4.5em}
  .job .st.bad{color:var(--overdue-text)}
  .job .st.warn{color:var(--warm-text)}
  .job small{color:var(--ink-quiet);font-size:10.5px;text-align:right}
  .job .why{color:var(--ink-quiet);font-size:10.5px;text-align:right}
  .jobfoot{font:10.5px var(--mono);color:var(--ink-quiet);padding:6px 2px 2px}
  .jobdetail{padding:4px 2px 10px 18px;border-bottom:1px solid var(--line-soft);margin-bottom:6px}
  .jobdetail p{font:12px/1.6 var(--mono);color:var(--ink-mid);max-width:52ch}
  .jobdetail .meta{font:10.5px var(--mono);color:var(--ink-quiet);margin-top:4px}
  .jobdetail .acts{display:flex;gap:6px;flex-wrap:wrap;padding:8px 0 0}
  .jobdetail .acts button{font:10.5px var(--mono);color:var(--ink-mid);background:none;
        border:1px solid var(--line);border-radius:99px;padding:4px 11px;cursor:pointer}
  .jobdetail .acts button:hover{border-color:var(--accent);color:var(--accent-text)}
  .jobdetail .acts button.danger:hover{border-color:var(--overdue);color:var(--overdue-text)}
  .jobdetail .acts small{font:10.5px var(--mono);color:var(--ink-quiet);align-self:center}
  @media (max-width:560px){
    .job{flex-wrap:wrap}.job .why{flex-basis:100%;text-align:left;padding-left:16px}
    .jobdetail .acts button{min-height:44px;padding:8px 14px}
  }
"""

A_MACHINERY = """
      <div class="half">
        <div class="cardhead"><h3>Mail machinery</h3></div>
        <div class="kv"><span>collection domain</span><b>in.lawson-home.orbit</b></div>
        <!-- the ingest worker's own preflight: mailbox and relay together
             (POST /api/admin/operations/imap-test), read back off the
             snapshot so the verdict can say which half answered -->
        <div class="kv tested" id="row-imap"><span>ingest</span><b class="on">enabled · polling every 30s</b>
          <button id="imap-btn" onclick="runTest('imap')">test this mailbox</button>
          <span class="verdict" role="status" aria-live="polite" id="imap-verdict"></span></div>
        <div class="kv"><span>address generation</span><span><b>1</b> · current</span><button>rotate every address</button></div>
        <div class="kv"><span>unreviewed arrivals</span><b>burn up after 45 days</b></div>
        <!-- the outbound relay (POST /api/admin/operations/smtp-test):
             connect and sign in, no message sent -->
        <div class="kv tested" id="row-smtp"><span>outbound reminders</span><b class="on">configured</b>
          <button id="smtp-btn" onclick="runTest('smtp')">test the relay</button>
          <span class="verdict" role="status" aria-live="polite" id="smtp-verdict"></span></div>
      </div>

      <div class="half">
        <div class="cardhead"><h3>Operations</h3></div>
""" + ops_rows + """        <!-- one more service row: the document queue, which unfolds -->
        <div class="svc" id="jobs-row"><i id="jobs-dot" style="background:var(--overdue)"></i><b>document jobs</b>
          <small id="jobs-sum"><span class="n">2 failed</span> · <span class="r">1 retrying</span> · 1 running</small>
          <button class="place" id="jobs-toggle" aria-expanded="false" aria-controls="jobs" onclick="toggleJobs()">show…</button></div>
        <div class="jobs" id="jobs" hidden></div>
      </div>
"""

A_SCRIPT = """
/* ── #1055 A demo state ──────────────────────────────────────────────────── */
const JOBS = %s;
const WORDS = {
  smtp: { ok: "relay answered", bad: "relay refused sign-in", busy: "checking…", again: "test again" },
  imap: { ok: "mailbox and relay answered", bad: "mailbox didn’t answer", busy: "checking…", again: "test again" },
};
function runTest(which) {
  const btn = document.getElementById(which + "-btn"), out = document.getElementById(which + "-verdict");
  btn.disabled = true; btn.classList.add("busy"); btn.textContent = WORDS[which].busy; out.textContent = ""; out.className = "verdict";
  setTimeout(() => settle(which, which === "smtp" ? "bad" : "ok"), 1400);
}
function settle(which, tone) {
  const btn = document.getElementById(which + "-btn"), out = document.getElementById(which + "-verdict");
  btn.disabled = false; btn.classList.remove("busy"); btn.textContent = WORDS[which].again;
  out.className = "verdict " + tone + " fade"; out.textContent = WORDS[which][tone] + " · just now";
}
function resetTests() {
  for (const which of ["smtp", "imap"]) {
    const btn = document.getElementById(which + "-btn"), out = document.getElementById(which + "-verdict");
    btn.disabled = false; btn.classList.remove("busy"); btn.textContent = which === "smtp" ? "test the relay" : "test this mailbox";
    out.textContent = ""; out.className = "verdict";
  }
}
function jobRow(j, open) {
  const failed = j[2] === "failed";
  const tone = j[2] === "failed" ? "bad" : j[2] === "retrying" ? "warn" : "";
  const inner = `<i style="background:var(--${j[0]})" class="${j[2] === "running" ? "spin" : ""}"></i><b>${j[1]}</b>` +
    `<span class="st ${tone}">${j[2]}</span><small>${j[3]}</small>` + (j[4] ? `<span class="why">${j[4]}</span>` : "");
  return failed
    ? `<button class="job" aria-expanded="${open}" aria-controls="detail-${j[5]}" onclick="toggleDetail('${j[5]}')">${inner}</button>`
    : `<div class="job">${inner}</div>`;
}
let openJob = null;
function renderJobs() {
  const box = document.getElementById("jobs");
  const attention = JOBS.filter((j) => j[2] !== "done");
  box.innerHTML = attention.map((j) => jobRow(j, openJob === j[5]) + (openJob === j[5] ? detail(j) : "")).join("") +
    `<div class="jobfoot">41 done · newest 3m ago · nothing older than the 25 most recent is kept</div>`;
}
function detail(j) {
  return `<div class="jobdetail fade" id="detail-${j[5]}">` +
    `<p>${j[5] === "j1" ? %r : "Deleting the staged upload failed once, 2 hours ago. The rejected bytes are still on disk until this succeeds."}</p>` +
    `<div class="meta">${j[5] === "j1" ? %r : "attempt 1 of 1 · tried 2h ago · job 4c0d91ee"}</div>` +
    `<div class="acts"><button onclick="retry('${j[5]}')">retry</button><button class="danger">discard…</button>` +
    `<small>${%r}</small></div></div>`;
}
function toggleJobs(force) {
  const box = document.getElementById("jobs"), t = document.getElementById("jobs-toggle");
  const open = force ?? box.hidden;
  box.hidden = !open; t.setAttribute("aria-expanded", String(open)); t.textContent = open ? "hide" : "show…";
  if (open) renderJobs();
}
function toggleDetail(key) { openJob = openJob === key ? null : key; renderJobs(); }
function retry(key) {
  const j = JOBS.find((x) => x[5] === key);
  j[0] = "upcoming"; j[2] = "queued"; j[3] = "attempt 1 · just now"; j[4] = "";
  openJob = null;
  document.getElementById("jobs-sum").innerHTML = '<span class="n">1 failed</span> · <span class="r">1 retrying</span> · 2 running';
  renderJobs();
}
function resetJobs() {
  JOBS.splice(0, JOBS.length, ...JSON.parse(JOBS_INITIAL)); openJob = null;
  document.getElementById("jobs-sum").innerHTML = '<span class="n">2 failed</span> · <span class="r">1 retrying</span> · 1 running';
  toggleJobs(false);
}
const JOBS_INITIAL = JSON.stringify(JOBS);
function scene(name) {
  resetTests(); resetJobs();
  if (name === "checking") { for (const w of ["smtp"]) { const b = document.getElementById(w + "-btn"); b.disabled = true; b.classList.add("busy"); b.textContent = WORDS[w].busy; } }
  if (name === "smtp-failed") settle("smtp", "bad");
  if (name === "imap-ok") settle("imap", "ok");
  if (name === "jobs") toggleJobs(true);
  if (name === "job-detail") { toggleJobs(true); openJob = "j1"; renderJobs(); }
  if (name === "retried") { toggleJobs(true); retry("j1"); }
  document.querySelectorAll(".demos button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scene === name)));
}
document.querySelector(".demos").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { location.hash = b.dataset.scene; scene(b.dataset.scene); } });
window.addEventListener("hashchange", () => scene(location.hash.slice(1) || "idle"));
if (location.search.includes("shot")) document.documentElement.classList.add("shot");
scene(location.hash.slice(1) || "idle");
""" % (repr(JOBS).replace("(", "[").replace(")", "]"), JOB_DETAIL_WORDS, JOB_DETAIL_META, RETRY_WORDS)

write("a-on-the-row.html", SHARED_CSS + A_CSS, A_MACHINERY, "", "", A_SCRIPT)


# ═════════════════════════════════════════════════════════════════════════════
# B — the verdict line and the jobs card. Tests are two chips under the rows
# and speak through one verdict line at the foot of the half (where the
# shipped route already puts its mailbox outcomes); document jobs are a card
# of their own in the grid's empty cell beside Public contact, and a failed
# job's detail is a raised callout — a bottom sheet on the pocket.
# ═════════════════════════════════════════════════════════════════════════════
B_CSS = """
  /* ── #1055 B: the verdict line and the jobs card ─────────────────────── */
  .placerow{display:flex;gap:6px;flex-wrap:wrap;padding:10px 2px 4px}
  .placerow button{font:10.5px var(--mono);color:var(--ink-mid);background:none;
        border:1px solid var(--line);border-radius:99px;padding:4px 11px;cursor:pointer}
  .placerow button:hover{border-color:var(--accent);color:var(--accent-text)}
  .placerow button[disabled]{cursor:default;color:var(--ink-quiet);border-color:var(--line-soft)}
  .placerow button.busy{animation:breathe 1.6s ease-in-out infinite}
  .adminproblem{margin-top:10px;font:11px var(--mono);color:var(--warm-text);min-height:1.6em}
  .adminproblem.ok{color:var(--ok-text)}
  .adminproblem.bad{color:var(--overdue-text)}
  .adminproblem.quiet{color:var(--ink-quiet)}
  @media (max-width:560px){.placerow button{min-height:44px;padding:8px 14px}}

  /* the jobs card: service-row furniture, the failed rows pressable */
  .card .count{margin-left:auto;font:10.5px var(--mono);color:var(--ink-quiet)}
  /* the jobs card fills the empty cell beside public contact; neither card
     stretches to the other's height */
  #jobs-card,#jobs-card+.card,.card:has(+#jobs-card){align-self:start}
  .job{display:flex;align-items:center;gap:9px;width:100%;text-align:left;font:12px var(--mono);
       color:var(--ink-mid);padding:7px 2px;background:none;border:0;border-bottom:1px solid var(--line-soft);border-radius:0}
  .job:last-of-type{border-bottom:0}
  button.job{cursor:pointer}
  button.job:hover b{color:var(--accent-text)}
  button.job[aria-expanded=true] b{color:var(--accent-text)}
  .job i{width:7px;height:7px;border-radius:50%;flex:none}
  .job b{color:var(--ink);font-weight:500;min-width:7.5em}
  .job .st{flex:1 0 4.5em}
  .job .st.bad{color:var(--overdue-text)}
  .job .st.warn{color:var(--warm-text)}
  .job small{color:var(--ink-quiet);font-size:10.5px;text-align:right}
  .jobfoot{font:10.5px var(--mono);color:var(--ink-quiet);padding:10px 2px 0}
  @media (max-width:560px){
    #jobs-card .cardhead{flex-wrap:wrap}#jobs-card h3{white-space:nowrap}#jobs-card .count{margin-left:0;flex-basis:100%}
    .job{flex-wrap:wrap}.job small{flex-basis:100%;text-align:left;padding-left:16px}
  }

  /* the callout: the account card's own furniture, anchored to the page's
     right column on the desk; a bottom sheet on the pocket */
  .callout{position:fixed;z-index:7;width:320px;background:var(--panel-raised);backdrop-filter:blur(14px);
           border:1px solid var(--line);border-radius:16px;padding:18px 20px;
           box-shadow:0 18px 44px rgba(0,0,0,.35)}
  .callout[hidden]{display:none}
  .callout .head{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}
  .callout h4{font:10.5px var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--ink-quiet)}
  .callout .close{margin-left:auto;font:11px var(--mono);color:var(--ink-quiet);background:none;border:0;cursor:pointer;padding:4px}
  .callout .close:hover{color:var(--accent-text)}
  .callout .state{font:12px var(--mono);color:var(--overdue-text);margin-bottom:8px}
  .callout p{font:12px/1.6 var(--mono);color:var(--ink-mid)}
  .callout .meta{font:10.5px var(--mono);color:var(--ink-quiet);margin-top:8px}
  .callout .acts{display:flex;gap:6px;flex-wrap:wrap;padding:12px 0 0}
  .callout .acts button{font:10.5px var(--mono);color:var(--ink-mid);background:none;
        border:1px solid var(--line);border-radius:99px;padding:5px 12px;cursor:pointer}
  .callout .acts button:hover{border-color:var(--accent);color:var(--accent-text)}
  .callout .acts button.danger:hover{border-color:var(--overdue);color:var(--overdue-text)}
  .callout .acts small{flex-basis:100%;font:10.5px/1.5 var(--mono);color:var(--ink-quiet);padding-top:4px}
  .callout .grab{display:none}
  @media (max-width:880px){
    .callout{left:12px;right:12px;bottom:12px;top:auto!important;width:auto;border-radius:18px;
             animation:rise .25s ease-out}
    .callout .grab{display:block;width:36px;height:4px;border-radius:2px;background:var(--line);margin:-6px auto 12px}
    .callout .acts button{min-height:44px;padding:8px 16px}
    .callout .close{min-height:44px;min-width:44px}
  }
  @keyframes rise{from{transform:translateY(12px);opacity:0}}
  .scrim{position:fixed;inset:0;z-index:6;background:rgba(0,0,0,.25)}
  .scrim[hidden]{display:none}
  @media (min-width:881px){.scrim{background:none}}
"""

B_JOBS_CARD = """    <!-- #1055 B: the document queue in the grid's empty cell. The rows are
         the Operations half's own service rows; a failed one is a button
         that opens the callout. The card never names a document: the
         operations route returns kind, state, attempts and a bounded reason
         and nothing else (docs/administrator-operations.md, information
         boundary). -->
    <div class="card" id="jobs-card">
      <div class="cardhead"><h3>Document jobs</h3><span class="count" id="jobs-count">2 failed · 1 retrying · 1 running · 41 done</span></div>
      <div id="jobs"></div>
      <div class="jobfoot">the 25 most recently touched jobs; older ones are not kept</div>
    </div>

"""

B_MACHINERY = """
      <div class="half">
        <div class="cardhead"><h3>Mail machinery</h3></div>
        <div class="kv"><span>collection domain</span><b>in.lawson-home.orbit</b></div>
        <div class="kv"><span>ingest</span><b class="on">enabled · polling every 30s</b></div>
        <div class="kv"><span>address generation</span><span><b>1</b> · current</span><button>rotate every address</button></div>
        <div class="kv"><span>unreviewed arrivals</span><b>burn up after 45 days</b></div>
        <div class="kv"><span>outbound reminders</span><b class="on">configured</b></div>
        <!-- the two tests as the half's own acts (the shipped route already
             keeps its mailbox acts in a .placerow here), answering through
             the one verdict line the shipped route already has -->
        <div class="placerow">
          <button id="imap-btn" onclick="runTest('imap')">test this mailbox</button>
          <button id="smtp-btn" onclick="runTest('smtp')">test the relay</button>
        </div>
        <div class="adminproblem quiet" id="verdict" role="status" aria-live="polite"></div>
      </div>

      <div class="half">
        <div class="cardhead"><h3>Operations</h3></div>
""" + ops_rows + """      </div>
"""

B_CALLOUT = """
<div class="scrim" id="scrim" hidden onclick="closeDetail()"></div>
<div class="callout" id="callout" role="dialog" aria-labelledby="callout-title" hidden>
  <div class="grab" aria-hidden="true"></div>
  <div class="head"><h4 id="callout-title">virus scan · failed</h4><button class="close" onclick="closeDetail()" aria-label="Close">close</button></div>
  <p>%s</p>
  <div class="meta">%s</div>
  <div class="acts"><button onclick="retry('j1')">retry</button><button class="danger">discard…</button>
    <small>%s</small></div>
</div>
""" % (JOB_DETAIL_WORDS, JOB_DETAIL_META, RETRY_WORDS)

B_SCRIPT = """
/* ── #1055 B demo state ──────────────────────────────────────────────────── */
const JOBS = %s;
const JOBS_INITIAL = JSON.stringify(JOBS);
const WORDS = {
  smtp: { ok: "The relay answered and accepted sign-in · just now", bad: "The relay refused sign-in · just now", busy: "Testing the relay… no message is sent" },
  imap: { ok: "The mailbox and the relay both answered · just now", bad: "The mailbox didn’t answer · the relay did · just now", busy: "Testing the mailbox and the relay…" },
};
function runTest(which) {
  const btn = document.getElementById(which + "-btn"), out = document.getElementById("verdict");
  document.querySelectorAll(".placerow button").forEach((b) => { b.disabled = true; });
  btn.classList.add("busy"); out.className = "adminproblem quiet"; out.textContent = WORDS[which].busy;
  setTimeout(() => settle(which, which === "smtp" ? "bad" : "ok"), 1400);
}
function settle(which, tone) {
  const out = document.getElementById("verdict");
  document.querySelectorAll(".placerow button").forEach((b) => { b.disabled = false; b.classList.remove("busy"); });
  out.className = "adminproblem " + tone + " fade"; out.textContent = WORDS[which][tone];
}
function resetTests() {
  document.querySelectorAll(".placerow button").forEach((b) => { b.disabled = false; b.classList.remove("busy"); });
  const out = document.getElementById("verdict"); out.className = "adminproblem quiet"; out.textContent = "";
}
function jobRow(j, open) {
  const tone = j[2] === "failed" ? "bad" : j[2] === "retrying" ? "warn" : "";
  const inner = `<i style="background:var(--${j[0]})" class="${j[2] === "running" ? "spin" : ""}"></i><b>${j[1]}</b>` +
    `<span class="st ${tone}">${j[2]}${j[4] ? " · " + j[4] : ""}</span><small>${j[3]}</small>`;
  return j[2] === "failed"
    ? `<button class="job" aria-expanded="${open}" aria-controls="callout" onclick="openDetail('${j[5]}', this)">${inner}</button>`
    : `<div class="job">${inner}</div>`;
}
let openJob = null;
function renderJobs() {
  document.getElementById("jobs").innerHTML = JOBS.map((j) => jobRow(j, openJob === j[5])).join("");
}
function openDetail(key, btn) {
  openJob = key; renderJobs();
  const c = document.getElementById("callout"), card = document.getElementById("jobs-card").getBoundingClientRect();
  c.hidden = false; document.getElementById("scrim").hidden = false;
  if (window.innerWidth > 880) {
    // beside the card when the sky has room, else tucked onto its right edge
    const w = c.offsetWidth, left = Math.min(card.right + 18, window.innerWidth - w - 16);
    c.style.left = left + "px"; c.style.top = (card.top + 4) + "px";
  }
  else { c.style.left = ""; c.style.top = ""; }
  c.querySelector(".close").focus();
}
function closeDetail() { openJob = null; renderJobs(); document.getElementById("callout").hidden = true; document.getElementById("scrim").hidden = true; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openJob) closeDetail(); });
function retry(key) {
  const j = JOBS.find((x) => x[5] === key);
  j[0] = "upcoming"; j[2] = "queued"; j[3] = "attempt 1 · just now"; j[4] = "";
  document.getElementById("jobs-count").textContent = "1 failed · 1 retrying · 2 running · 41 done";
  closeDetail();
}
function resetJobs() {
  JOBS.splice(0, JOBS.length, ...JSON.parse(JOBS_INITIAL)); closeDetail();
  document.getElementById("jobs-count").textContent = "2 failed · 1 retrying · 1 running · 41 done";
}
function scene(name) {
  resetTests(); resetJobs();
  if (name === "checking") { const b = document.getElementById("smtp-btn"); document.querySelectorAll(".placerow button").forEach((x) => { x.disabled = true; }); b.classList.add("busy"); const out = document.getElementById("verdict"); out.textContent = WORDS.smtp.busy; }
  if (name === "smtp-failed") settle("smtp", "bad");
  if (name === "imap-ok") settle("imap", "ok");
  if (name === "job-detail") openDetail("j1");
  if (name === "retried") retry("j1");
  document.querySelectorAll(".demos button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scene === name)));
}
document.querySelector(".demos").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { location.hash = b.dataset.scene; scene(b.dataset.scene); } });
window.addEventListener("hashchange", () => scene(location.hash.slice(1) || "idle"));
window.addEventListener("resize", () => { if (openJob) openDetail(openJob); });
if (location.search.includes("shot")) document.documentElement.classList.add("shot");
scene(location.hash.slice(1) || "idle");
""" % repr(JOBS).replace("(", "[").replace(")", "]")

write("b-the-jobs-card.html", SHARED_CSS + B_CSS, B_MACHINERY, B_JOBS_CARD, B_CALLOUT, B_SCRIPT)
print("built a-on-the-row.html, b-the-jobs-card.html")
