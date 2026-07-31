# Orbit security policy

Orbit stores private household data and documents. Security and privacy reports
are taken seriously, and reporters should allow time for coordinated
investigation and remediation.

## Supported versions

Orbit has not yet published a stable v1 release. Until then, fixes are developed
on the active development line and included in subsequent immutable preview
images. Development and versioned-release previews are evaluation artifacts,
not supported stable releases.

After v1, the latest stable release receives security fixes. An older release
is supported only when its release notes explicitly designate a maintenance
line.

| Release | Security support |
| --- | --- |
| Active pre-v1 development and versioned-release lines | Fixes are developed and validated here |
| Preview images | Evaluation only; reports are welcome |
| Latest stable release after v1 | Supported |
| Older commits and superseded images | Unsupported unless release notes say otherwise |

Deploy published images by immutable digest. Back up the database, encrypted
document storage, secrets and separate recovery material before updating.

## Report a vulnerability privately

Use
[GitHub private vulnerability reporting](https://github.com/tomlawesome/orbit/security/advisories/new).
Do not open a public issue, discussion or pull request containing vulnerability
details before coordinated disclosure.

Include, where available:

- the affected Orbit version, image digest or commit;
- relevant deployment details with all sensitive values removed;
- clear reproduction steps or a minimal proof of concept;
- the security or privacy impact and required attacker access;
- whether the issue has been observed in a real deployment; and
- any suggested mitigation.

Never include credentials, tokens, session material, private keys, recovery
codes, personal documents, real household data or unredacted logs. Use
synthetic data and the private advisory attachment facility.

## What to expect

- Reports should be acknowledged within three business days.
- An initial assessment should normally follow within seven business days.
- Accepted reports should receive a status update at least every 14 days while
  remediation remains active.
- Fix timing depends on severity, exploitability, affected versions and the
  safety of the remediation.

The maintainers may request more information, coordinate a fix and release, and
publish a GitHub security advisory. Keep the report private until an advisory
is published or a disclosure date is agreed. A 90-day coordination window is a
useful default, while active exploitation or immediate user risk may require
faster disclosure.

Orbit does not currently operate a paid bug-bounty programme.

## Scope

Useful reports include:

- authentication, session, CSRF or authorization bypass;
- cross-user or cross-household data exposure;
- unsafe document, mailbox, parser, scanner or archive handling;
- encryption, key-management, secret-handling, backup or restore failures;
- injection, path traversal, server-side request forgery or remote code
  execution;
- exploitable container, deployment, dependency or CI weaknesses; and
- logging, diagnostics, browser storage, caching or error handling that leaks
  private data.

For a vulnerability solely in an upstream dependency, report it to that project
first. Also report it privately to Orbit when Orbit's use makes the issue
exploitable or requires an Orbit-specific mitigation.

Ordinary defects, feature requests and non-sensitive hardening suggestions
belong in the public
[issue tracker](https://github.com/tomlawesome/orbit/issues).

## Responsible research

Good-faith research must:

- use systems and data the reporter owns or has explicit permission to test;
- avoid privacy violations, service disruption, destructive actions and
  unnecessary persistence;
- stop and report immediately if another person's private data is encountered;
- avoid social engineering, denial-of-service traffic, credential attacks and
  automated scanning of systems the reporter does not control; and
- delete retained sensitive test material after the report is resolved.

Maintainers will not pursue action against good-faith research that follows
this policy. This statement does not authorize testing against third-party
services or data and cannot bind parties other than the Orbit maintainers.
