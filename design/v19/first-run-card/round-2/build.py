#!/usr/bin/env python3
"""Builds round 2 of #862 from the ratified first-run sheet.

Round 1 was rejected whole: "generic boxes with clumsy wording that doesn't
tie into the login screen in any way" (owner, 2026-09-06). It changed the
card's ground and left its form and its words alone, which was the wrong
variable.

Round 2 changes the form and the words, and takes both from the login screen,
which is the only other thing that has ever stood in this place.

What the login screen IS, as a composition (§10, ratified 2026-08-14, and the
ruling quoted in the sheet at "the create screen is not 'form over login'"):

  · centred in the viewport, nothing off to a side;
  · ONE line of display type at 72px — the word `orbit`;
  · ONE small pill 74px below it, 12px display, dark ink on gold, 99px
    radius, and no other control anywhere;
  · no labels, no boxes, no footer, no explanation.

And the standing ruling this round must not break: while the card shows, the
ring and the word are GONE, not receded — "no orbit word, no orbit logo, this
little window pops up, the user fills it in, the orbit logo and text reappear"
(owner, verbatim). So the tie cannot be made by borrowing the mark. It is made
by borrowing the composition: the name the reader types stands exactly where
`orbit` stood, at its size, and the act below it is the same pill in the same
place. The window pops up in the word's own slot, which is what makes it read
as the login screen rather than a form laid over it.

Each direction is `design/v19/first-run.html` copied verbatim with the card's
markup and its treatment replaced, and nothing else touched — the sky, the
dawn, the reclaim, the flight and both hand-over beats carry forward.
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

# ── The composition every direction inherits ────────────────────────────────
COMMON = """
  /* The sheet's running commentary describes the passes that produced the
     card this round replaces, so on these pages it would read as the round's
     own argument. It stays in the file and out of the view. */
  .sheet{display:none}

  /* ── THE LOGIN SCREEN'S OWN COMPOSITION (#862, round 2) ──────────────────
     Round 1 changed the card's ground and kept its form: a left-aligned
     panel of labelled boxes, off in its own idiom. The owner's verdict was
     that it tied to the login screen in no way at all, and it did not.

     This is the tie. The login screen is one centred line of 72px display
     type with one small gold pill 74px beneath it, and nothing else on the
     screen — no labels, no boxes, no footer. So the name the reader types
     stands in exactly that slot, at that size, centred; and the act beneath
     it is that pill, at its size, in its colour, at its offset. The window
     pops up where the word was.

     The mark itself is not borrowed and must not be: while the card shows,
     the ring and the word are gone, by ruling (owner, verbatim: "no orbit
     word, no orbit logo, this little window pops up"). The tie is the
     composition, not the logo.

     There is no panel here at all, so the pack cannot wash it out and no
     per-pack exception list exists to forget clouds in. Ink is the sky's,
     fixed; the pill keeps the ratified gold on every pack, because it is the
     same pill as the login's and that one never varied either. */
  .card{max-width:none;width:auto;background:none;backdrop-filter:none;
        border:none;box-shadow:none;padding:0;
        display:grid;justify-items:center;gap:0;text-align:center}
  #formlayer{display:grid;place-items:center;padding:24px}

  /* The name, in the word's place and at the word's weight. It steps down as
     it grows -- 60 characters will not sit at 72px -- which is the display
     word behaving like a field rather than a field borrowing a font. */
  .nameline{grid-area:auto;display:grid;justify-items:center}
  #hhname{font:600 72px var(--display);letter-spacing:.015em;line-height:1.06;
          color:#e9edf8;background:none;border:none;border-radius:0;
          padding:2px 0;text-align:center;width:min(78vw,900px);
          text-shadow:0 2px 30px rgba(2,5,14,.85),0 0 70px rgba(2,5,14,.6);
          transition:font-size .25s ease}
  #hhname::placeholder{color:rgba(233,237,248,.34)}
  #hhname:focus{outline:none}
  #hhname.long{font-size:52px}
  #hhname.longer{font-size:38px}

  /* The pill: the ratified gate rule, verbatim, because §15 requires the two
     surfaces to carry the identical control. Only the word differs. */
  #gobtn{font:600 12px var(--display);color:#04060e;background:#d8b45a;
         border:0;border-radius:99px;padding:11px 30px;cursor:pointer;
         letter-spacing:.04em;line-height:normal;width:auto;
         box-shadow:0 0 28px rgba(216,180,90,.22);
         transition:filter .35s ease,box-shadow .3s ease,opacity .4s ease}
  #gobtn:hover:not(:disabled){filter:brightness(1.08)}
  #gobtn:disabled{opacity:.34;cursor:default;box-shadow:none}

  /* Everything the old card said in labels is one quiet line in the sheet's
     own caption register. It states what was assumed rather than asking. */
  .assume{font:11px var(--mono);letter-spacing:.06em;color:#9aa5bd;
          text-shadow:0 1px 10px rgba(2,5,14,.9)}
  .assume .pick{color:#c9d2e6;border-bottom:1px solid rgba(201,210,230,.36);
                cursor:pointer;position:relative}
  .assume .pick:hover{color:#e9edf8;border-bottom-color:#d8b45a}
  .assume select{position:absolute;inset:0;opacity:0;width:100%;height:100%;
                 cursor:pointer;font:inherit}
  .card .err{text-align:center}
  .card .field,.card .pair,.card .note{margin:0}
  /* The sheet's script writes the section count into `.card .note` on load
     and dies at a null if it is not there, so the element stays in the
     document. Its words are re-stated in the quiet line instead. */
  .card .note{display:none}
"""

# ── The three positions ─────────────────────────────────────────────────────
DIRECTIONS = {
    "g-the-word": {
        "act": "Create",
        "title": "G · the word",
        "css": """
  /* G — the login screen's spacing, exactly: the pill sits 74px below the
     centre of the line above it, as .gate-wrap does, and the quiet line sits
     under the pill where nothing sits on the login screen at all. */
  .card{gap:0}
  .nameline{margin-bottom:26px}
  .assume{margin-top:22px}
""",
        "form": """
    <div class="nameline">
      <input id="hhname" placeholder="name it" maxlength="60" autocomplete="off"
             aria-label="System name" oninput="naming()">
      <p class="err" role="alert"><b id="errname">“Lawson Home”</b> already exists here —
        <a href="#" onclick="newcomerArrival();return false">ask to join it →</a></p>
    </div>

    <button class="btn" id="gobtn" type="submit" disabled>Create</button>
    <p class="note" hidden>four sections to start &middot; change them later</p>

    <p class="assume">
      <span class="pick">Europe/London<select id="tz" aria-label="Time zone"><option>Europe/London</option><option>Europe/Dublin</option><option>Europe/Paris</option><option>America/New York</option><option>Australia/Sydney</option><option>UTC</option></select></span>
      &middot;
      <span class="pick">GBP<select id="cur" aria-label="Currency"><option>GBP</option><option>EUR</option><option>USD</option><option>CAD</option><option>AUD</option><option>NZD</option></select></span>
      &middot; four sections to start
    </p>
""",
    },
    "h-the-ledger": {
        "act": "Create",
        "title": "H · the ledger",
        "css": """
  /* H — the same composition, with what was assumed stated BEFORE the act
     rather than after it, as a pair of engraved readings either side of a
     rule. Nothing is a box; the values are the only bright thing in the line,
     so the eye reads name, then readings, then act. */
  .nameline{margin-bottom:20px}
  .readings{display:flex;align-items:center;gap:0;margin-bottom:24px;
            font:10.5px var(--mono);letter-spacing:.14em;text-transform:uppercase;
            color:#7d879e;text-shadow:0 1px 10px rgba(2,5,14,.9)}
  .readings .r{padding:0 20px;display:grid;justify-items:center;gap:5px}
  .readings .r+.r{border-left:1px solid rgba(240,244,251,.16)}
  .readings .r b{font:12.5px var(--mono);letter-spacing:.04em;
                 text-transform:none;color:#dfe6f4;font-weight:500}
  .readings .pick{border-bottom:1px solid rgba(223,230,244,.3);position:relative;cursor:pointer}
  .readings .pick:hover{border-bottom-color:#d8b45a}
  .readings select{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer}
  .assume{margin-top:20px}
""",
        "form": """
    <div class="nameline">
      <input id="hhname" placeholder="name it" maxlength="60" autocomplete="off"
             aria-label="System name" oninput="naming()">
      <p class="err" role="alert"><b id="errname">“Lawson Home”</b> already exists here —
        <a href="#" onclick="newcomerArrival();return false">ask to join it →</a></p>
    </div>

    <div class="readings">
      <span class="r">time<b class="pick">Europe/London<select id="tz" aria-label="Time zone"><option>Europe/London</option><option>Europe/Dublin</option><option>Europe/Paris</option><option>America/New York</option><option>Australia/Sydney</option><option>UTC</option></select></b></span>
      <span class="r">money<b class="pick">GBP<select id="cur" aria-label="Currency"><option>GBP</option><option>EUR</option><option>USD</option><option>CAD</option><option>AUD</option><option>NZD</option></select></b></span>
      <span class="r">sections<b>four</b></span>
    </div>

    <button class="btn" id="gobtn" type="submit" disabled>Create</button>
    <p class="note" hidden>four sections to start &middot; change them later</p>
""",
    },
    "i-one-question": {
        "act": "Create",
        "title": "I · one question",
        "css": """
  /* I — the login screen asks exactly one thing, so this asks exactly one
     thing. Time and money are read off the browser and simply stated in a
     sentence under the act, in the same quiet register, with no control here
     at all: both are right nearly always, both move to settings afterwards,
     and the sheet already says so in the fields' own titles. The fewest
     possible elements on the screen, which is the login screen's actual
     argument rather than its decoration. */
  .nameline{margin-bottom:30px}
  .assume{margin-top:26px;max-width:430px;line-height:1.9}
""",
        "form": """
    <div class="nameline">
      <input id="hhname" placeholder="name it" maxlength="60" autocomplete="off"
             aria-label="System name" oninput="naming()">
      <p class="err" role="alert"><b id="errname">“Lawson Home”</b> already exists here —
        <a href="#" onclick="newcomerArrival();return false">ask to join it →</a></p>
    </div>

    <button class="btn" id="gobtn" type="submit" disabled>Create</button>

    <p class="note" hidden>four sections to start &middot; change them later</p>
    <p class="assume">London time, in pounds, with four sections to start.<br>
      All three move to settings.
      <span hidden><select id="tz" aria-label="Time zone"><option>Europe/London</option></select><select id="cur" aria-label="Currency"><option>GBP</option></select></span></p>
""",
    },
}

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

# The name steps down as it grows, so a long system name still sits on one
# line. The sheet's own naming() already runs on every keystroke.
STEP = """
  /* The sheet's naming() rewrites the act to "create <name> →". The login
     screen's pill is one short word and never grows, and §15 requires the
     two surfaces to carry the identical control, so this round holds the
     word still. */
  const _go = document.getElementById("gobtn");
  const _fix = () => { if (_go.textContent !== "__ACT__") _go.textContent = "__ACT__"; };
  new MutationObserver(_fix).observe(_go, { childList: true, characterData: true, subtree: true });
  _fix();
  const _name = document.getElementById("hhname");
  function stepName(){
    const n = _name.value.length;
    _name.classList.toggle("long", n > 13 && n <= 22);
    _name.classList.toggle("longer", n > 22);
  }
  _name.addEventListener("input", stepName);
  stepName();
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

    for slug, direction in DIRECTIONS.items():
        out, n = FORM_BODY.subn(
            lambda m: m.group(1) + direction["form"] + m.group(2), sheet, count=1
        )
        if n != 1:
            raise SystemExit(f"{slug}: could not find the card's form body")
        # Injected at the END of the sheet's stylesheet, not in the middle:
        # the sheet sets #hhname's own font later on, and an equal-specificity
        # rule placed earlier loses to it silently.
        out = out.replace("</style>", COMMON + direction["css"] + "\n</style>", 1)
        out = out.replace(
            "  <!-- §15: it is not \"form over login\"",
            f"  <span style=\"color:#d8b45a\">#862 {direction['title'].upper()}</span>\n"
            "  <!-- §15: it is not \"form over login\"",
            1,
        )
        out = out.replace("<title>", f"<title>#862 {direction['title']} — ", 1)
        step = STEP.replace("__ACT__", direction["act"])
        out = out.replace("</body>", f"<script>{step}</script>\n</body>", 1)
        (HERE / f"{slug}.html").write_text(out, encoding="utf-8")
        print(f"wrote {slug}.html")


if __name__ == "__main__":
    build()
