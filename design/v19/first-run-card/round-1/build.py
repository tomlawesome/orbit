#!/usr/bin/env python3
"""Builds round 1 of #862 from the ratified first-run sheet.

Each direction is `design/v19/first-run.html` copied verbatim, with three
surgical edits and nothing else:

  1. the `clouds` pack added to the token list and the swatch row, because
     clouds is the pack that exposed the defect and the sheet never had it;
  2. the `.card` ground replaced by the direction's own;
  3. the `[data-theme=atlas],[data-theme=dawn] .card` opacity exception
     deleted, which is the point of the whole round.

Everything else — the sky, the dawn, the hero ring behind the card, the
fields, the button, the igniting and reclaimed beats, the error state — is
carried forward byte for byte, because it is all ratified and re-drawing it
would read as regression.
"""

import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
SHEET = HERE.parents[1] / "first-run.html"

# ── 1. the missing pack ─────────────────────────────────────────────────────
# Tokens copied from web/src/lib/packs.css, which is where clouds actually
# lives; the sheet predates it.
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

# ── 2. the shared principle ─────────────────────────────────────────────────
# Every direction states it the same way, because it is the round's argument
# rather than any one direction's idea: the ground behind this card is the
# night sky on every pack, so the card's INK belongs to the sky. The ACCENT
# still belongs to the pack — it is the reader's own choice and the only
# thing here that should vary.
SKY_INK = """
  /* The ratified sheet's own running commentary describes the four passes
     that produced the card this round replaces, so it would be read as this
     round's argument. It stays in the file and out of the view. */
  .sheet{display:none}

  /* ── THE GROUND IS ALWAYS THE SKY (#862) ─────────────────────────────────
     The defect this round answers: the card took its ink from the active
     pack, but its ground is a night sky on every pack, so a light pack put
     dark ink on darkness and the design held it up with a hand-maintained
     list of which packs are light. The list forgot clouds. Any fix that
     keeps a list will be forgotten again the next time a pack is added.

     So the card stops reading the pack for legibility. Ink, rule and veil
     come from the sky, fixed, on every pack. The ACCENT still comes from the
     pack: it is the reader's own choice, it only ever appears on the button
     and the focus ring, and both sit on the card's own ground rather than on
     the sky. Nothing here is per-pack, so nothing here can be forgotten. */
  .card{
    --ink:#f0f4fb; --ink-mid:#b9c3d8; --ink-faint:#95a1ba;
    --line:rgba(240,244,251,.30); --line-soft:rgba(240,244,251,.16);
    --panel:rgba(9,14,30,.42);
    color:var(--ink);
  }
"""

