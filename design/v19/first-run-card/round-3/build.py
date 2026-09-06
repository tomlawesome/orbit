#!/usr/bin/env python3
"""Builds round 3 of #862 — the owner's own design, drawn.

Round 2's verdict: "these are even worse to be honest", followed by a
specification rather than a preference (owner, 2026-09-06):

    Make the Orbit logo circle on the login screen much bigger, same line
    weight, same size of rotating orb. the inside of the ring is a glassed
    background over the night's sky, with the fields inside it.

    The name box has the suggestion 'Your world' and it's clear what each box
    is for. The create button is the same style as the login button, the same
    size, everything. Except it says create. On clicking create, the circle
    animates inward, get increasingly smaller as it transitions into the
    normal login 'launch'.

So this round is one direction, not a choice: the thing described, built.

GEOMETRY — the ratified login ring, measured rather than guessed. Its glyph is
an SVG 420px wide on a 200 viewBox, so it draws at 2.1x: a circle of r=72
becomes 302.4px across, its 2-unit stroke becomes 4.2px, and the orb's r=7
becomes 29.4px across, riding 151.2px out from the centre at -30.1 degrees.

The big ring keeps every one of those numbers except the diameter, which goes
to 500px — 1.65x the login's. The fields stack in one column, which narrows
the block enough for the circle to come down this far and still clear it. To hold the line weight and the orb
size still while the diameter changes, the ring is drawn in CSS rather than
scaled as an SVG: a border in pixels does not thin when its element shrinks,
and the orb is its own element, placed by percentage so it keeps its station
on the ring while keeping its size.

That is also what makes the hand-over possible. On create the ring animates
inward to 302.4px — exactly the login ring's size, in its place — and the
glass and fields go with it, so the ratified reclaim finds the login screen
already assembled underneath and the launch runs unchanged.
"""

import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
SHEET = HERE.parents[1] / "first-run.html"

CLOUDS_TOKENS = """
  [data-theme=clouds]{
    --bg:#d2d3d4;
    --panel:rgba(233,239,249,.58); --panel-raised:rgba(241,245,252,.80);
    --line:#a6b2c5; --line-soft:#c0c8d6;
    --ink:#18202f; --ink-mid:#343d51; --ink-faint:#414d62;
    --accent:#1f7ac2; --ok:#178a4c; --warm:#c06a12; --overdue:#c22a63; --upcoming:#1f7ac2;
    --star-far:var(--ink); --star-near:var(--ink);
  }
"""

CLOUDS_SWATCH = (
    '  <button class="sw" data-swatch="clouds" style="background:#d2d3d4" title="clouds"'
    ' aria-pressed="false" onclick="setTheme(\'clouds\')"></button>\n'
)

