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
  when you run the script. Set it the same way when you restore.
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
2. Keep a copy of your settings next to it. The copy records exactly which
   build was running, so you can go back to it:
   ```sh
   cp .env-orbit backups/orbit-pre-upgrade.env
   chmod 600 backups/orbit-pre-upgrade.env
   ```
3. Run the install line from [Installing Orbit](installing.md#install) again,
   in the deployment directory, and choose **Update**.

If it stops part-way, run the update again; see
[If an update stops](installing.md#if-an-update-stops).

Afterwards, open Orbit, check `/api/health`, and sign in. Keep using
`docker compose --env-file .env-orbit` from the deployment directory, with no
`--project-name`, so every command finds the same containers and data.

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

The restore asks you to type `RESTORE`, then stops Orbit, replaces the database
and the stored documents with the ones in the backup, starts Orbit again and
waits for it to answer. Before it replaces anything it takes a recovery
checkpoint.

If a restore is interrupted part-way, or Orbit is not healthy afterwards,
Orbit stays stopped and `bash scripts/restore.sh --recover` puts the previous
state back.

- Both scripts run Orbit's engine inside the deployment, so the host needs
  Docker with Compose v2. Restore also needs `curl`, to wait for Orbit to
  answer; backup does not.
- A backup made with `ORBIT_BACKUP_DIR` is restored with the same setting.

An unattended restore skips the typed `RESTORE` only when given both
switches, so that neither alone can replace your data:

```sh
ORBIT_NONINTERACTIVE_RESTORE=true bash scripts/restore.sh --yes backups/orbit-YYYYMMDD-HHMMSS.tar
```

`--yes` without the variable stops before Orbit is touched.
