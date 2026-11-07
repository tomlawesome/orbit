#!/usr/bin/env python3
"""Builds the #1629 round-1 sheets (J one card, K two cards).

Shell: the ratified administration mock-up spliced with web/src/lib/packs.css,
as administration-ops round 2 did, so the desk card reads like the built
screen. The phone is drawn the way the built phone is: the pocket kit
(tokens.css, kit.css), Row and Sheet styles and pocket.svelte's own style
block are read from web/src at build time (selectors un-scoped, nothing
re-drawn). Run from anywhere: `python3 build.py`.
"""
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MOCKUP = (ROOT / "design/v19/administration.html").read_text()
PACKS = (ROOT / "web/src/lib/packs.css").read_text()
POCKET_DIR = ROOT / "web/src/lib/pocket"
TOKENS = (POCKET_DIR / "tokens.css").read_text()
KIT = (POCKET_DIR / "kit.css").read_text()
ROW_SVELTE = (POCKET_DIR / "Row.svelte").read_text()
SHEET_SVELTE = (POCKET_DIR / "Sheet.svelte").read_text()
ARM_SVELTE = (POCKET_DIR / "ArmButton.svelte").read_text()
AD_SVELTE = (ROOT / "web/src/routes/administration/pocket.svelte").read_text()


# ── the ratified sheet, in pieces (as administration-ops round 2) ────────────
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
head = head.replace("<title>Orbit — administration: mission control (proposal, issue #452)</title>",
                    "<title>Orbit — administration: mail setup (issue #1629, round 1)</title>")


# ── reading the built phone's CSS out of the svelte files ────────────────────
def unwrap_global(css):
    out, i = "", 0
    while i < len(css):
        j = css.find(":global(", i)
        if j < 0:
            out += css[i:]
            break
        out += css[i:j]
        k, depth = j + len(":global("), 1
        while depth:
            depth += {"(": 1, ")": -1}.get(css[k], 0)
            k += 1
        out += css[j + len(":global("):k - 1]
        i = k
    return out