RING = """
  /* ── THE RING HOLDS THE QUESTIONS (#862, round 3 — owner's design) ───────
     Numbers, all of them the login ring's own: it draws at 2.1x, so its
     stroke is 4.2px, its orb is 29.4px across, and the circle itself is
     302.4px. The big ring changes the diameter to 660px and nothing else.

     Drawn in CSS, not as a scaled SVG, precisely so that the line weight and
     the orb hold still while the diameter moves -- a border measured in
     pixels does not thin when its element shrinks, and the orb is its own
     element, stationed by percentage so it keeps its place on the ring at
     any size. Scaling the SVG would have thinned both, which the owner ruled
     out in the same breath as asking for the bigger ring.

     Every rule here is scoped to .bigring and the parts are named for it.
     An unscoped `.disc` is not free: the newcomer frame already owns that
     class for its discovered-count, and claiming it put this ring around
     the count and shoved it off centre. */
  /* THE SWAP. The two rings are the same circle at the end of the shrink, so
     the changeover is invisible only if it happens THEN: the big ring holds
     full strength while it closes and clears in .16s once it has arrived,
     and the ratified login chrome is held back to meet it there rather than
     appearing at full size beside a ring still travelling. Both land before
     the ascent starts at 620ms. */
  .bigring{position:fixed;inset:0;display:grid;place-items:center;z-index:3;
           opacity:0;visibility:hidden;pointer-events:none;
           transition:opacity .16s ease .46s,visibility .16s .46s}
  /* The create path and nothing else. `showform` stays set while the sheet
     runs its other journeys -- the newcomer arrival, the discovered count,
     the home instrument -- so a rule keyed on it alone left this ring
     hanging over screens it has no business being on. Each of those states
     has its own body class; the ring is gone the moment any of them is up. */
  body.showform:not(.reclaimed):not(.shownew):not(.showhome):not(.showwarp):not(.showdusk):not(.counting):not(.instrument) .bigring{
           opacity:1;visibility:visible;
           transition:opacity .8s ease,visibility .8s}
  .bigring>*{grid-area:1/1}

  /* The glass: the night sky itself, held still and quieted, inside the ring
     and nowhere else. It is a darkening rather than a paint, so a light pack
     cannot wash it out and no per-pack exception list is needed -- the defect
     that opened this issue cannot recur here. */
  .bigring .ringglass{width:500px;height:500px;border-radius:50%;
        border:4.2px solid #8791b3;
        background:rgba(6,10,22,.56);
        -webkit-backdrop-filter:blur(20px) saturate(1.1) brightness(.74);
        backdrop-filter:blur(20px) saturate(1.1) brightness(.74);
        box-shadow:0 40px 120px -50px rgba(0,0,0,.8),
                   0 0 90px -40px rgba(216,180,90,.18) inset;
        transition:width .5s cubic-bezier(.55,0,.2,1),
                   height .5s cubic-bezier(.55,0,.2,1),
                   background .5s ease,backdrop-filter .5s ease}
  /* THE HAND-OVER. On create the circle animates inward to exactly the login
     ring's 302.4px, in its place, and the glass clears as it goes -- so what
     the ratified reclaim brings back is not a new screen but the one already
     standing there. The ascent then runs unchanged. */
  body.reclaimed .bigring .ringglass{width:302.4px;height:302.4px;
        background:rgba(7,11,24,0);
        -webkit-backdrop-filter:blur(0px);backdrop-filter:blur(0px)}

  /* The orb keeps its 29.4px and its station: 43.26% out and 25.06% up is
     the login orb's own angle, and a percentage holds it there as the ring
     closes. One turn per 40s, the only motion CON-19 allows the mark. */
  .bigring .ringorbit{width:500px;height:500px;position:relative;
         animation:spinback 40s linear infinite;
         transition:width .5s cubic-bezier(.55,0,.2,1),
                    height .5s cubic-bezier(.55,0,.2,1)}
  body.reclaimed .bigring .ringorbit{width:302.4px;height:302.4px}
  .bigring .ringorbit i{position:absolute;left:93.26%;top:24.94%;
           width:29.4px;height:29.4px;margin:-14.7px 0 0 -14.7px;
           border-radius:50%;background:#d8b45a}

  /* ── THE FIELDS, INSIDE THE RING ─────────────────────────────────────────
     No card of its own any more: the ring is the card, so the panel, the
     blur, the border and the shadow all go and the glass behind them is the
     ring's. The fields keep their labels -- the owner asked that it be clear
     what each box is for -- and the name's suggestion is "Your world".

     Ink is the sky's and fixed, not the pack's, for the reason the whole
     issue exists: the ground here is a night sky whatever pack is chosen. */
  #formlayer{display:grid;place-items:center;z-index:4}
  /* One column: time zone, then currency beneath it (owner, 2026-09-06).
     Stacking narrows the block, which is what lets the circle come down --
     a 300px column inside a 500px ring still clears its widest point. */
  .card .row2{display:block}
  .card .row2>.field{margin-bottom:18px}
  .card .row2>.field:last-child{margin-bottom:0}
  .card{width:300px;max-width:300px;background:none;backdrop-filter:none;
        border:none;box-shadow:none;padding:0;
        --ink:#f0f4fb; --ink-mid:#c0cade; --ink-faint:#9aa6bf;
        --line:rgba(240,244,251,.26); --line-soft:rgba(240,244,251,.14);
        --panel:rgba(6,10,22,.34);
        color:var(--ink)}
  body.showform:not(.reclaimed) .card{background:none}
  .card .field label{color:#9aa6bf;text-shadow:0 1px 8px rgba(2,5,14,.8)}
  .card .field input,.card .field select{
        background:rgba(5,9,20,.42);border-color:rgba(240,244,251,.22);
        color:#f0f4fb}
  /* Typed text sits centred (owner, 2026-09-06): everything in the ring is
     centred on its axis, so a name growing out from the left edge was the
     one thing in here still reading as a form. The labels centre with them,
     because a left-set label over a centred value reads as a mistake. */
  .card .field input,.card .field select,.card .field label{text-align:center}
  .card .field select{text-align-last:center;padding-right:12px}
  .card .selwrap::after{display:none}
  .card .field input::placeholder{color:rgba(240,244,251,.36)}
  .card .field input:focus,.card .field select:focus{border-color:#d8b45a}
  .card .selwrap::after{border-color:#9aa6bf}
  .card .note{color:#8f9bb5;text-align:center}

  /* THE ACT: the ratified gate rule, verbatim and at its own size, because
     the owner asked for the login button in everything but the word (§15
     already requires the two surfaces to carry the identical control). */
  #gobtn{display:block;margin:20px auto 0;width:auto;
         font:600 12px var(--display);color:#04060e;background:#d8b45a;
         border:0;border-radius:99px;padding:11px 30px;cursor:pointer;
         letter-spacing:.04em;line-height:normal;
         box-shadow:0 0 28px rgba(216,180,90,.22);
         transition:filter .35s ease,box-shadow .3s ease,opacity .4s ease}
  #gobtn:hover:not(:disabled){filter:brightness(1.08)}
  #gobtn:disabled{opacity:.34;cursor:default;box-shadow:none}

  body.reclaimed #dawn .loginchrome{transition:opacity .22s ease .45s,
                                    visibility .22s .45s}

  /* The sheet's running commentary describes the passes that produced the
     card this round replaces. It stays in the file and out of the view. */
  .sheet{display:none}
"""

