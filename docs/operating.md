# Running Orbit

How to configure, start, update and back up an Orbit deployment. Every
`.env-orbit` setting is listed in [Configuration](administrator-operations.md#configuration)
on the administrator operations page.

## Run with Docker

### 1. Create the runtime configuration

```sh
bash scripts/configure.sh
bash scripts/configure.sh --init
bash scripts/configure.sh --set-oidc-secret
bash scripts/configure.sh --check
```

`bash scripts/configure.sh` on its own creates `.env-orbit` and the private
`.orbit-secrets` directory without starting any containers. It runs the Orbit
image once, only to generate the key pair used for browser push
notifications: the private key goes in `.orbit-secrets`, the public key in
`.env-orbit`. If the files already exist it leaves them alone. Unattended
installs and upgrades rely on this: the installer carries on only when the
existing configuration and secret file are already complete and safe.

`--init` asks whether people will sign in with local accounts only (the
default, `ORBIT_AUTH_OIDC=false`) or also through an identity provider. Only if
you answer "also" does it ask for Orbit's public HTTPS address, the provider's
issuer URL and the client ID, and it works out the callback URL itself. It
never asks for, or invents, the provider's client secret.

`--set-oidc-secret` reads that secret without showing it, stores it in
`.orbit-secrets`, and records only the file's path in `.env-orbit`. See
[authentication setup](authentication.md).

`--check` reports whether every required setting and each optional group is
complete. It prints setting names and their state, never values.

After Orbit starts, claim it to create the first administrator: see
[Claiming a fresh install](authentication.md#claiming-a-fresh-install).

### 2. Start Orbit

From a checkout, build the image and start the stack with the same guarded
script CI uses:

```sh
bash scripts/deploy-container.sh --build
```

It builds through the `compose/docker-compose.build.yml` overlay. The base
Compose file describes a deployment, which has a published image and no source
tree, so the build instructions live in the overlay. If you drive Compose by
hand, `scripts/build-container.sh` shows the three build variables
(`ORBIT_VERSION`, `ORBIT_REVISION`, `ORBIT_CHANNEL`) the overlay requires.

Open the address in `APP_URL`. For a real deployment that is an HTTPS
address, and your reverse proxy must send it to Orbit's published port. Plain
HTTP works only on the Docker host itself, at
[http://127.0.0.1:3000](http://127.0.0.1:3000). The health check is at
`/api/health`.

By default Orbit listens on every network interface of the host. Set
`ORBIT_BIND_ADDRESS=127.0.0.1` in `.env-orbit` when only the host itself, or a
reverse proxy running on it, should reach Orbit. Never open port `3000`
directly to the internet.

On start, Orbit waits for the database, applies any pending database
migrations (schema updates), starts the notification scheduler, then serves
the application.

### Before and after an upgrade

The backup-first upgrade procedure, and how to go back if an upgrade fails,
is [Before and after an upgrade](installer-guarantees.md#before-and-after-an-upgrade)
in the installer guarantees, beside the scripts it uses.

### Optional local processing stack

The standard stack already scans every upload for malware. Two further
services are optional, because they need a lot of host memory and normal use
does not need them: Tika, which extracts text from documents (including OCR
for scanned pages), and Ollama, which runs an AI model locally. Current Orbit
releases use Tika only to show bounded review evidence. They never send
document text to Ollama and never let it create or change household data.

To turn both on, add these lines to `.env-orbit`:

```sh
TIKA_URL=http://orbit-tika:9998
# Choose a local model only after checking its size, licence and host capacity.
OLLAMA_MODEL=<a-local-model-name>
COMPOSE_PROFILES=processing,ai
```

Then start Orbit with the usual command:

```sh
docker compose --env-file .env-orbit up -d
```

The choice lives in `.env-orbit`, not in the command, so turning a service on
or off later is a one-line edit. Leave `COMPOSE_PROFILES` empty for the
standard stack, which runs neither.

Neither service has a port on the host. Both sit on a private network shared
only with Orbit and the virus scanner. From there they cannot reach the
database or the internet. Ollama keeps its models in a local volume, never uses cloud
models, and is limited to 2 CPUs and 6 GiB of memory by default.

Because Ollama cannot reach the internet, it cannot download a model. Set
`OLLAMA_MODEL` first, then run the one-off pull helper, which downloads into
the model volume and exits:

```sh
docker compose --env-file .env-orbit --profile ai-model-pull \
  run --rm orbit-ollama-model-pull
```

Full details, including hosts with no internet access, are in
[Private model server and its model pull](administrator-operations.md#private-model-server-and-its-model-pull).

To stop and remove the optional containers, run the same Compose command with
`down` instead of `up -d`. Leave out `--volumes` to keep downloaded models.

> [!IMPORTANT]
> Use one address everywhere: `APP_URL`, the address in the browser, and the
> callback address registered with the identity provider. Do not switch
> between `localhost` and `127.0.0.1` part-way through a sign-in.

Nobody sees a household without signing in. A new Orbit stays unclaimed until
someone opens the claim link printed in the container's start-up log (see
[Claiming a fresh install](authentication.md#claiming-a-fresh-install)).
That person becomes the first instance administrator and is walked through
setup: household name, timezone, currency and sections. Home, Vehicles,
Devices and Services are offered as defaults, or you can give your own list.

![The first-run setup wizard asking for a name, time zone and currency, and admitting to the four default sections](images/first-run-sections-step.png)

Instance administrators can manage every household and can grant or remove
administrator access for other users. Orbit will not let the last
administrator be removed.

### Update and launch an existing checkout

Once `.env-orbit` exists, update and start Orbit from a checkout with:

```sh
./scripts/update-and-start.sh
```

It pulls the latest source (fast-forward only), pulls the PostgreSQL and
ClamAV images, rebuilds the Orbit image, starts the stack in the background
and prints the service status. It stops at once if Git, Docker Compose v2 or
`.env-orbit` is missing.
## Backups

Create a checked backup of the PostgreSQL database and an encrypted archive
of the document volume:

```sh
bash scripts/backup.sh
```

The ordinary backup deliberately leaves out the document key, so it is only
useful together with the key on this host. Restore it while Orbit is stopped;
the restore either completes fully or changes nothing:

```sh
bash scripts/restore.sh backups/orbit-YYYYMMDD-HHMMSS.tar
```

When the backup must survive losing the host, create a recovery bundle
protected by a passphrase and store it elsewhere:

```sh
bash scripts/export-recovery-bundle.sh backups/orbit-YYYYMMDD-HHMMSS.tar
bash scripts/import-recovery-bundle.sh backups/orbit-recovery-YYYYMMDD-HHMMSS.tar
```

The bundle is sealed with strong, tamper-evident encryption (AES-256-GCM,
with the key derived from the passphrase by scrypt). Neither the document key
nor the passphrase is ever printed, put in an environment variable or passed
on a command line.

## Build or deploy

Build or deploy the Compose application through the same guarded scripts CI
uses:

```sh
bash scripts/build-container.sh
bash scripts/deploy-container.sh --pull
# Or build locally before deployment:
bash scripts/deploy-container.sh --build
```

See [Authentication and Authentik setup](authentication.md) for provider
configuration, endpoint behaviour, security details, and troubleshooting.
See [Gitflow previews and stable promotion](releasing.md) for
the protected branch, test, manual-validation, and digest-promotion workflow.

## Before the first real launch

1. Apply the migrations to a disposable PostgreSQL instance and exercise OIDC
   sign-in with the intended provider.
2. Verify one SMTP delivery and one browser-push delivery with production-like
   credentials.
3. Run the browser and accessibility checks against the production build.
4. Schedule `scripts/backup.sh`, retain copies outside the Docker host, and
   perform a test restore.
5. Read [Encryption at rest](encryption-at-rest.md) and decide whether
   the host disk needs encryption before going live — Orbit does not decide
   this for you.

