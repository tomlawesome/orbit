# Upgrades and backups

How to update Orbit, how to back it up, and how to go back if an update goes
wrong. Run every command on this page from the deployment directory, the one
you installed into.

The short version: back up, check the backup, update, and check that Orbit
is healthy and you can sign in. Keep the backup until you are sure.

## Back up

```sh
bash scripts/backup.sh
```

This makes one file in `backups/`, named like `orbit-YYYYMMDD-HHMMSS.tar`, and
prints `Orbit backup created:` followed by its path. The file holds a copy of
the database and an encrypted copy of the stored documents.

- Orbit is stopped while the backup runs, so the copy is of one moment in time,
  and is started again afterwards.
- To keep backups somewhere else, set `ORBIT_BACKUP_DIR` to that directory
  when you run the script. If you set it, set it the same way for every
  backup, restore, `--recover` and `--finish`: a restore keeps its recovery
  record in that directory.
- The scripts read the settings in `.env-orbit`. If yours are in another
  file, set `ORBIT_ENV_FILE` to it when you run the script, the same way for
  every backup and restore.
- The host needs Docker with Compose v2. Orbit's document key file,
  `.orbit-secrets/document-kek`, must be in place.
- A backup does not hold your settings (`.env-orbit`) or your secrets.

Check a backup at any time with:

```sh
bash scripts/backup.sh --verify backups/orbit-YYYYMMDD-HHMMSS.tar
```

This reads the file and changes nothing, and Orbit keeps running.

### A backup needs the document key

A backup is tied to the document encryption key it was made with, so it is
only useful on a machine that still has that key. To be able to recover after
losing the machine, also export a recovery bundle, protected by a passphrase,
and keep it somewhere else. See
[Exporting a recovery bundle](administrator-operations.md#exporting-a-recovery-bundle).

Backups, restores and updates are refused while a document key rotation is
open. See
[Rotating the document key-encryption key](administrator-operations.md#rotating-the-document-key-encryption-key).

## Update

1. Back up, and check the backup, as above.
2. Keep a copy of your settings next to it, in the same directory as the
   backup (`backups`, or your `ORBIT_BACKUP_DIR`). The copy records exactly
   which build was running, so you can go back to it:
   ```sh
   umask 077
   mkdir -p backups
   cp .env-orbit backups/orbit-pre-upgrade.env
   ```
3. Run `./update.sh` in the deployment directory, and choose **Update**:
   ```sh
   ./update.sh
   ```
   It first updates itself from its fixed address on GitHub, then runs the
   current installer for that directory, with the same checks as the
   install line in [Installing Orbit](installing.md#install). If it cannot
   download its newest copy, it says so and stops without running anything;
   run it again once the network is back. A
   deployment installed before `update.sh` was shipped does not have it:
   run that install line in the deployment directory instead, once.

If it stops part-way, run the update again; see
[If an update stops](installing.md#if-an-update-stops).

Afterwards, open Orbit, check `/api/health`, and sign in. Keep using
`docker compose --env-file .env-orbit` from the deployment directory, with no
`--project-name`, so every command finds the same containers and data.

### Update from no more than three releases back

An install can update directly only from the last three stable releases
before the one you are installing; retracted releases do not count. From
further back, the installer stops before it pulls or changes anything and
names the release to update to first, for example `This install is on v0.3.1.
Update to v0.3.4 first, then to v0.3.6.`

To step through, install the release it names (pin it with its version tag,
for example `ORBIT_VERSION=v0.3.4 ./update.sh`), check `/api/health`, then run the update
again for the next release. Each stop repeats the check, so a long way back
takes a few steps. An install whose `.env-orbit` records an applied
digest (`ORBIT_CONFIG_APPLIED_DIGEST`) but no `ORBIT_CONFIG_APPLIED_VERSION`, or
is on a version that is not a stable release, is refused with a line saying so
(an env file with neither is a fresh install); run
`bash scripts/repair.sh --check` first.

This rule is for stable installs. A preview install (`ORBIT_CHANNEL=preview`,
with a preview manifest) can update from any earlier version, and never to
an older one ([Installing a preview build](installing-preview.md)).

## Go back after a failed update

If Orbit has started on the new build but the database update or sign-in then
fails, stop it and restore both the backup and the saved settings:

```sh
docker compose --env-file .env-orbit stop orbit-app
cp backups/orbit-pre-upgrade.env .env-orbit
chmod 600 .env-orbit
docker compose --env-file .env-orbit pull orbit-app
bash scripts/restore.sh backups/orbit-YYYYMMDD-HHMMSS.tar
```

Use the backup you made in step 1 of the update. The saved `.env-orbit`
names the previous build exactly, so do not swap in a version name or edit
only `ORBIT_IMAGE`. Type `RESTORE` when it asks. Then check `/api/health`,
check that you can sign in on the previous build, and only then delete the
saved copy:

```sh
rm -f backups/orbit-pre-upgrade.env
```

[Installer guarantees](installer-guarantees.md#before-and-after-an-upgrade)
lists exactly what the installer promises around an upgrade.

## Restore

```sh
bash scripts/restore.sh backups/orbit-YYYYMMDD-HHMMSS.tar
```

The restore checks the backup, stops Orbit, checks the backup again, and asks
you to type `RESTORE`. If you do not, Orbit starts again unchanged. Once you
do, it takes a recovery checkpoint, replaces the database and the stored
documents with the ones in the backup, starts Orbit and waits for it to answer.

On a new machine, or any machine without the original document key, first put
the key back from your recovery bundle: see
[Restoring the document key-encryption key](administrator-operations.md#restoring-the-document-key-encryption-key).
Then run the restore.

If a restore is interrupted part-way, or Orbit is not healthy afterwards,
Orbit stays stopped and `bash scripts/restore.sh --recover` puts the previous
state back. If Orbit is running the restored data but the restore says it could
not finish, run `bash scripts/restore.sh --finish`. Until a restore is finished
or recovered, new backups and restores are refused.

- Both scripts run Orbit's engine inside the deployment, so the host needs
  Docker with Compose v2. Restore also needs `curl`, to wait for Orbit to
  answer; backup does not.

An unattended restore skips the typed `RESTORE` only when given both
switches, so that neither alone can replace your data:

```sh
ORBIT_NONINTERACTIVE_RESTORE=true bash scripts/restore.sh --yes backups/orbit-YYYYMMDD-HHMMSS.tar
```

`--yes` without the variable stops before Orbit is touched.
