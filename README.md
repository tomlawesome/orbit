> [!IMPORTANT]
> **Development disclosure:** Orbit was coded by Claude under human
> direction.

<p align="center">
  <img src="docs/images/orbit-mark.svg" alt="Orbit logo" width="132" />
</p>

<h1 align="center">Orbit</h1>

<p align="center">
  <strong>your year, in orbit</strong>
</p>

<p align="center">
  <img src="docs/images/orbit-banner.png" alt="Orbit — your year, in orbit" width="100%" />
</p>

Boilers need servicing. Insurance renews. Cars need inspections. Devices
leave warranty. Contracts roll over. Orbit brings those scattered
responsibilities into one calm, shared view, so the important things stay
visible before they become urgent. It runs on your own machine, for your
household. No paywall, no plan, no account with us.

## A quick look

<p align="center">
  <img src="docs/assets/product-tour/overview.png" alt="The Orbit home screen: what is due next, across the household" width="100%" />
</p>

<p align="center">
  <img src="docs/assets/product-tour/item-detail.png" alt="One item: its schedule, history and documents" width="49%" />
  <img src="docs/assets/product-tour/inbox.png" alt="The inbox: paper that arrived by post or email, ready to file" width="49%" />
</p>

## What it does

- **Everything in your orbit, on track.** One view of what is due next, for
  the whole household, with sections that fit your life: Home, Vehicles,
  Devices and Services to start, yours to rename and reshape.
- **Done once, remembered for good.** Each item keeps its schedule, its
  history and its encrypted documents, so the next time is never a search.
- **Forward, then file.** Post a letter or forward an email and Orbit reads
  it, suggests where it belongs and waits for you to agree.
- **Shared, private, and yours to shape.** Several households on one Orbit,
  each sealed from the others; local accounts always, an identity provider if
  you want one; five colourways, light and dark.
- **One app, standard parts.** Orbit, PostgreSQL and a few well-known
  services in Docker, installable on a Linux box in minutes and backed up with
  one command.

## Get Orbit

On a Linux host with Docker Compose v2 and `curl`, from an empty directory:

```bash
curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/get-orbit.sh | bash
```

This fetches the signed Orbit launcher and verifies its manifest and
checksums before running anything, then the launcher installs Orbit and
proves the image it pulled is the one the release signed. The website's
[install guide](https://tomlawesome.github.io/orbit-site/#install) walks
through what it asks and what it sets up.

## Everything else

- **The website:** [tomlawesome.github.io/orbit-site](https://tomlawesome.github.io/orbit-site/)
  — how it works, the install guide, the demo, and the documentation.
- **Security and support:** [SECURITY.md](SECURITY.md) — how to report a
  vulnerability privately, and which releases receive fixes.
- **Licence:** Orbit is free software under the
  [GNU Affero General Public License v3.0 or later](LICENSE). If you run a
  modified Orbit for others over a network, the AGPL's remote-interaction
  clause applies. The three bundled typefaces are separately licensed under
  the SIL OFL 1.1; their licence text ships with the application.

<p align="center">
  <img src="docs/images/orbit-mark.svg" alt="" width="52" />
  <br />
  <strong>your year, in orbit</strong>
</p>
