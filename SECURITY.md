# Orbit security policy

Orbit stores private household data and documents, so security and privacy
reports are taken seriously. Thank you for reporting vulnerabilities
responsibly and allowing time for investigation and remediation.

## Supported versions

Orbit has not yet published a stable v1 release. Until then, security fixes are
made on the active release line and included in subsequent preview builds.
Preview, development, and release-candidate images are evaluation artifacts,
not supported stable releases.

After v1, the latest stable release will receive security fixes. An older
release is supported only when the release notes explicitly designate it as a
supported maintenance line.

| Release | Security support |
| --- | --- |
| Active pre-v1 release line | Fixes are developed and validated here |
| Preview/development images | Evaluation only; reports are welcome |
| Older commits and superseded images | Not supported |

Users should deploy published images by immutable digest and keep their
database, secrets, document storage, and recovery material backed up before
updating.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/tomlawesome/orbit/security/advisories/new).
Do not open a public issue, discussion, or pull request containing vulnerability
details before coordinated disclosure.

Please include, where available:

- the affected Orbit version, image digest, or commit;
- deployment details relevant to the issue, with secrets removed;
- clear reproduction steps or a minimal proof of concept;
- the security or privacy impact and required attacker access;
- whether the issue has been observed in a real deployment;
- any suggested mitigation or remediation.

Never include credentials, session material, private keys, recovery codes,
personal documents, real household data, or unredacted logs. Use synthetic test
data and the private advisory attachment facility.

## What to expect

- A report should be acknowledged within three business days.
- An initial assessment should normally follow within seven business days.
- For an accepted report, maintainers will provide status updates at least
  every 14 days while remediation is in progress.
- Fix timing depends on severity, exploitability, affected versions, and the
  safety of the remediation. These targets are response goals, not a guarantee
  of resolution by a particular date.

The maintainers may ask for additional information, coordinate a fix and
release, and publish a GitHub security advisory. Please keep the report private
until an advisory is published or a disclosure date is agreed. A 90-day
coordination window is a useful default, but active exploitation or immediate
user risk may require an accelerated response.

Orbit does not currently operate a paid bug-bounty programme.

## Scope

Examples of useful reports include:

- authentication, session, CSRF, or authorization bypass;
- cross-user or cross-household data exposure;
- unsafe document, mailbox, parser, scanner, or archive handling;
- encryption, key-management, secret-handling, backup, or restore failures;
- injection, path traversal, server-side request forgery, or remote code
  execution;
- container, deployment, dependency, or CI weaknesses that are exploitable in
  Orbit's supported configuration;
- logging, diagnostics, browser storage, caching, or error handling that leaks
  private data.

For a vulnerability solely in an upstream dependency, report it to that
project first. Report it privately to Orbit as well when Orbit's use makes the
issue exploitable or requires an Orbit-specific mitigation.

Ordinary defects, feature requests, and hardening suggestions without a
security impact belong in the public
[issue tracker](https://github.com/tomlawesome/orbit/issues).

## Responsible research

Good-faith research must:

- use systems and data you own or have explicit permission to test;
- avoid privacy violations, service disruption, destructive actions, and
  persistence beyond what is needed to demonstrate impact;
- stop and report immediately if private data belonging to another person is
  encountered;
- avoid social engineering, denial-of-service traffic, credential attacks, and
  automated scanning of systems you do not control;
- delete locally retained sensitive test material after the report is
  resolved.

Maintainers will not pursue action against good-faith research that follows
this policy. This statement does not authorize testing against third-party
services or data and cannot bind parties other than the Orbit maintainers.
