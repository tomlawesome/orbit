# Installing Orbit

How to install Orbit on a Linux machine, what the installer asks, and what
it sets up. Once it is running, [Running Orbit](operating.md) covers looking
after it. [The installer's guarantees](installer-guarantees.md) list exactly
what each script promises.

## What you need

- A Linux machine with 64-bit x86 processors (amd64). Orbit's builds are
  made for amd64 only for now. The launcher itself also runs on arm64, but
  Orbit will not.
- Docker with Compose v2.
- `curl`, `openssl`, `tar`, `sha256sum` and `base64`, which most Linux
  systems already have.
- An HTTPS address for Orbit, served by a reverse proxy on that machine or
  in front of it.
- About 4 GiB of free memory for the malware scanner, on top of Orbit and
  its database.

Your reverse proxy must accept uploads a little larger than Orbit's document
limit, which is 50 MiB by default and can be set as high as 100 MiB. Many
proxies refuse much smaller requests unless told otherwise, and a document
over the proxy's own limit fails with "413" before it reaches Orbit. Set the
proxy a little above the limit your administrator chooses: 51 MiB for the
default, or 101 MiB to cover every possible setting.

- nginx: `client_max_body_size 51m;` (or `101m;`). Its default is 1 MB, so
  this setting is needed.
- Caddy: has no limit unless you set `request_body { max_size 51MiB }`.
- Traefik: has no limit unless the buffering middleware sets
  `maxRequestBodyBytes` (53477376 is 51 MiB).

If the document limit is raised later, raise the proxy setting to match.

## Install

From an empty directory, run:

```bash
curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/get-orbit.sh | bash
```

This one line downloads and checks the signed Orbit launcher before it runs
anything:

- it checks the release's signed manifest (the list of files that make up
  the release) against Orbit's public key;
- if `cosign` is installed, it also checks a second, independent signature,
  and refuses if that signature is missing;
- it checks every file it downloads against the checksum in the manifest.

Only once everything checks out does it start the launcher, which runs the
installer described below. It installs the newest stable release. To install
one particular release instead, put `ORBIT_VERSION=v0.3.0` (or another
version) in front of `bash`. [Installer guarantees](installer-guarantees.md)
says exactly what is checked (its `get-orbit.sh` section), and [Releasing](releasing.md) says how the
signatures are made.

Git is not needed and nothing is cloned. A deployment needs only the Compose
files, a few operator scripts and a published build of Orbit, not the source
code.

### What the installer asks

The installer shows a menu: Install, Update, Repair or Exit.

- **Install** sets up a new Orbit in an empty directory. It first asks which
  profile you want: Standard (Orbit, its database and the malware scanner),
  Document processing (adds a local document text reader), Full local stack
  (adds a private AI model server as well), or Custom. It then asks whether
  people will sign in with Orbit's own accounts only (the default) or also
  through an identity provider, an external sign-in service such as
  Authentik. With Orbit's own accounts, it needs only Orbit's public address.
  With an identity provider, it also needs the provider's address (the
  "issuer"), the client ID the provider gave you, and the client secret,
  which you type hidden. Nothing in the directory changes until you accept
  the final review screen.