FORM = """
    <div class="field">
      <label for="hhname">name</label>
      <input id="hhname" placeholder="Your world" maxlength="60" autocomplete="off"
             aria-label="System name" oninput="naming()"
             title="A house, a flat, a boat, a parent’s place — whatever you keep in orbit. It is the name everyone in it sees.">
      <p class="err" role="alert"><b id="errname">“Lawson Home”</b> already exists here —
        <a href="#" onclick="newcomerArrival();return false">ask to join it →</a></p>
    </div>

    <div class="pair">
      <div class="row2">
        <div class="field selwrap">
          <label for="tz">time zone</label>
          <select id="tz" aria-label="Time zone"
                  title="Read off your browser. It moves to settings afterwards, and dates read by it.">
            <option>Europe/London</option><option>Europe/Dublin</option>
            <option>Europe/Paris</option><option>America/New York</option>
            <option>Australia/Sydney</option><option>UTC</option>
          </select>
        </div>
        <div class="field selwrap">
          <label for="cur">currency</label>
          <select id="cur" aria-label="Currency"
                  title="Read off your browser. It moves to settings afterwards, and costs read by it.">
            <option>GBP</option><option>EUR</option><option>USD</option>
            <option>CAD</option><option>AUD</option><option>NZD</option>
          </select>
        </div>
      </div>
    </div>

    <p class="note">four sections to start &middot; change them later</p>

    <button class="btn" id="gobtn" type="submit" disabled>Create</button>
"""

RING_MARKUP = """
<!-- #862 round 3: the login ring, enlarged, holding the questions. It is a
     sibling of the dawn and of the form layer rather than a child of either,
     because it has to outlive the card on the way into the launch. -->
<div class="bigring" aria-hidden="true">
  <div class="ringglass"></div>
  <div class="ringorbit"><i></i></div>
</div>
"""

FORM_BODY = re.compile(
    r'(<form class="card" id="setup" onsubmit="attempt\(\);return false"\n'
    r'\s*aria-label="Name your first system">\n).*?(\n  </form>)',
    re.S,
)

EXCEPTION = re.compile(
    r"\n  /\* the two light packs paint an ink-on-paper card.*?"
    r"\[data-theme=atlas\] \.card,\[data-theme=dawn\] \.card\{\n"
    r"\s*background:color-mix\(in srgb,var\(--panel\) 92%,transparent\)\}",
    re.S,
)

# The sheet's naming() grows the act to "create <name> →". The login pill is
# one short word and never grows, and the owner asked for that button in
# everything but the word.
HOLD = """
  const _go = document.getElementById("gobtn");
  const _fix = () => { if (_go.textContent !== "Create") _go.textContent = "Create"; };
  new MutationObserver(_fix).observe(_go, { childList: true, characterData: true, subtree: true });
  _fix();
"""


def build() -> None:
    sheet = SHEET.read_text(encoding="utf-8")

    if "[data-theme=clouds]" not in sheet:
        sheet = sheet.replace(
            "  [data-theme=retrograde]{", CLOUDS_TOKENS.strip("\n") + "\n  [data-theme=retrograde]{", 1
        )
    sheet = sheet.replace(
        '  <button class="sw" data-swatch="retrograde"',
        CLOUDS_SWATCH + '  <button class="sw" data-swatch="retrograde"',
        1,
    )
    sheet, removed = EXCEPTION.subn("", sheet)
    if removed != 1:
        raise SystemExit(f"expected one pack exception, removed {removed}")

    out, n = FORM_BODY.subn(lambda m: m.group(1) + FORM + m.group(2), sheet, count=1)
    if n != 1:
        raise SystemExit("could not find the card's form body")

    # At the end of the stylesheet: the sheet sets #hhname's and .card's own
    # rules later on, and an equal-specificity rule placed earlier loses.
    out = out.replace("</style>", RING + "\n</style>", 1)
    out = out.replace('<div id="formlayer">', RING_MARKUP + '<div id="formlayer">', 1)
    out = out.replace(
        '  <!-- §15: it is not "form over login"',
        '  <span style="color:#d8b45a">#862 ROUND 3 · THE RING HOLDS THE QUESTIONS</span>\n'
        '  <!-- §15: it is not "form over login"',
        1,
    )
    out = out.replace("<title>", "<title>#862 round 3 · the ring holds the questions — ", 1)
    out = out.replace("</body>", f"<script>{HOLD}</script>\n</body>", 1)
    (HERE / "ring.html").write_text(out, encoding="utf-8")
    print("wrote ring.html")


if __name__ == "__main__":
    build()