DIRECTIONS = {
    "a-engraved": {
        "title": "A · engraved",
        "blurb": "no card at all — the questions are cut straight into the dawn",
        "css": """
  /* ── A · ENGRAVED ────────────────────────────────────────────────────────
     There is no card. The panel, the blur, the border and the shadow all go,
     and the questions stand directly on the sky — labels in small caps, each
     answer sitting on a single hairline, the button the one solid thing on
     the screen.

     What carries legibility instead of a panel is the ink's own halo: a
     tight dark shadow and a wider one, so every glyph brings its own ground
     with it. That is why this direction cannot wash out on any pack — there
     is nothing behind the words whose opacity could be wrong.

     It is also the closest the create path gets to the flight it turns into:
     nothing to dissolve, so the hand-over is the words themselves lifting. */
  .card{background:none;backdrop-filter:none;border:none;box-shadow:none;
        padding:2px 0 0;max-width:404px}
  .card .field label,.card .note{
        text-shadow:0 1px 10px rgba(2,5,14,.9),0 0 26px rgba(2,5,14,.75)}
  .card .field input,.card .field select{
        background:none;border:none;border-bottom:1px solid var(--line);
        border-radius:0;padding-left:2px;padding-right:2px;
        text-shadow:0 1px 10px rgba(2,5,14,.9),0 0 26px rgba(2,5,14,.75)}
  .card .field select{padding-right:26px}
  .card .field input:focus,.card .field select:focus{
        border-bottom-color:var(--accent);
        box-shadow:0 1px 0 0 var(--accent)}
  .card .selwrap::after{right:4px}
  #gobtn{box-shadow:0 18px 44px -20px rgba(0,0,0,.8)}
  body.arming .card{box-shadow:none}
""",
    },
    "b-aperture": {
        "title": "B · aperture",
        "blurb": "the card is a lens: the same sky, darker and sharper, seen through it",
        "css": """
  /* ── B · APERTURE ────────────────────────────────────────────────────────
     The card stops being something laid ON the sky and becomes something you
     look THROUGH. Inside its edge the same dawn is darkened and clarified —
     less blur than the glass had, not more — as though a lens were held up
     to the horizon. A single bright hairline is the whole frame; there is no
     fill to be too thin or too thick, only a darkening.

     Because the treatment is a darkening rather than a paint, it behaves
     identically on a light pack and a dark one: it can only ever make the
     ground behind the words darker, never paler. The pack cannot break it.

     It keeps what the glass card had and the engraving gives up — a discrete
     object with an edge, which is what the dissolve on submit is choreo-
     graphed against. */
  .card{background:linear-gradient(180deg,rgba(6,10,22,.62),rgba(6,10,22,.78));
        backdrop-filter:blur(3px) saturate(1.35) contrast(1.12) brightness(.72);
        border:1px solid rgba(240,244,251,.34);
        border-radius:18px;padding:26px 26px 24px;
        box-shadow:0 30px 80px -40px rgba(0,0,0,.75),
                   0 0 0 1px rgba(255,255,255,.05) inset,
                   0 0 60px -30px rgba(240,244,251,.35) inset}
  .card .field input,.card .field select{
        background:rgba(4,8,18,.45);border-color:rgba(240,244,251,.22)}
  body.arming .card{border-color:var(--accent);
        box-shadow:0 30px 80px -40px rgba(0,0,0,.75),
                   0 0 0 1px var(--accent) inset,
                   0 0 70px -12px color-mix(in srgb,var(--accent) 55%,transparent)}
""",
    },
    "c-plate": {
        "title": "C · plate",
        "blurb": "an instrument faceplate: solid, unlit, the dawn breaking around it",
        "css": """
  /* ── C · PLATE ───────────────────────────────────────────────────────────
     The opposite argument to A. Rather than dissolving the card into the
     sky, this makes it undeniably an object: a solid, unlit plate with a
     milled edge and a thin rule under its first question, like the faceplate
     of an instrument. No translucency at all, so there is no opacity to be
     wrong on any pack, and the dawn happens around the plate instead of
     through it.

     This is the most legible of the three by a distance, and the most
     ordinary. It is here because the first-run moment is the one time a
     person is asked to type something they cannot undo casually, and an
     instrument that is plainly an instrument may be the right register for
     that — at the cost of the card melting into the flight. */
  .card{background:#0a0f1e;
        backdrop-filter:none;
        border:1px solid rgba(240,244,251,.16);
        border-radius:14px;padding:28px 26px 24px;
        box-shadow:0 34px 90px -38px rgba(0,0,0,.9),
                   0 1px 0 0 rgba(255,255,255,.07) inset,
                   0 -1px 0 0 rgba(0,0,0,.6) inset}
  .card .field:first-of-type{
        border-bottom:1px solid rgba(240,244,251,.1);
        padding-bottom:18px}
  .card .field input,.card .field select{
        background:#060a16;border-color:rgba(240,244,251,.18)}
  body.arming .card{border-color:var(--accent);
        box-shadow:0 34px 90px -38px rgba(0,0,0,.9),
                   0 0 0 1px var(--accent) inset,
                   0 0 70px -14px color-mix(in srgb,var(--accent) 45%,transparent)}
""",
    },
}

# The exception this round exists to delete.
EXCEPTION = re.compile(
    r"\n  /\* the two light packs paint an ink-on-paper card.*?"
    r"\[data-theme=atlas\] \.card,\[data-theme=dawn\] \.card\{\n"
    r"\s*background:color-mix\(in srgb,var\(--panel\) 92%,transparent\)\}",
    re.S,
)


def build() -> None:
    sheet = SHEET.read_text(encoding="utf-8")

    if "[data-theme=clouds]" not in sheet:
        sheet = sheet.replace(
            "  [data-theme=retrograde]{", CLOUDS_TOKENS.strip("\n") + "\n  [data-theme=retrograde]{", 1
        )
    sheet = sheet.replace(
        '  <button class="sw" data-swatch="retrograde"', CLOUDS_SWATCH + '  <button class="sw" data-swatch="retrograde"', 1
    )

    sheet, removed = EXCEPTION.subn("", sheet)
    if removed != 1:
        raise SystemExit(f"expected to remove exactly one pack exception, removed {removed}")

    for slug, direction in DIRECTIONS.items():
        out = sheet.replace(
            "  <!-- §15: it is not \"form over login\"",
            f"  <span style=\"color:#d8b45a\">#862 {direction['title'].upper()}</span>\n"
            "  <!-- §15: it is not \"form over login\"",
            1,
        )
        # The direction's own ground goes after the shared principle, both
        # after the ratified .card rule so they override rather than replace
        # it — the transitions and the two exit beats stay exactly as ratified.
        anchor = "  .field{margin-bottom:18px}"
        out = out.replace(anchor, SKY_INK + direction["css"] + "\n" + anchor, 1)
        out = out.replace(
            "<title>", f"<title>#862 {direction['title']} — ", 1
        )
        (HERE / f"{slug}.html").write_text(out, encoding="utf-8")
        print(f"wrote {slug}.html")


if __name__ == "__main__":
    build()
