# Stack suite

Playwright against the full Compose stack (app, Postgres, sign-in provider,
mail, Tika, ClamAV), run by `scripts/test-e2e-local.sh` and `scripts/test-frontend.sh`.

It is the last runner in ADR-0039 §2 (`docs/adr/`) and holds only what nothing
cheaper can prove: real sign-in and cookies, uploads and the document pipeline,
mail in and out, archive import and export, invitations and membership, the
bootstrap claim, the maintenance window end to end, and runtime properties of
the image. It runs on Chromium desktop and phone, plus a WebKit sliver of the
sign-in journeys (`webkit-sliver-specs.txt`).

Anything a browser alone can prove (focus, layout, motion, axe, the tour)
belongs in the rig, `web/tests/rig/`; logic and API boundaries belong in Vitest.
A new spec here needs a reason the rig or Vitest cannot carry it.

Some `support/` helpers (keyboard, motion, arrival, settle, frames, card-layer)
are imported by the rig; check `web/tests/rig/` before deleting one.
