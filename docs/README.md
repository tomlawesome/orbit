# Orbit documentation

Everything that used to be in the project README, and the rest of Orbit's
reference material. The [website](https://tomlawesome.github.io/orbit-site/)
has the friendly introduction; these pages are the detail behind it.

## What Orbit is

- [What Orbit does](overview.md): the screens, the features, and the small
  set of services Orbit runs on.
- [v1 charter](v1-charter.md): what a stable release must do, and what it
  deliberately does not.
- [Product direction register](feature-register.md): possible and agreed
  directions outside the stable contract.

## Install

- [Installing Orbit](installing.md): the install command, what the installer
  asks, unattended installs, what gets installed, and building from source.
- [Installer guarantees](installer-guarantees.md): what every install,
  configuration, backup and restore script promises, with the upgrade
  procedure at the head of its second part.

## Operate

- [Running Orbit](operating.md): configuring and starting the Docker stack,
  the optional local processing services, updating a checkout, backups,
  building or deploying, and the checklist before the first real launch.
- [Configuration](administrator-operations.md#configuration): every
  `.env-orbit` setting, what uses it, and an example value.
- [Before and after an upgrade](installer-guarantees.md#before-and-after-an-upgrade):
  back up first, and how to return to the previous build if an upgrade fails.
- [Administrator operations](administrator-operations.md): diagnostics,
  corrective actions, maintenance mode, the mailbox, key rotation, recovery
  bundles and the private model server.
- [Encryption at rest](encryption-at-rest.md): what Orbit encrypts, what it
  does not, and the decision about the host disk that is left to you.

## Upgrades, channels and releases

- [Releasing](releasing.md): the preview and stable channels, how a release
  is promoted and signed, the signed launcher, and how to check a release's
  signatures.
- [Supply-chain evidence](supply-chain.md): the checks a published image has
  to pass.

## Sign-in

- [Authentication](authentication.md): claiming a fresh install, local
  accounts, adding an identity provider (OIDC) later, Authentik and other
  providers, and troubleshooting.

## Design and security

- [Architecture](architecture.md): the system's parts, trust boundaries and
  main data flows.
- [Architecture decision records](adr/README.md): the index of every ADR.
- [Document threat model](document-threat-model.md): the security boundary
  for stored documents.
- [Security policy](../SECURITY.md): how to report a vulnerability privately,
  and which releases receive fixes.

## Testing and development

- [Testing Orbit](testing.md): the test commands, setting up a local
  development stack, the local harnesses and the local traps.
- [Quality strategy](quality-strategy.md): the test layers, CI lanes and the
  definition of done.
- [Engineering baseline](engineering-baseline.md): the dated evidence of what
  is proven ready.
- [Engine event stream](engine-events.md): the installer's machine-readable
  status lines.
- [Private local evaluation](private-eval.md): scoring extraction against
  your own documents, entirely on your machine.
- [Extraction method](extraction-method.md): how extraction work is done and
  measured, and the rulings behind it.
- [Implementation plan](implementation-plan.md): the phased roadmap.
