# Orbit documentation

The pages are grouped by who they are for. The
[website](https://tomlawesome.github.io/orbit-site/) has the friendly
introduction; these pages are the detail behind it.

## For users

- [Using Orbit](using-orbit.md): the everyday guide, from joining a household
  to adding an item, setting when it is due, reminders and documents.
- [What Orbit does](overview.md): the screens, the household, and the small
  set of services Orbit runs on.
- [Authentication](authentication.md): how sign-in works, including
  password approval by email and linking an identity provider.

## For administrators

Setting Orbit up:

- [Installing Orbit](installing.md): what you need, what runs where, the
  install command, what the installer asks, unattended installs and what gets
  installed.
- [Installing a preview build](installing-preview.md): installing a preview by
  digest from its signed manifest, with the signature checked by hand.

Looking after it:

- [Running Orbit](operating.md): opening Orbit, claiming it, starting and
  stopping it, changing settings, the optional document services, and the
  checklist before real use.
- [Upgrades and backups](upgrades-and-backups.md): backing up, updating, going
  back after a failed update, and restoring.
- [Administrator operations](administrator-operations.md): diagnostics,
  corrective actions, maintenance mode, adding a local user, recovering the
  primary administrator, the mailbox, recovery bundles, key rotation and the
  private model server.
- [Configuration](administrator-operations.md#configuration): every
  `.env-orbit` setting, what uses it, and an example value.
- [Authentication](authentication.md): claiming a fresh install, local-only
  mode, adding OIDC later, Authentik and other providers, and
  troubleshooting.
- [Encryption at rest](encryption-at-rest.md): what Orbit encrypts, what it
  does not, and the decision about the host disk that is left to you.
- [Security policy](../SECURITY.md): how to report a vulnerability privately,
  and which releases receive fixes.

## For contributors

How Orbit is built and checked:

- [Developing Orbit from source](development.md): building the image from a
  clone and running a source checkout.
- [Testing Orbit](testing.md): the test commands, local development stack,
  local harnesses, the exact-image mailbox acceptance procedure and local
  traps.
- [Quality strategy](quality-strategy.md): the test layers, CI lanes and the
  definition of done.
- [Architecture](architecture.md): the system's parts, trust boundaries, main
  data flows and sign-in internals.
- [Architecture decision records](adr/README.md): the index of every ADR.
- [Document threat model](document-threat-model.md): the security boundary
  for stored documents.
- [Engine event stream](engine-events.md): the installer's machine-readable
  status lines.
- [Installer guarantees](installer-guarantees.md): what every install,
  configuration, backup and restore script promises.
- [Private local evaluation](private-eval.md): scoring extraction against
  your own documents, entirely on your machine.
- [Extraction method](extraction-method.md): how extraction work is done and
  measured, and the rulings behind it.

How Orbit is released and planned:

- [Releasing](releasing.md): the preview lane and stable promotion, how a
  release is signed, and how to check a release's signatures.
- [Supply-chain evidence](supply-chain.md): the checks a published image has
  to pass.
- [v1 charter](v1-charter.md): what a stable release must do, and what it
  deliberately does not.
- [Product direction register](feature-register.md): possible and agreed
  directions outside the stable contract.
- [Implementation plan](implementation-plan.md): the phased roadmap.
