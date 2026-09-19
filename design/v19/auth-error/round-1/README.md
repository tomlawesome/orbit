# Sign-in did not complete — round 1 (#1056)

One state in the door's own family for the identity-provider callback that
fails. Artwork in every sheet is the shipped door verbatim (copied from
`design/v19/signin-states/round-1/c-the-held-dawn.html`, itself the copy of
`web/src/lib/flight/`); only the state layer differs.

Served at `http://<LAN address>:8336/1056-auth-error/design/v19/auth-error/round-1/<file>`.
Each sheet's demo bar (foot of page; sheet furniture, not design) switches
scenes.

## Where every refused way in lands today

Read from the code on `gitlab/dev` (f78558d) and, for the approval page,
`gitlab/feat/1033-email-second-factor`.

| Case | Where it lands today | What the reader sees |
|---|---|---|
| Identity-provider callback fails (`web/src/routes/api/auth/callback/+server.js`, `callbackFailure`): any of `auth_not_configured`, `provider_error`, `invalid_request`, `invalid_state`, `discovery_failed`, `token_exchange_failed`, `invalid_id_token`, `missing_email`, `step_up_failed`, `link_exists`, `bootstrap_claimed`, `account_disabled`, `instance_locked`, or anything unknown (`asAuthError` folds it to `provider_error`) | 303 to `/auth/error?code=<code>` — **no such route exists in `web/`**, so it resolves as a 404 | **The gravity well**: "This page fell into a gravity well. plot a course home →". A refused sign-in reads as a lost page. This is the undrawn case, and the only one. |
| Callback with no readable auth config at all | JSON envelope in the tab (`authErrorResponse`) | Raw JSON. Pre-existing, out of scope: no error screen exists to send to without config. |
| `GET /api/auth/login`, `step-up/start`, `link/oidc/start` refusing before leaving for the provider (`auth_not_configured`, `bootstrap_required`) | JSON envelope in the tab (`api()` wrapper) | Raw JSON. The door's own states keep readers off these in practice (unconfigured hides the gate; the claim card re-checks); the one live path is a claim cookie lapsing between the create card and the provider. Noted, not designed here. |
| Lapsed / spent / unknown **setup** link (`/setup/[token]`) | Stays on the setup card; `POST /api/auth/local/setup` answers `setup_token_invalid` and the card repeats `cardMessageFor` | "This link has been used already, or it has expired." on the card — **drawn**. |
| Lapsed / spent / unknown **approval** link (`/approve/[token]`, #1033 branch) | Stays on the approval page; `readSignInApproval` gives `lapsed` or `null` | "This link has lapsed" / "This link is no longer any good" headings — **drawn**. |
| Used / expired / withdrawn / unknown / mismatched **invitation** (`/invite/[token]/+page.server.js`) | Stays on the invite screen with one line and, for mismatch, one action | Its own line, e.g. "This invitation has expired — ask Tom for a new one." — **drawn**. |
| Signed-out reader on a gated screen (`hooks.server.js`) | 303 to `/login?returnTo=…` | The door — **drawn**. |
| Missing item / household (`item/[[id]]`, `household/[id]`) | `error(404)` | The gravity well, correctly: those are lost pages. |

So after the check the issue asked for, **only the OIDC/callback failure is
undrawn**, and today it is worse than bare: it is the 404. Directions A and B
design for that case alone. Direction C is the requested "what if the lapsed
links were not covered" answer, drawn for comparison and recommended against.

What the code knows at `/auth/error`: the `code`, and — by the same
`GET /api/auth/availability` read the shipped door already makes — the
public contact address an administrator set (#860). Nothing else: no
`returnTo`, no provider text, no token-exchange reason (the callback keeps
those off the wire). Every sheet reads exactly those two things.

## The one wording story (identical across directions)

| State | Primary | Subline | Action |
|---|---|---|---|
| Sign-in didn't complete (every callback code but one) | Sign-in didn’t complete. | Nothing was changed. If it keeps happening, let us know at «public contact address». | the ratified pill, reworded **Try again** → `/login` |
| No contact address set | Sign-in didn’t complete. | Nothing was changed. | as above |
| Refused: `account_disabled` (direction B only) | Sign-in was refused. | The administrator has disabled this account. If that’s a surprise, let us know at «public contact address». | none — a retry is a lie here |

Fixed copy Orbit owns, in the voice of the table the owner ratified on
2026-09-06 (#788): the administrator named plainly, the visitor never
blamed, the address dropped as a whole sentence when none is set. Provider
text appears nowhere; the `code` is read only to pick a row, as
`cardMessageFor` reads it, and is never shown.

"Nothing was changed" is the one subline true for every code: the callback
clears the transaction and creates no session, and for the step-up and
link kinds the reader's existing session is untouched. "You're not signed
in" was rejected for that reason — a reader linking a second provider from
settings *is* signed in when they land here.

The pill is the same ratified gate with one word changed, the licence the
goodbye's "Sign back in" already has (§15, 2026-08-17).

## Directions

**A — the door again** (`a-the-door-again.html`). The reader is simply back
at the door: full first light, the ring, the word, the pill — reworded to
"Try again" — and two lines under the ring saying what happened. The sky is
untouched because nothing about the door has changed: it is open and the
reader is not through it. This is the minimal answer, and the one I would
build: one new `data-state` (`incomplete`) that, unlike #788's three, keeps
the gate. What tells "refused" from "lost" is that the 404 has no door and
no handle, and this screen is nothing but the door and its handle. The
primary line was first tried under the pill inside the ring (the mixed-mode
"local login" slot): at 14px the full stop sat on the ring's stroke, so both
lines go under the ring, the primary in the ratified subline slot (+174px)
and the subline 32px below it. Pressing the pill flashes it on the gate's
own 420 → 900ms beat and shows the door it lands on.

**B — the held dawn, refused** (`b-the-held-dawn-refused.html`). The sky
records the failure: the reader lands under the #788 held dawn (dawn layer
.32, rays folded, sun .38, shimmer .35 — only opacities the lit sequence
already animates), with the pill still present; pressing it plays the
door's own sunrise, so the retry *is* the recovery as ratified. B also
carries the one face A cannot: `account_disabled`, where a retry is a lie.
That face is a fourth #788 state in every respect — held dawn, no pill
rendered, primary in the ring where the handle stood, subline under the
ring — and names the administrator. The honest caution: #788 ratified the
held sky as "the door cannot open" and hid the pill with it; B's first face
puts a handle on a held sky, which bends that meaning. Offered so the two
readings can be compared side by side.

**C — every dead end** (`c-every-dead-end.html`). What I would do if the
lapsed-link cases were *not* drawn elsewhere: one screen for every dead end
on the way in, using the two grammars the door already has — A's (full
dawn, pill, words under the ring) where the code gives a next step (a
lapsed approval link: "Sign in", a new link will be sent), and #788's held
grammar (no pill, words in the ring, the issuer named) where it gives none
(a spent setup link, an expired invitation). The inventory above shows all
three already have a drawn home that holds the token and can say the
precise thing; a redirect here would trade that for a generic line.
**Recommendation: do not build C.** It is here so the ruling is made on
something visible rather than on the inventory alone.

## Scenes proved (every direction)

(a) callback failed, with and without a contact address; (b) a lapsed link
— setup, approval, invitation — in C only, since the inventory puts them
out of scope; (c) each at 1600×1000 and 390×844; (d) reduced motion.

## Gates

- Dataviz palette validator: N/A — no data palette on this surface; text
  inks are the door's own ratified tokens (#e9edf8/#cfd3e4/#8791b3 on
  #04060e all ≥6:1; gold #d8b45a on #04060e 10:1), unchanged from #788.
- Screenshots: every direction × every scene × 1600×1000 and 390×844,
  plus a reduced-motion capture per direction, taken with Playwright from
  the worktree and reviewed (`review/`, untracked). Fixed before this
  commit: the primary line grazing the ring's stroke when set under the
  pill inside the ring (moved under the ring, see A).
- Floors: no stated pixel floor found in `docs/` or `design/` beyond the
  contrast figures above; the smallest type is the ratified 10.5px mono
  subline, unchanged. **Not met, and left as is:** the ratified gate
  measures about 36px tall (12px type, 11px padding), under the 44px
  target floor. It is the shipped pill on every door surface, so this
  round does not resize it; if the floor is to apply here it applies to
  the door as a whole.
- `prefers-reduced-motion`: animations off, staging kept, transitions cut
  to .4s with no delay — the #788 sheet's own rule, verbatim.
- The live region (`role="status"` `aria-live="polite"`) announces the two
  lines; where no pill is offered it is not rendered, not merely hidden.
- No provider text, no error code, no `returnTo` on screen.

## Deliberately not done

- No per-code wording beyond the one refused face. The pre-rebuild page
  (`src/app/auth/error/page.tsx`, deleted in 8a315e1) had seven lines, most
  of which blamed the reader's provider; one line that is true for every
  code is the door's own rule (`credentials_invalid` is one sentence for
  four causes for the same reason).
- No "return home" link beside the pill: `/login` already hands a
  signed-in reader on, so one action covers both the signed-out and the
  signed-in (link, step-up) arrivals.
- No countdown, no automatic retry: the callback has nothing to poll.

## Build note (not a design call)

The callback's target is `/auth/error?code=…` and no such route exists in
`web/`. The state layer here is `SignIn.svelte`'s existing `data-state`
mechanism with one more value; whether that is reached by adding the route
or by re-pointing `callbackFailure` at `/login?…` is the build's choice.

## Open questions for the owner

**1** Sky: A (the door as it is, untouched sky) or B (the held dawn with a
handle)?

**2** Pill wording: "Try again", or the door's own "Sign in"?

**3** Is `account_disabled` worth its own refused face (B), or does the one
line cover it, with the reader finding out from the administrator?

**4** Confirm C is not built — the lapsed links stay on the setup card, the
approval page and the invite screen.
