# First-run tour — round 1 (#866)

The tour reframed as a story rather than a pointer: "run your first year in
a minute". One item is born, time runs, paper arrives, it comes round. The
owner's reading of Node-RED's "moves the interface" on 2026-09-16: "Yeah
basically. Though it would be helpful to show off some other parts of the
site." Both directions here show create, relay, inbox and the belt; they
differ in *where the reader stands* while they are shown.

Served at `http://<LAN address>:8335/v19/tour/round-1/<file>`. Each file
is a player: next/back/skip on the shipped tour card, `←`/`→`/`Esc`, or
`#beat-n` in the address bar. Backdrops in `shots/` are the fixture app at
1280×800, captured on 2026-09-16 after #1005 landed; nothing in a beat is
drawn that the sky does not already draw (body faces, paints and the dial
law are `chart.js`, scaled 640/380 about (640,400)). The card is
`tour.css` verbatim.

## The one data story (identical across directions)

Household **Lawson Home**, today 13 Aug 2026. The reader adds **Car MOT —
Volvo V60** (inspection, £54.85, due 29 Aug 2027, every year). Time runs
to T−16 and the reminder fires. A **Home insurance renewal** arrives by
relay and lands in the inbox; one tap adds it. The MOT's belt holds the
certificate and the service history. The MOT is marked done and swings
out to T−381. Other suns: Seaside Cottage, Gran's Flat, The Narrowboat
(Mum & Dad's sits under the card and is not lit).

Ten beats, same copy in both directions:

| # | Beat | Screen |
|---|---|---|
| 1 | This is your sky | home, empty |
| 2 | Add anything from the north star | create |
| 3 | It lands where its date falls | home |
| 4 | Time runs; a month out it warms; reminder | home + toast |
| 5 | Paper by post → relay address | relay |
| 6 | It lands in your inbox; one tap adds it | inbox |
| 7 | A body's paper rides beside it | belt |
| 8 | Done → swings out to next year | home |
| 9 | Other households; tap to ask to join | home |
| 10 | A year in a minute; now it's yours | home + settings orb |

## Directions

**A — on the sky** (`a-on-the-sky.html`). The reader never leaves home.
Other screens appear as a small framed insert to the left of the dial,
threaded to the thing on the sky they belong to (the north star, the MOT
body). The sun and the body stay in view for all ten beats, so the year
reads as one continuous motion. Cost: the inserts are reductions — the
belt at ½ scale is under the legibility floor, and the create insert only
just clears it.

**B — across the ship** (`b-across-the-ship.html`). The tour walks the
reader to each screen at full size — create, relay, inbox, belt — with the
veil-and-cut-out mechanic the shipped tour already uses (everything else
drops to the faint tier, the lit thing shows through). The sky beats
return to home between visits, and the body carries the thread: T−365,
T−16, T−381. Cost: four scene changes; the sun is off-screen for beats
2, 5, 6 and 7.

## Scope of this round

Desktop dial only. Pocket (the phone dialect), the adrift state (no
household) and the empty sky are round 2, once the beats are ratified:
they change what each beat can show, not what the story is. Reduced
motion is respected in both files (end states, no walks).

## Verdicts

Owner, 2026-09-16, in chat, numbered against the round's questions:

- 13 (direction): "B"
- 14 (watch-only vs reader performs): "Let's try watch only first" / "Watch only."
- 15 (beats to cut or add): "Good for now."

So: direction B, watch-only, the ten beats as listed. Round 2 carries B onto
pocket, adrift and the empty sky. Direction A is closed (superseded by B;
its inserts fell below the legibility floor).
