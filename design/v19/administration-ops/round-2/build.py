#!/usr/bin/env python3
"""Builds the #1055 round-2 sheet from the ratified administration mockup.

Round 1 was killed for speaking in the machinery panel's small mono sublines
(verdicts that appeared and went away). Round 2 speaks in the screen's own
grammar — the People and Systems cards: a readable row, a subtext line, a
state pill, a button at the card head, a button on the row — and nothing
appears-then-vanishes. The ratified sheet is carried byte-for-byte as in
round 1 (packs.css inlined, the #1052 form drawn resting); the layer this
round adds is marked. Run from anywhere: `python3 build.py`.
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

body = re.sub(r"      <!-- Drawn OPEN for the record \(#1052\).*?(?=      <div class=\"system\">)", "", body, count=1, flags=re.S)
body = body.replace('title="star-chart" aria-pressed="true"', 'title="star-chart" aria-pressed="false"')
body = body.replace('title="after dark" aria-pressed="false"', 'title="after dark" aria-pressed="true"')
head = head.replace('data-theme="starchart"', 'data-theme="afterdark"')

# the page head gains its tell: pills in the row grammar, under the subline
SUB = '    <div class="sub">the instance from above · admins see everything by design · 5 people · 5 systems</div>\n'
assert SUB in body
body = body.replace(SUB, SUB + '    <div class="tells" id="tells" aria-label="needs attention"></div>\n')

CSS = """
  /* ── #1055 round 2: the screen's own grammar, nothing transient ──────── */
  /* pocket holds (the ratified sheet lets .kv and .person rows overflow
     390px; the shipped route wraps the person row, #915) */
  .person{flex-wrap:wrap}
  .person .who{flex:1 1 60%}
  .person .place:first-of-type{margin-left:auto}
  @media (max-width:560px){.kv{flex-wrap:wrap}.kv > button{margin-left:auto;min-height:44px}}

  /* the tell: state pills under the page subline, each a link to its card.
     Empty when nothing needs attention. */
  .tells{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
  .tells:empty{display:none}
  .tells .role{text-decoration:none}
  .tells .role:hover{border-color:var(--accent);color:var(--accent-text)}

  /* the pill's state family, coloured like ADMIN is */
  .role.bad{color:var(--overdue-text);border-color:var(--overdue)}
  .role.warn{color:var(--warm-text);border-color:var(--warm)}
  .role.run{color:var(--upcoming-text);border-color:var(--upcoming)}
  .role.ok{color:var(--ok-text);border-color:var(--ok)}
  .role.quiet{color:var(--ink-quiet);animation:breathe 1.6s ease-in-out infinite}
  @keyframes breathe{50%{opacity:.45}}

  /* the jobs card: People-card rows without avatars; the failed row's
     reason lives in the subtext, permanently */
  .card .count{margin-left:auto;font:10.5px var(--mono);color:var(--ink-quiet)}
  #jobs-card,#jobs-card+.card,.card:has(+#jobs-card){align-self:start}
  .jobfoot{font:10.5px var(--mono);color:var(--ink-faint);padding:12px 2px 0}
  #jobs-card{min-width:0}
  /* the reason is the point of the subtext: it wraps rather than being cut */
  #jobs-card .who span,#machinery .who span{white-space:normal}
  /* the row button sits under the pill, as "place in a system…" does */
  #jobs-card .place{flex-basis:100%;text-align:right}

  /* the machinery half: the two tested rows in the row grammar, the head
     carries the tests as People carries "invite someone" */
  .card .cardhead button+button{margin-left:6px}
  .card .cardhead button[disabled]{cursor:default;color:var(--ink-quiet);border-color:var(--line-soft)}
  .card .cardhead button.busy{animation:breathe 1.6s ease-in-out infinite}
  @media (max-width:560px){
    .machinery .cardhead{flex-wrap:wrap;row-gap:8px}
    .machinery .cardhead h3{flex-basis:100%}
    .machinery .cardhead button{margin-left:0;min-height:44px}
    #jobs-card .place,#machinery .place{min-height:44px;display:inline-flex;align-items:center}
    #jobs-card .place{flex-basis:auto;margin-left:auto}
    .person>.role{margin-left:auto}
    #jobs-card .cardhead{flex-wrap:wrap}#jobs-card .count{margin-left:0;flex-basis:100%}
  }

  /* sheet furniture: the scene bar (not part of the design) */
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
  <button data-scene="imap-ok" aria-pressed="false">mailbox passed</button>
  <button data-scene="retried" aria-pressed="false">after retry</button>
  <button data-scene="named" aria-pressed="false">with document names</button>
</nav>
"""

# ── the jobs card, sibling to People and Systems ─────────────────────────────
# The snapshot (GET /api/admin/operations) gives kind, status, attempts,
# lastErrorCode and timestamps for the 25 most recently touched jobs. Rows are
# ordered by what needs the reader: failed, retrying, running, done; newest
# first within each. The story: the virus scanner was away 09:40–10:05, it is
# 10:12 now. The "named" scene is the fork for the owner: the information
# boundary (docs/administrator-operations.md) keeps document names out of
# admin responses, so the resting sheet names the kind and the job only.
JOBS_CARD = """    <!-- #1055 round 2: document jobs, in the People card's grammar -->
    <div class="card" id="jobs-card">
      <div class="cardhead"><h3>Document jobs</h3><span class="count" id="jobs-count">2 failed · 1 retrying · 1 running · 41 done</span></div>
      <div id="jobs"></div>
      <div class="jobfoot">the 25 most recently touched jobs are kept; older ones are not</div>
    </div>
"""

MACHINERY = """
      <div class="half" id="machinery">
        <!-- the tests at the head, as People carries "invite someone".
             "test this mailbox" is the shipped "check connection" and the
             ingest preflight folded into one press (POST
             /api/admin/operations/imap-test verifies mailbox and relay);
             "test the relay" is POST …/smtp-test — connect and sign in,
             no message sent. -->
        <div class="cardhead"><h3>Mail machinery</h3>
          <button id="imap-btn" onclick="runTest('imap')">test this mailbox</button>
          <button id="smtp-btn" onclick="runTest('smtp')">test the relay</button></div>
        <!-- the five ratified rows, same content, in the row grammar: a
             reading-size name, a subtext line, and on the two tested rows a
             pill that stays until the next test -->
        <div class="person"><div class="who"><b>Collection domain</b><span>in.lawson-home.orbit</span></div></div>
        <div class="person" id="row-imap"><div class="who"><b>Incoming mailbox</b><span id="imap-sub">enabled · polling every 30s</span></div><span class="role" id="imap-pill" hidden></span></div>
        <div class="person"><div class="who"><b>Address generation</b><span>1 · current</span></div><button class="place">rotate every address</button></div>
        <div class="person"><div class="who"><b>Unreviewed arrivals</b><span>burn up after 45 days</span></div></div>
        <div class="person" id="row-smtp"><div class="who"><b>Outbound relay</b><span id="smtp-sub">configured · reminders go out through it</span></div><span class="role" id="smtp-pill" hidden></span></div>
      </div>

      <div class="half">
        <div class="cardhead"><h3>Operations</h3></div>
        <div class="svc"><i style="background:var(--ok)"></i><b>orbit-app</b><small>healthy · 40s ago</small></div>
        <div class="svc"><i style="background:var(--ok)"></i><b>orbit-postgres</b><small>healthy · 40s ago</small></div>
        <div class="svc"><i style="background:var(--ok)"></i><b>orbit-clamav</b><small>healthy · scanning required</small></div>
        <div class="svc"><i style="background:var(--ok)"></i><b>orbit-tika</b><small>running</small></div>
        <div class="svc"><i style="background:var(--ok)"></i><b>scheduler</b><small>running · 12s ago</small></div>
      </div>
"""

SCRIPT = """
// ── #1055 round 2 ──────────────────────────────────────────────────────────
// key, kind (plain), document (the "named" fork only), state, subtext
const JOBS = [
  ["j1", "Virus scan", "MOT certificate 2025", "failed", "couldn’t reach the virus scanner · 5 of 5 tries · last tried 6m ago"],
  ["j2", "Delete bytes", "insurance renewal", "failed", "couldn’t delete the bytes · 1 try · 2h ago"],
  ["j3", "Re-key", "boiler service", "retrying", "attempt 2 of 5 · next try in 40s"],
  ["j4", "Virus scan", "boiler service", "running", "attempt 1 · started 20s ago"],
  ["j5", "Virus scan", "insurance renewal", "done", "finished 3m ago"],
  ["j6", "Encrypt", "insurance renewal", "done", "finished 3m ago"],
];
const PILL = { failed: ["bad", "failed"], retrying: ["warn", "retrying"], running: ["run", "running"], done: ["", "done"], queued: ["run", "queued"] };
let named = false;
const state = {};
function resetJobs() { for (const j of JOBS) state[j[0]] = { st: j[3], sub: j[4] }; renderJobs(); }
function renderJobs() {
  const box = document.getElementById("jobs");
  box.innerHTML = JOBS.map((j) => {
    const s = state[j[0]], [tone, word] = PILL[s.st];
    const title = named ? `${j[1]} · ${j[2]}` : j[1];
    const act = s.st === "failed" ? `<button class="place" onclick="retry('${j[0]}')">retry</button>` : "";
    return `<div class="person" id="job-${j[0]}"><div class="who"><b>${title}</b><span>${s.sub}</span></div><span class="role ${tone}">${word}</span>${act}</div>`;
  }).join("");
  const n = (st) => Object.values(state).filter((s) => s.st === st).length;
  const parts = [[n("failed"), "failed"], [n("retrying"), "retrying"], [n("running") + n("queued"), "running"]].filter((p) => p[0]).map((p) => `${p[0]} ${p[1]}`);
  document.getElementById("jobs-count").textContent = parts.concat(["41 done"]).join(" · ");
  renderTells();
}
// POST /api/admin/operations/document-jobs/{id} {action:"retry", expectedStatus:"failed"}
// → pending, attempts 0, picked up at once. The row says so and keeps saying so.
function retry(key) { state[key] = { st: "queued", sub: "attempt 1 · queued just now" }; renderJobs(); }

const WORDS = {
  smtp: { busy: "checking…", ok: "passed", bad: "failed",
          okSub: "configured · reminders go out through it", badSub: "the relay refused the sign-in details" },
  imap: { busy: "checking…", ok: "passed", bad: "failed",
          okSub: "polling every 30s · the relay answered too", badSub: "the mailbox didn’t answer · the relay did" },
};
const tests = { smtp: null, imap: null };
function runTest(which) {
  const btn = document.getElementById(which + "-btn"), pill = document.getElementById(which + "-pill");
  document.querySelectorAll("#machinery .cardhead button").forEach((b) => { b.disabled = true; });
  btn.classList.add("busy");
  pill.hidden = false; pill.className = "role quiet"; pill.textContent = WORDS[which].busy;
  setTimeout(() => settle(which, which === "smtp" ? "bad" : "ok"), 1400);
}
function settle(which, tone) {
  document.querySelectorAll("#machinery .cardhead button").forEach((b) => { b.disabled = false; b.classList.remove("busy"); });
  const pill = document.getElementById(which + "-pill"), sub = document.getElementById(which + "-sub");
  pill.hidden = false; pill.className = "role " + tone; pill.textContent = WORDS[which][tone] + " · just now";
  sub.textContent = tone === "ok" ? WORDS[which].okSub : WORDS[which].badSub;
  tests[which] = tone; renderTells();
}
function resetTests() {
  for (const w of ["smtp", "imap"]) {
    const pill = document.getElementById(w + "-pill"), sub = document.getElementById(w + "-sub");
    pill.hidden = true; pill.className = "role"; pill.textContent = "";
    sub.textContent = w === "smtp" ? "configured · reminders go out through it" : "enabled · polling every 30s";
    const b = document.getElementById(w + "-btn"); b.disabled = false; b.classList.remove("busy");
    tests[w] = null;
  }
  renderTells();
}
// the tell under the page subline: one pill per thing that needs the reader
function renderTells() {
  const failed = Object.values(state).filter((s) => s.st === "failed").length;
  const t = [];
  if (failed) t.push(`<a class="role bad" href="#jobs-card">${failed} job${failed === 1 ? "" : "s"} failed</a>`);
  if (tests.smtp === "bad") t.push('<a class="role bad" href="#machinery">relay failed</a>');
  if (tests.imap === "bad") t.push('<a class="role bad" href="#machinery">mailbox failed</a>');
  document.getElementById("tells").innerHTML = t.join("");
}
function scene(name) {
  named = name === "named"; resetTests(); resetJobs();
  if (name === "checking") { const b = document.getElementById("smtp-btn"); document.querySelectorAll("#machinery .cardhead button").forEach((x) => { x.disabled = true; }); b.classList.add("busy"); const p = document.getElementById("smtp-pill"); p.hidden = false; p.className = "role quiet"; p.textContent = WORDS.smtp.busy; }
  if (name === "smtp-failed") settle("smtp", "bad");
  if (name === "imap-ok") settle("imap", "ok");
  if (name === "retried") retry("j1");
  document.querySelectorAll(".demos button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scene === name)));
}
document.querySelector(".demos").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { location.hash = b.dataset.scene; scene(b.dataset.scene); } });
window.addEventListener("hashchange", () => scene(location.hash.slice(1) || "idle"));
if (location.search.includes("shot")) document.documentElement.classList.add("shot");
scene(location.hash.slice(1) || "idle");
"""

MARK = "    <!-- §15: mail machinery sits WITH operations — one panel, two halves. -->\n"
assert MARK in body
html = (
    head + "  " + PACKS.strip() + "\n" + ratified_css + CSS + "</style>"
    + body.replace(MARK, JOBS_CARD + MARK)
    + '    <div class="card wide machinery">' + MACHINERY
    + "    </div>\n  </div>\n\n  <div class=\"strip\">" + strip_and_footer
    + DEMOS + "<script>" + script.replace("</script>", SCRIPT + "</script>")
)
(HERE / "f-the-screens-grammar.html").write_text(html)
print("built f-the-screens-grammar.html")