def chunks(css):
    """Top-level rules, each with the comment that leads it."""
    res, depth, start, i = [], 0, 0, 0
    while i < len(css):
        if css.startswith("/*", i):
            i = css.index("*/", i) + 2
            continue
        c = css[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                res.append(css[start:i + 1])
                start = i + 1
        i += 1
    return res


def selector_of(chunk):
    return re.sub(r"/\*.*?\*/", "", chunk, flags=re.S).split("{", 1)[0].strip()


def style_of(svelte):
    return re.search(r"<style>(.*?)</style>", svelte, re.S).group(1)


def scoped(svelte, scope, special=()):
    out = []
    for ch in chunks(style_of(svelte)):
        sel = selector_of(ch)
        if sel.startswith("@"):
            out.append(unwrap_global(ch))
            continue
        lead = ch[:ch.index(sel)] if sel in ch else ""
        bodytxt = ch[ch.index("{"):] if "{" in ch else ""
        # strip the leading comment's own braces-free text from the selector search
        bodytxt = ch[len(lead) + len(sel):]
        new = []
        for one in re.split(r",\s*(?![^()]*\))", sel):
            one = one.strip()
            if one.startswith(":global") or one.startswith(".p-") or one.startswith("html"):
                new.append(unwrap_global(one))
            elif one.startswith(".open "):
                new.append(scope + ".open " + one[6:])
            elif one.startswith("[data-size"):
                new.append(scope + one)
            else:
                new.append(scope + " " + one)
        out.append(lead + ", ".join(new) + bodytxt)
    return "\n".join(out)


DROP = re.compile(r"^(\.kv\b|\.mailboxform|\.mailboxnote|\.mailboxrow|\.retry|\.ad-sent|\.ad-pocket|@media \(max-width:839)")


def pocket_css():
    keep = []
    for ch in chunks(style_of(AD_SVELTE)):
        sel = selector_of(ch)
        if DROP.match(sel):
            continue
        keep.append(unwrap_global(ch))
    return "\n".join(keep)


PHONE_CSS = "\n".join([
    "/* ── the pocket kit, read from web/src/lib/pocket ── */",
    TOKENS, KIT,
    "/* Row.svelte */", scoped(ROW_SVELTE, ".p-row"),
    "/* Sheet.svelte */", scoped(SHEET_SVELTE, ".p-sheet-layer"),
    "/* ArmButton.svelte */", unwrap_global(style_of(ARM_SVELTE)),
    "/* administration/pocket.svelte */", pocket_css(),
])

# ── what this round adds to the desk ─────────────────────────────────────────
CSS = r"""
  /* ── #1629 round 1: pieces the built card already carries (copied from
     web/src/routes/administration/administration.css, un-scoped) ───────── */
  .placerow{display:flex;gap:6px;flex-wrap:wrap;padding:4px 2px 10px 44px;border-bottom:1px solid var(--line-soft)}
  .placerow button{font:10.5px var(--mono);color:var(--ink-mid);background:none;
        border:1px solid var(--line);border-radius:99px;padding:4px 11px;cursor:pointer}
  .placerow button:hover{border-color:var(--accent);color:var(--accent-text)}
  .adminproblem{margin-top:10px;font:11px/1.5 var(--mono);color:var(--warm-text)}
  .adminproblem + .placerow{margin-top:6px}
  .adminproblem.ok{color:var(--ok-text)}
  .dangerbtn{font:600 11px var(--mono);letter-spacing:.15em;text-transform:uppercase;
    color:var(--overdue-text);background:none;border:1.5px solid var(--overdue);border-radius:9px;
    padding:7px 12px;font-size:10.5px;cursor:pointer;white-space:nowrap}
  .dangerbtn:hover{background:color-mix(in srgb,var(--overdue) 15%,transparent)}
  .mailboxrow{padding:10px 2px 4px}
  .mailboxform{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;padding:12px 2px 2px}
  .mailboxform label{display:flex;flex-direction:column;gap:4px;font:10.5px var(--mono);letter-spacing:.06em;color:var(--ink-quiet)}
  .mailboxform :is(input,select){font:12px var(--mono);color:var(--ink);background:none;
    border:1px solid var(--line-soft);border-radius:6px;padding:5px 7px}
  .mailboxform :is(input,select):focus-visible{outline:none;border-color:var(--accent)}
  .mailboxform select option{background:var(--bg);color:var(--ink)}
  .mailboxform .mailboxnote,.mailboxform .mailboxrow,.mailboxform .whole{grid-column:1 / -1}
  .mailboxform .mailboxnote{font:10.5px var(--mono);line-height:1.5;color:var(--ink-quiet);margin-top:2px}
  .mailboxform .mailboxrow{padding:6px 2px 4px}

  /* the Mail card's own states, in the card's existing grammar */
  .card .cardhead button+button{margin-left:6px}
  .role.bad{color:var(--overdue-text);border-color:var(--overdue)}
  .role.ok{color:var(--ok-text);border-color:var(--ok)}
  .machinery .who span,.mailcard .who span{white-space:normal}
  .person{flex-wrap:wrap}
  .person .who{flex:1 1 60%}
  .mailcard{align-self:start}
  /* Public contact keeps its row; the two mail cards open the next one, side by side */
  #mailbox-card{grid-column:1}
  .half>.cardhead{flex-wrap:wrap;row-gap:8px}
  /* the label rows: the row title's face (.person .who b), on a hairline */
  .sublabel{font-size:13.5px;font-weight:530;color:var(--ink);padding:4px 2px 8px}
  .sublabel.next{margin-top:26px}
  /* values that run long wrap in place, right-aligned, beside the label */
  .mailcard .kv > :nth-child(2),.half .kv > :nth-child(2){min-width:0;text-align:right}
  .mailcard .kv > span:nth-child(2):not(:last-child),.half .kv > span:nth-child(2):not(:last-child){margin-left:auto}
  /* the choice row: the placerow's pills, the chosen one in the hover colours */
  .mailboxform .choice{grid-column:1 / -1;display:flex;flex-direction:column;gap:6px;font:10.5px var(--mono);letter-spacing:.06em;color:var(--ink-quiet)}
  .choice .opts{display:flex;gap:6px;flex-wrap:wrap}
  .choice button{font:10.5px var(--mono);letter-spacing:0;color:var(--ink-mid);background:none;
        border:1px solid var(--line);border-radius:99px;padding:4px 11px;cursor:pointer}
  .choice button:hover,.choice button[aria-pressed=true]{border-color:var(--accent);color:var(--accent-text)}
  /* the calm notice: .adminproblem's place and size, ink instead of amber */
  .adminproblem.calm{color:var(--ink-mid)}
  .adminproblem .how{font:inherit;color:var(--accent-text);background:none;border:0;border-bottom:1px solid currentColor;
        padding:0;cursor:pointer}
  .adminproblem .how:hover{color:var(--ink)}
  @media (max-width:560px){.kv{flex-wrap:wrap}.kv > button{margin-left:auto;min-height:44px}}
  @media (max-width:880px){.card.machinery{grid-template-columns:1fr}}

  /* sheet furniture: the scene bar (not part of the design) */
  .demos{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:60;
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

  /* ── the dialect switch: the same query as $lib/pocket/media.js ─────── */
  .ad-pocket{display:none}
  @media (max-width:839.98px), (max-height:479.98px){
    .ad-pocket{display:block;position:relative;min-height:100dvh}
    .page,.back,.orb,body>footer{display:none}
  }
  html.phone .ad-pocket{display:block;position:relative;min-height:100dvh}
  html.phone :is(.page,.back,.orb,body>footer){display:none}
  .ad-pocket .p-sheet-layer{visibility:visible}
  .ad-pocket .ad-inset.p-caps{margin-top:var(--p-group-above)}
  .ad-pocket .ad-note a{padding:0}
  .ad-pocket .quietline{margin:0 var(--p-gutter) 8px}
  .ad-pocket .p-body{box-shadow:0 0 0 2.5px var(--bg)}
"""

DEMOS = """
<nav class="demos" aria-label="Design demo: pick a scene">
  <span>SCENE</span>
  <button data-scene="set-up" aria-pressed="true">set up</button>
  <button data-scene="another-account" aria-pressed="false">another account</button>
  <button data-scene="fresh" aria-pressed="false">fresh</button>
  <button data-scene="mailbox-only" aria-pressed="false">mailbox only</button>
  <button data-scene="editor" aria-pressed="false">editor</button>
  <button data-scene="editor-another" aria-pressed="false">editor, another account</button>
  <button data-scene="imported" aria-pressed="false">imported</button>
</nav>
"""

POCKET_SHELL = """
<div class="ad-pocket" aria-label="Administration (phone)">
  <main class="ad-column">
    <header class="ad-head">
      <svg class="ad-glyph" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
        <circle class="ad-orbit" cx="28" cy="28" r="22" fill="none"/>
        <circle class="ad-orbit soft" cx="28" cy="28" r="14" fill="none"/>
        <circle cx="28" cy="28" r="3" style="fill:var(--sun)"/>
        <g class="ad-craft">
          <rect x="44" y="26.6" width="12" height="2.8" rx=".6"/>
          <rect x="48.6" y="21.5" width="2.8" height="13" rx=".6" class="ad-array"/>
        </g>
      </svg>
      <div class="ad-named">
        <h1 class="p-title">Administration</h1>
        <p class="ad-sub">5 people · 5 systems</p>
      </div>
    </header>
    <div id="pocket-slot"></div>
    <p class="ad-strip">ORBIT v1.3.0 · CHANNEL preview · REVISION fd6a7e6</p>
  </main>
  <div id="sheet-slot"></div>
</div>
"""

# ── the scenes and renderers (shared by both directions) ─────────────────────
SCRIPT = r"""
// ── #1629 round 1 ───────────────────────────────────────────────────────────
// DIRECTION is "one" (J) or "two" (K). Everything below draws from one state:
// { mb: mailbox configured, send: null | "mailbox" | "other", editor: null |
//   "mailbox" | "other", imported }. Nothing is a fetch; the sheet is static.
const DIRECTION = "__DIRECTION__";
const SCENES = {
  "set-up":         { mb: 1, send: "mailbox" },
  "another-account":{ mb: 1, send: "other" },
  "fresh":          { mb: 0, send: null },
  "mailbox-only":   { mb: 1, send: null },
  "editor":         { mb: 1, send: "mailbox", editor: "mailbox" },
  "editor-another": { mb: 1, send: "mailbox", editor: "other" },
  "imported":       { mb: 1, send: "mailbox", imported: 1 },
};
let base = "set-up", st = { ...SCENES[base] };
const SENDER = "Orbit &lt;orbit@harlow.example&gt;";
const CANT = "Orbit can’t send invitations, reminders or address checks until sending is set up.";
const IMPORTED = "copied from .env-orbit on 7 Nov 2026 · the SMTP lines there can go now";

// ── desk ────────────────────────────────────────────────────────────────────
const kv = (l, v) => `<div class="kv"><span>${l}</span>${v}</div>`;
const two = (a, b) => `<span><b>${a}</b> · ${b}</span>`;
const test = (title, meta, pill) => `<div class="person"><div class="who"><b>${title}</b><span>${meta}</span></div>${pill ? `<span class="role ok">${pill}</span>` : ""}</div>`;

function deskMailbox(st) {
  const on = st.mb;
  let r = "";
  r += kv("collection domain", `<b>${on ? "harlow.example" : "not set"}</b>`);
  r += kv("ingest", on ? `<b class="on">enabled · polling every 300s</b>` : `<b>not set up</b>`);
  r += kv("mailbox", `<b>${on ? "orbit@harlow.example · INBOX" : "no mailbox set"}</b>`);
  r += kv("credential", `<b>${on ? "stored, encrypted" : "not set"}</b>`);
  r += kv("last check", `<b>${on ? "2 minutes ago" : "not configured"}</b>`);
  r += test("mailbox test", on ? "available" : "not tested yet", on ? "passed" : "");
  r += kv("verification", `<b>${on ? "verified · 7 Nov 2026" : "unverified · never"}</b>`);
  if (on) {
    r += kv("credential set", `<b>3 Nov 2026 · Ned</b>`);
    r += kv("address shape", `<b>orbit+&lt;code&gt;@harlow.example</b>`);
    r += kv("envelope header", `<b>X-Original-To</b>`);
    r += kv("provider profile", `<b>mailcow</b>`);
    r += kv("tls name", `<b>mail.harlow.example</b>`);
  }
  r += kv("largest message", `${two("25 MB", "the default")}<button>change…</button>`);
  return r;
}
function deskMailboxButtons(st, withChange) {
  const change = withChange ? `<button>${st.mb ? "change mailbox…" : "set up mailbox…"}</button>` : "";
  if (!st.mb) return withChange ? `<div class="placerow mailboxrow">${change}</div>` : "";
  return `<div class="placerow mailboxrow">${change}
      <button>fetch now</button><button>run setup probe</button><button>pause ingest</button>
      <button>rotate password…</button><button>rotate every address…</button>
      <button class="dangerbtn">remove credential</button></div>`;
}
function deskSending(st) {
  let r = "";
  if (st.send) {
    r += kv("sends as", `<b>${SENDER}</b>`);
    r += kv("via", st.send === "mailbox"
      ? two("the mailbox account", "mail.harlow.example, port 587, STARTTLS")
      : two("another account", "smtp.sendgrid.example, port 465, TLS"));
    r += kv("password", st.send === "mailbox" ? `<b>the mailbox’s</b>` : `<b>set by Ned · 7 Nov 2026</b>`);
    r += kv("last sent", two("a reminder", "41 minutes ago"));
    r += test("outgoing mail test", "ready", "passed");
    if (st.imported) r += `<div class="adminproblem calm" role="status">${IMPORTED} · <button class="how" type="button">how</button></div>`;
  } else {
    r += test("outgoing mail test", "not tested yet", "");
    r += `<div class="adminproblem" role="alert">${CANT}</div>`;
  }
  return r;
}
function deskEditor(st) {
  const other = st.editor === "other";
  const opt = (v, t) => `<button type="button" aria-pressed="${st.editor === v}" onclick="choose('${v}')">${t}</button>`;
  return `<form class="mailboxform" onsubmit="return false">
    <div class="choice" role="group" aria-label="send through"><span>send through</span>
      <div class="opts">${opt("mailbox", "the mailbox account")}${opt("other", "another account")}</div></div>
    ${other ? `
    <label>host <input value="smtp.sendgrid.example"></label>
    <label>port <input type="number" value="465"></label>
    <label>security <select><option>STARTTLS</option><option selected>TLS</option></select></label>
    <label>user <input value="apikey"></label>
    <label class="whole">password <input type="password" autocomplete="new-password"></label>` : ""}
    <label>sender name <input value="Orbit"></label>
    <label>sender address <input value="orbit@harlow.example"></label>
    ${other ? "" : `<p class="mailboxnote">via mail.harlow.example, port 587, STARTTLS, signed in as orbit@harlow.example</p>`}
    <div class="placerow mailboxrow"><button type="submit">verify and save</button><button type="button" onclick="cancelEdit()">cancel</button></div>
    <p class="mailboxnote">Orbit signs in to the server before saving. The password is never shown again.</p>
  </form>`;
}
const sendingTail = (st) => st.editor ? deskEditor(st)
  : `<div class="placerow mailboxrow"><button onclick="openEditor()">${st.send ? "change sending…" : "set up sending…"}</button></div>`;

function deskOps() {
  return `<div class="cardhead"><h3>Operations</h3></div>
    <div class="svc"><i style="background:var(--ok)"></i><b>orbit-app</b><small>healthy · 40s ago</small></div>
    <div class="svc"><i style="background:var(--ok)"></i><b>orbit-postgres</b><small>healthy · 40s ago</small></div>
    <div class="svc"><i style="background:var(--ok)"></i><b>orbit-clamav</b><small>healthy · scanning required</small></div>
    <div class="svc"><i style="background:var(--ok)"></i><b>orbit-tika</b><small>running</small></div>
    <div class="svc"><i style="background:var(--ok)"></i><b>scheduler</b><small>running · 12s ago</small></div>`;
}
function deskOne(st) {
  return `<div class="card wide machinery" id="mail-card">
    <div class="half" id="mail">
      <div class="cardhead"><h3>Mail</h3>
        <button>test this mailbox</button><button>test outgoing mail</button></div>
      <div class="sublabel">Mailbox</div>
      ${deskMailbox(st)}${deskMailboxButtons(st, true)}
      <div class="sublabel next">Sending</div>
      ${deskSending(st)}${sendingTail(st)}
    </div>
    <div class="half">${deskOps()}</div>
  </div>`;
}
function deskTwo(st) {
  return `<div class="card mailcard" id="mailbox-card">
      <div class="cardhead"><h3>Mailbox</h3>
        <button>test this mailbox</button><button>${st.mb ? "change mailbox…" : "set up mailbox…"}</button></div>
      ${deskMailbox(st)}${deskMailboxButtons(st, false)}
    </div>
    <div class="card mailcard" id="sending-card">
      <div class="cardhead"><h3>Sending</h3>
        <button>test outgoing mail</button>${st.editor ? "" : `<button onclick="openEditor()">${st.send ? "change sending…" : "set up sending…"}</button>`}</div>
      ${deskSending(st)}${st.editor ? deskEditor(st) : ""}
    </div>
    <div class="card mailcard" id="ops-card">${deskOps()}</div>`;
}

// ── phone: the built phone's rows, pills and sheet ──────────────────────────
const body = (tone) => `<span class="p-body ${tone}"></span>`;
function row({ title, meta, trail = "", tone = "ended", trailTone, end = "", wrap = false, mark }) {
  return `<div class="p-row"><div class="face"><div class="hit">
    <span class="mark" aria-hidden="true">${mark ?? body(tone)}</span>
    <span class="text"><span class="title">${title}</span>${meta ? `<span class="meta ui${wrap ? " email" : ""}">${meta}</span>` : ""}</span>
    ${trail ? `<span class="trail" ${trailTone ? `style="color:${trailTone}"` : ""}>${trail}</span>` : ""}
    </div>${end ? `<span class="end">${end}</span>` : ""}</div></div>`;
}
const state = (w) => `<span class="ad-state ok">${w}</span>`;
const cap = (t) => `<p class="p-caps ad-inset">${t}</p>`;
const pill = (t, cls = "act-accent", extra = "") => `<button class="p-pill ${cls}" ${extra}>${t}</button>`;

function pocketMailbox(st) {
  const on = st.mb;
  let r = "";
  r += row({ title: "collection domain", meta: on ? "harlow.example" : "not set" });
  r += row({ title: "ingest", meta: on ? "every 300s" : "not set up", trail: on ? "on" : "", trailTone: "var(--ok-text)", tone: on ? "ok" : "ended" });
  r += row({ title: "mailbox", meta: on ? "orbit@harlow.example · INBOX" : "no mailbox set" });
  r += row({ title: "credential", meta: on ? "stored, encrypted" : "not set" });
  r += row({ title: "last check", meta: on ? "2 minutes ago" : "not configured" });
  r += row({ title: "mailbox test", meta: on ? "available" : "not tested yet", tone: on ? "ok" : "ended", end: on ? state("passed") : "" });
  if (on) r += row({ title: "every address", meta: "", trail: "rotate", trailTone: "var(--warm-text)", mark: `<span class="ad-kmark">↻</span>` });
  r += row({ title: "verification", meta: on ? "verified · 7 Nov 2026" : "unverified · never", trail: on ? "passed" : "", trailTone: "var(--ok-text)", tone: on ? "ok" : "ended" });
  if (on) {
    r += row({ title: "credential set", meta: "3 Nov 2026 · Ned" });
    r += row({ title: "address shape", meta: "orbit+&lt;code&gt;@harlow.example" });
    r += row({ title: "envelope header", meta: "X-Original-To" });
    r += row({ title: "provider profile", meta: "mailcow" });
    r += row({ title: "tls name", meta: "mail.harlow.example" });
  }
  r += row({ title: "largest message", meta: "25 MB · the default", trail: "change", trailTone: "var(--accent-text)", mark: `<span class="ad-kmark">↑</span>` });
  return r;
}
function pocketMailboxFoot(st, withChange) {
  const change = withChange ? pill(st.mb ? "change mailbox" : "set up mailbox") : "";
  if (!st.mb) return withChange ? `<div class="ad-foot"><div class="p-pills">${change}</div></div>` : "";
  return `<div class="ad-foot"><div class="p-pills">${change}${pill("fetch now")}${pill("run setup probe")}
      ${pill("pause ingest", "act-warm")}${pill("rotate password", "")}</div>
    <button class="p-pill arm danger wide"><span class="rest">remove credential</span><span class="set">tap again to remove the credential</span></button></div>`;
}
function pocketSending(st) {
  let r = "";
  if (st.send) {
    r += row({ title: "sends as", meta: SENDER });
    r += row({ title: "via", wrap: true, meta: st.send === "mailbox"
      ? "the mailbox account · mail.harlow.example, port 587, STARTTLS"
      : "another account · smtp.sendgrid.example, port 465, TLS" });
    r += row({ title: "password", meta: st.send === "mailbox" ? "the mailbox’s" : "set by Ned · 7 Nov 2026" });
    r += row({ title: "last sent", meta: "a reminder · 41 minutes ago" });
    r += row({ title: "outgoing mail test", meta: "ready", tone: "ok", end: state("passed") });
    if (st.imported) r += `<p class="ad-said ad-inset"><span>${IMPORTED}</span><button class="p-quiet" type="button">how</button></p>`;
  } else {
    r += row({ title: "outgoing mail test", meta: "not tested yet" });
    r += `<p class="ad-said warn ad-inset">${CANT}</p>`;
  }
  return r;
}
const pocketSendFoot = (st) => st.editor ? "" :
  `<div class="ad-foot">${pill(st.send ? "change sending" : "set up sending", "act-accent wide", 'onclick="openEditor()"')}</div>`;

function pocketOps() {
  const svc = [["orbit-app", "40s ago", "healthy"], ["orbit-postgres", "40s ago", "healthy"], ["orbit-clamav", "scanning required", "healthy"], ["orbit-tika", "", "running"], ["scheduler", "12s ago", "running"]];
  return `<section class="p-card ad-card ad-flush" id="ad-operations"><div class="ad-cardhead"><h2 class="p-caps">Operations</h2></div>
    ${svc.map(([n, m, w]) => row({ title: n, meta: m, trail: w, trailTone: "var(--ok-text)", tone: "ok" })).join("")}</section>`;
}
function pocketCard(id, title, pills, inner) {
  return `<section class="p-card ad-card ad-flush" id="${id}"><div class="ad-cardhead"><h2 class="p-caps">${title}</h2>
    <div class="p-pills ad-headpills">${pills}</div></div>${inner}</section>`;
}
function pocketOne(st) {
  return pocketCard("ad-mail", "Mail", pill("test this mailbox") + pill("test outgoing mail"),
    cap("Mailbox") + pocketMailbox(st) + pocketMailboxFoot(st, true) +
    cap("Sending") + pocketSending(st) + pocketSendFoot(st)) + pocketOps();
}
function pocketTwo(st) {
  return pocketCard("ad-mailbox", "Mailbox", pill("test this mailbox"), pocketMailbox(st) + pocketMailboxFoot(st, true)) +
    pocketCard("ad-sending", "Sending", pill("test outgoing mail"), pocketSending(st) + pocketSendFoot(st)) + pocketOps();
}
function pocketSheet(st) {
  const other = st.editor === "other";
  const tab = (v, t) => `<button type="button" role="tab" aria-selected="${st.editor === v}" onclick="choose('${v}')">${t}</button>`;
  const f = (id, label, input) => `<label class="ad-label" for="${id}">${label}</label>${input}`;
  const inp = (id, v, extra = "") => `<input id="${id}" class="p-input" autocomplete="off" autocapitalize="off" value="${v}" ${extra}>`;
  return `<div class="p-sheet-layer open" data-size="${other ? "full" : "callout"}"><div class="scrim" aria-hidden="true"></div>
    <div class="p-sheet-panel" role="dialog" aria-modal="true" aria-label="Change sending"><div class="grab" aria-hidden="true"><span></span></div>
    <div class="head"><h2 class="title">${st.send ? "Change sending" : "Set up sending"}</h2><button class="p-pill close" onclick="cancelEdit()">close</button></div>
    <div class="body"><form class="ad-form" onsubmit="return false">
      <label class="ad-label">send through</label>
      <div class="p-tabs" role="tablist">${tab("mailbox", "the mailbox account")}${tab("other", "another account")}</div>
      ${other ? f("s-host", "host", inp("s-host", "smtp.sendgrid.example")) + f("s-port", "port", inp("s-port", "465", 'type="number" inputmode="numeric"'))
        + f("s-sec", "security", `<select id="s-sec" class="p-input"><option>STARTTLS</option><option selected>TLS</option></select>`)
        + f("s-user", "user", inp("s-user", "apikey")) + f("s-pass", "password", `<input id="s-pass" class="p-input" type="password" autocomplete="new-password">`) : ""}
      ${f("s-name", "sender name", inp("s-name", "Orbit"))}
      ${f("s-addr", "sender address", inp("s-addr", "orbit@harlow.example"))}
      ${other ? "" : `<p class="ad-note">via mail.harlow.example, port 587, STARTTLS, signed in as orbit@harlow.example</p>`}
      <p class="ad-note">Orbit signs in to the server before saving. The password is never shown again.</p>
    </form></div>
    <div class="p-sheet-foot"><button class="p-pill filled" type="button">verify and save</button></div></div></div>`;
}

// ── wiring ──────────────────────────────────────────────────────────────────
function draw() {
  document.getElementById("mail-slot").innerHTML = DIRECTION === "one" ? deskOne(st) : deskTwo(st);
  document.getElementById("pocket-slot").innerHTML = DIRECTION === "one" ? pocketOne(st) : pocketTwo(st);
  document.getElementById("sheet-slot").innerHTML = st.editor ? pocketSheet(st) : "";
  document.querySelectorAll(".demos button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scene === sceneName())));
}
function sceneName() { return st.editor ? (st.editor === "other" ? "editor-another" : "editor") : (st.imported ? "imported" : base); }
function scene(name) { if (!SCENES[name]) name = "set-up"; base = st.editor ? base : name; st = { ...SCENES[name] }; if (!st.editor) base = name; draw(); }
function openEditor() { st = { ...st, editor: st.send === "other" ? "other" : "mailbox" }; if (!st.mb) st.editor = "other"; draw(); }
function choose(v) { st = { ...st, editor: v }; draw(); }
function cancelEdit() { st = { ...SCENES[SCENES[base] && !SCENES[base].editor ? base : "set-up"] }; draw(); }
document.querySelector(".demos").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { location.hash = b.dataset.scene; scene(b.dataset.scene); } });
window.addEventListener("hashchange", () => scene(location.hash.slice(1) || "set-up"));
const q = location.search;
if (q.includes("shot")) document.documentElement.classList.add("shot");
if (q.includes("phone")) document.documentElement.classList.add("phone");
scene(location.hash.slice(1) || "set-up");
"""


def build(direction, name, title):
    mark_slot = '    <div id="mail-slot" style="display:contents"></div>\n'
    html = (
        head + "  " + PACKS.strip() + "\n" + ratified_css
        + CSS + "\n  /* ── the built phone's own CSS ── */\n" + PHONE_CSS + "</style>"
        + body + mark_slot
        + "  </div>\n\n  <div class=\"strip\">" + strip_and_footer
        + POCKET_SHELL + DEMOS
        + "<script>" + script.replace("</script>", SCRIPT.replace("__DIRECTION__", direction) + "</script>")
    )
    (HERE / name).write_text(html)
    print("built", name)


build("one", "j-one-card.html", "J")
build("two", "k-two-cards.html", "K")
