// O2-R4 (#1151): `docker run -d` always exits right after it either starts
// the container or fails to -- it is never the long-lived process (Tika
// inside the container is). findTika() in cli.ts used to launch it and go
// straight to polling Tika's HTTP endpoint for up to two minutes regardless,
// so a `docker run` failure -- for instance a container named
// orbit-extract-tika already running from an interrupted earlier attempt --
// surfaced as the misleading "Tika never answered on port 9998" only after
// the full wait, with the real reason already printed and scrolled past on
// stderr. Checking this exit code turns that into an immediate, specific
// error instead.
export function dockerRunFailure(exitCode) {
  if (exitCode === 0) return undefined;
  return `docker run exited with code ${exitCode} before Tika could start (see the error above)`;
}
