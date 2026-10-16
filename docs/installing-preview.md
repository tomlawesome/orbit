# Installing a preview build

How to install a **preview** build of Orbit on your own machine, to try it
before it becomes a stable release (release acceptance, #1153). For a stable
release, use [Installing Orbit](installing.md) instead: its one-line
installer does every check below for you, but it refuses previews.

A preview is the build CI publishes when `dev` is merged into `preview`. Its
identity is its **digest**, a fingerprint that names one build and nothing
else; the `:preview` tag only points at the newest one. Everything here
installs by digest, so you get exactly the build that was tested.

Why it takes more steps than a stable install: a stable release publishes its
signed file list (the **release manifest**) on GitHub, where the one-line
installer fetches and checks it. A preview's manifest is kept only on GitLab,
which is private, so you fetch it yourself and check its signature by hand.
After that, the installer is the same one a stable install runs.

## What you need

Everything in [Installing Orbit, "What you need"](installing.md#what-you-need):
a Linux amd64 machine with Docker and Compose v2, `curl`, `openssl`, `tar`,
`sha256sum` and `base64`, an HTTPS address behind a reverse proxy (with its
upload limit raised), and about 4 GiB of free memory for the malware scanner.

Also, for this guide:

- a GitLab login that can open `ai/orbit`'s pipelines, used in your browser
  only, to download two files;
- the preview's **commit** and **pipeline** — the #1152 note recording the
  preview digest names both, with direct links to the two files;
- if people will sign in through your own identity provider: its address
  (the issuer), a client ID and secret made for Orbit, with the callback
  address set to `https://<YOUR ORBIT ADDRESS>/api/auth/callback`;
- if Orbit should send email: your mail server's address, port, login and
  password.

## 1. Download the release manifest and its signature

On GitLab, open the preview's pipeline and download two files, using the
links on #1152:

- from the `record_image` job: `orbit-release-manifest.json`, the list of
  what makes up this build, including its image digest;
- from the `sign_evidence` job: `orbit-release-manifest.json.sig`, the
  signature over that list.

On a job's page, **Browse** under "Job artifacts", then open
`.orbit-supply-chain/` and download the file. Copy both files onto the
machine you are installing on, into one new, empty working directory, for
example `~/orbit-preview-check/`. The rest of this guide runs there unless
it says otherwise.

## 2. Check the signature

This proves the manifest was signed by Orbit's release key and not changed
since. Fetch the public key from the public GitHub mirror, at the preview's
commit:

```sh
cd ~/orbit-preview-check
curl -fsSLo cosign.pub https://raw.githubusercontent.com/tomlawesome/orbit/<COMMIT>/cosign.pub
sha256sum cosign.pub
```

The printed fingerprint must be exactly:

```text
da34c73e75a8a6f94bf8a6505452be2f3109a630da8ee43fae9ef0185874b074
```

If it is anything else, stop: that is not Orbit's key. This value is also
the key built into `get-orbit.sh`, so it does not depend on trusting the
download.

Then check the manifest against it. The signature file is base64 text, which
`openssl` needs turned back into bytes first:

```sh
base64 -d < orbit-release-manifest.json.sig > manifest.sig.der
openssl dgst -sha256 -verify cosign.pub -signature manifest.sig.der orbit-release-manifest.json
```

It must print `Verified OK`. Anything else means the files do not match:
download them again, and stop if it still fails.

## 3. Check what the manifest names

```sh
grep -E '"(version|channel|commit|digest|install.sh)"' orbit-release-manifest.json
```

Check that `channel` is `preview`, the first `commit` is the preview's
commit, and `digest` is the digest recorded on #1152. Those three tie the
signed file to the build that was tested. (The second `commit` line is the
launcher's, and can be ignored here.)

## 4. Download the installer and check it

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/tomlawesome/orbit/<COMMIT>/scripts/install.sh
sha256sum install.sh
```

The printed value must equal the one after `"install.sh": "sha256:` in the
manifest. That proves this is the installer the signed manifest lists.

## 5. Install

The installer installs into the directory you run it from, which must be
empty. Make one beside the working directory and run it from there, handing
it the checked manifest:

```sh
mkdir ~/orbit && cd ~/orbit
ORBIT_CHANNEL=preview ORBIT_RELEASE_MANIFEST="$HOME/orbit-preview-check/orbit-release-manifest.json" \
  bash ~/orbit-preview-check/install.sh
```

- `ORBIT_CHANNEL=preview` tells it this is a preview. Previews never carry
  the second, stable-only signature, so without it an installed `cosign`
  would refuse the build.
- `ORBIT_RELEASE_MANIFEST` hands it the manifest you checked. It installs
  only the digest named there, and confirms the registry returned exactly
  that build. **It does not check the signature itself**: steps 2 to 4 are
  that check, so do not skip them.

From here it is the normal installer: choose **Install**, then the profile and
how people sign in, as in
[What the installer asks](installing.md#what-the-installer-asks). It may
print "no countersignature yet … continuing with the release-manifest check
only": that is expected for a preview.

The last screen shows Orbit's address, the version and the exact build.
Check the build matches the digest on #1152.

## 6. Claim it

The link that creates the first administrator is the last line of the Orbit
container's log:

```sh
cd ~/orbit
docker compose --env-file .env-orbit logs orbit-app | tail -n 1
```

Open it in your browser. [Claiming a fresh install](authentication.md#claiming-a-fresh-install)
has the detail. Then export a recovery bundle
([how](administrator-operations.md#exporting-a-recovery-bundle)).

## 7. Email (optional)

Outgoing mail (reminders) is set in `.env-orbit`, with the password kept in
a private file; incoming mail is set later in Administration. Follow
[Configuration](administrator-operations.md#configuration) (the SMTP
settings) and [Mailbox provider operation](administrator-operations.md#mailbox-provider-operation):
put the password in `.orbit-secrets/smtp-password` (readable only by you)
with an editor, not on a command line, set the `SMTP_*` lines, and start
Orbit with the mail overlay so it can read the password file.

## Removing it afterwards

From `~/orbit`, `docker compose --env-file .env-orbit down --volumes`
removes the containers **and all of Orbit's data**. Only do this to a test
install.