- **Update** moves an existing Orbit to the new release. If the current
  settings are complete, it keeps them and your secrets as they are and does
  not ask for them again. From a terminal, it asks whether to keep the
  current profile, then shows a review screen before it changes anything. Back up first: see
  [Before and after an upgrade](installer-guarantees.md#before-and-after-an-upgrade).
- **Repair** changes nothing. It tells you to run
  `bash scripts/repair.sh --check` to find what is wrong, then `--plan` to
  see what a repair would do.

When everything is running, the last screen shows Orbit's address, the
version, the exact build installed, the profile, and the commands for status
and logs. It then tells you two things to do next:

- Claim the new Orbit: the link that creates its first administrator is the
  last line of the Orbit container's log. See
  [Claiming a fresh install](authentication.md#claiming-a-fresh-install).
- Export a recovery bundle, the only way back in if the document encryption
  key is ever lost. See
  [Exporting a recovery bundle](administrator-operations.md#exporting-a-recovery-bundle).

### What gets installed

The installer downloads Orbit from the release registry and records exactly
which build it downloaded, using the build's digest: a fingerprint that
identifies one build and nothing else. That fingerprint is written to
`.env-orbit`, and that build is what runs, so nothing can swap in a
different build behind your back.

The Compose files and operator scripts come out of that same build, so they
always match the version they came with. The directory ends up holding
`docker-compose.yml`, `docker-compose.mail.yml`, `.env-orbit.example`,
`config/tika-config.json`, the scripts `configure.sh`,
`backup.sh`, `restore.sh`, `repair.sh`, `export-recovery-bundle.sh`,
`import-recovery-bundle.sh` and `installer-ui.sh`, your settings in
`.env-orbit`, and your secrets in `.orbit-secrets/`.

The installer itself only fetches, checks and starts things. Everything that
reads or writes the directory — checking it is safe to install into, asking
your questions, writing the settings and secrets, and checking your sign-in
provider — runs inside that same build, in a short-lived container that is
removed when it finishes. If anything goes wrong before Orbit starts, it puts
the directory back exactly as it was.

The installer then generates four separate secrets: one for sign-in
sessions, the database password, the document encryption key, and a key
private key for browser alerts. They live in `.orbit-secrets/`, readable only by
the user who ran the installer. Each container is given only the secret
files it needs; secret values never go into container environment
variables. Later runs keep the secrets you already have.

It reports success only once the database is healthy, Orbit's own health
check at `/api/health` says ready, the malware scanner is healthy, and each
optional service you chose answers its check.

If you cancel during the questions, or a run finds a setting that needs
attention, the installer puts its files back as they were and prints only
the names of the settings and what to do next. Run the install line again,
or fix the settings directly from the deployment directory:

```sh
bash scripts/configure.sh --init
bash scripts/configure.sh --set-oidc-secret
bash scripts/configure.sh --check
```

These commands run inside the Orbit image, so Docker must be running and
the image must be available, even for a one-line change. `configure.sh`
takes the image from `ORBIT_IMAGE` in your environment, or else from the
`ORBIT_IMAGE=` line the installer wrote to `.env-orbit`. If it finds neither
it stops with:

```text
Orbit configuration: No Orbit image to run configuration with. Set ORBIT_IMAGE to an immutable registry digest (or the local tag scripts/build-container.sh builds), or install with get-orbit.sh, which records it in .env-orbit.
```

To go on, set `ORBIT_IMAGE` to the build's registry digest and run the
command again. A digest that is not on this machine yet is pulled first.
Files `configure.sh` creates belong to the user who ran it.

## Logged and unattended runs

The options in this section belong to `install.sh`, the installer script
the launcher runs for you. Running `install.sh` on its own is not a
supported way to install (see [Releasing](releasing.md)); the options are
listed for automated and test runs. Add `--plain` for output with no screen drawing, one line at
a time, safe for logs and pipes. Name the action with `--install`,
`--update` or `--repair`; with none, it installs into an empty directory and
updates a directory that already holds Orbit. `--install` accepts only an
empty directory (or a prepared one, below); `--update` accepts only a
directory that already holds Orbit.

`--simulate` (with `--plain` if you like) is a rehearsal. It shows the same
menus, questions and example success and failure screens, using clearly
labelled made-up values. It does not read or change the directory, and it
never contacts Docker, a registry or an identity provider. It cannot be
combined with `--install`, `--update` or `--repair`.

### Installing with no questions

For an unattended install, the directory must already hold a complete
`.env-orbit` and an `.orbit-secrets/` directory, and nothing else. Before it
downloads anything, the installer checks that:

- `.env-orbit` is a plain file (not a symlink) with permissions `0600`;
- `.orbit-secrets/` is a real directory (not a symlink) with permissions
  `0700`, and every file inside it is a plain, non-empty file with
  permissions `0600`;
- `.orbit-secrets/oidc-client-secret` exists, even when people sign in with
  Orbit's own accounts only;
- `.env-orbit` passes `bash scripts/configure.sh --check`.

Anything else is refused before Docker or any download starts: extra files,
symlinks, empty files, looser permissions, a setting that still needs
attention, an invalid callback address, or an optional group of settings
that is only half filled in. If the configuration check, the identity
provider lookup or the Compose check then fails, your files are left exactly
as they were.

## Building from source

Building is a developer task, not an install option, so the installer does
not offer it. Clone the repository and build:

```bash
git clone https://github.com/tomlawesome/orbit.git && cd orbit
```

Two scripts then matter, and each needs something the other can produce.
`bash scripts/configure.sh` runs inside the Orbit image, so it needs one: an
`ORBIT_IMAGE` in your environment (a registry digest, or the local tag
`build-container.sh` builds) or in `.env-orbit`; a local tag that has not
been built yet is refused. `bash scripts/build-container.sh` needs no
`.env-orbit`, so on a fresh checkout `bash scripts/deploy-container.sh
--build` does the whole job in the right order: build the image, run
configuration, start Orbit.

[Running Orbit](operating.md#running-a-source-checkout) covers starting and
updating a checkout, and [Testing Orbit](testing.md#local-development) covers
a development setup.
