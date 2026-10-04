# Installing Orbit

How to install Orbit on a Linux host, what the installer asks and what it
sets up. Once it is running, [Running Orbit](operating.md) covers starting,
updating and backing it up; [the installer's guarantees](installer-guarantees.md)
list exactly what each script promises.

## Quick start

From an empty directory on a Linux host (amd64 or arm64) with Docker Compose
v2 and `curl`:

```bash
curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/get-orbit.sh | bash
```

This downloads the signed Orbit launcher and checks it before running
anything: it verifies a signed manifest, checks every file's checksum
against that manifest, and (if `cosign` is installed) checks a second,
independent signature too. Only once everything checks out does it hand off
to the launcher, which runs the same installer described below. See
[docs/installer-guarantees.md](installer-guarantees.md) for exactly
what is checked, and [docs/releasing.md](releasing.md) for how the
signatures are made.

The older direct command still works and is signature-checked the same way:

```bash
curl -fsSL https://raw.githubusercontent.com/tomlawesome/orbit/main/scripts/install.sh | bash
```

### What the installer asks

Run from a terminal, the installer shows a menu: Install, Update, Repair or
Exit.


- **Install** sets up a new Orbit in an empty directory. It first asks which
  profile you want: Standard (Orbit, its database and the malware scanner),
  Document processing (adds a local text-extraction service), Full local stack
  (adds a local AI model server as well), or Custom. It then asks whether
  people will sign in with local accounts only (the default) or also through
  an identity provider, an external sign-in service such as Authentik. Local
  accounts only: it needs just Orbit's public address. Identity provider as
  well: it also needs the provider's address (the "issuer"), the client ID it
  gave you, and the client secret, which you type hidden. Nothing in the
  directory changes until you accept the final review screen.
- **Update** refreshes an existing Orbit. If the current settings are complete
  it keeps them, and your secrets, exactly as they are and does not ask again.
- **Repair** changes nothing yet. It tells you to run
  `bash scripts/repair.sh --check` to diagnose the deployment, then `--plan`
  to see what a repair would do.

When everything is running, the final screen shows Orbit's address, the
version, the exact build installed, the profile, and the commands for status
and logs. It also points you at the container log, which holds the link for
claiming the new Orbit and creating its first administrator: see
[Claiming a fresh install](authentication.md#claiming-a-fresh-install).

Git is not needed and the repository is not cloned. A deployment needs only
the Compose files and a published build, not the source code or tests.

### Automated or logged runs

Add `--plain` for output with no screen drawing, one line at a time, safe for
logs and pipes, and name one action: `--install`, `--update` or `--repair`.
`--install` accepts only an empty directory (or a pre-provisioned one, below);
`--update` accepts only a directory that already holds an Orbit deployment.

`bash scripts/install.sh --simulate` (with `--plain` if you like) is a
rehearsal. It shows the same menus, prompts and example success and failure
screens, using clearly labelled made-up values. It does not read or change the
directory and never contacts Docker, `curl`, a registry or an identity
provider. It cannot be combined with `--install`, `--update` or `--repair`.

### Installing with no prompts

For an unattended install, the directory must already contain a complete
`.env-orbit` and an `.orbit-secrets/` directory, and nothing else. Before it
downloads anything, the installer checks that:

- `.env-orbit` is a plain file (not a symlink) with permissions `0600`;
- `.orbit-secrets/` is a real directory (not a symlink) with permissions
  `0700`, and every file inside it is a plain, non-empty, non-symlink file
  with permissions `0600`;
- `.orbit-secrets/oidc-client-secret` exists and is not empty;
- `.env-orbit` points at that secret file (the file-backed setting, not the
  direct one) and passes `bash scripts/configure.sh --check`.

Anything else is refused before Docker or any download starts: extra files,
symlinks, empty files, looser permissions, a setting that still needs
attention, an invalid callback address, or an optional group that is only
half filled in. If configuration, identity-provider discovery or the Compose
pre-check then fails, your files are left byte-for-byte as they were.

### What gets installed

The installer downloads Orbit from the release registry, the server that
publishes Orbit's builds. It records exactly which build it downloaded using
the build's digest: a fingerprint that identifies one build and nothing else.
That fingerprint is written to `.env-orbit`, and that build is what runs, so
an update can't swap in something different behind your back. Everything
needed to run Orbit, including its configuration files and operator scripts,
is packed inside the same build. The files always match the version they came
with, and the installer never downloads them separately. A version name like
`preview` is only used to look up which build it points to today; what gets
installed is always the fingerprint, never the name.

It then creates or re-checks `.env-orbit`, generates three separate random
secrets (for sign-in sessions, the database password and document
encryption), checks the Compose configuration, and fetches the images for the
services you chose. It reports success only once the database is healthy,
Orbit's own health check at `/api/health` says ready, the malware scanner is
healthy, and each optional service you chose answers its check.

Development and routine preview builds are made for 64-bit x86
(`linux/amd64`) so they build faster. ARM64 builds are added only once they
can be tested the same exact-image way.

If you cancel during the prompts, or an unattended run finds a setting that
needs attention, the installer puts the managed files back as they were and
prints only the names of the fields and what to do next. From a terminal,
rerun the installer. From a checked-out deployment you can also fix the
settings directly:

```sh
bash scripts/configure.sh --init
bash scripts/configure.sh --set-oidc-secret
bash scripts/configure.sh --check
```

### Building from source instead

Building is a developer task, not an install option, so the installer does
not offer it. Clone the repository and build:

```bash
git clone https://github.com/tomlawesome/orbit.git && cd orbit
bash scripts/configure.sh
bash scripts/build-container.sh
```

Generated secrets live in `.orbit-secrets`, readable only by the user who ran
the script. Compose gives each container only the secret files it needs, under
`/run/secrets`; secret values never go into container environment variables.
Later runs keep existing secrets, and the scripts never read or write a
generic `.env` file.
