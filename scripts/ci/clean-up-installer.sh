#!/usr/bin/env bash
#
# Removes everything the installer evidence created: the deployment it stood
# up, the target directory, the git guard, the captured refusal output and the
# disposable registry. Every removal is guarded by the path prefix it was
# created under and, for the registry, by the container identity recorded when
# it started -- so a half-run, or a stale name belonging to something else, is
# never what gets deleted.
#
# Extracted verbatim from the "Clean up installer validation resources" step
# of the &container_validation_steps anchor in
# .github/workflows/publish-container.yml (#801). Runs unconditionally, so it
# must never itself be the reason a run is red.
#
# Inputs (environment): REGISTRY_NAME, REGISTRY_ID, INSTALL_TARGET,
# GIT_GUARD_DIR, REFUSAL_OUTPUT -- each optional, and each ignored unless it
# matches what this run created. RUNNER_TEMP defaults to $TMPDIR or /tmp.
set -Eeuo pipefail

runner_temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
readonly runner_temp

if [[ -n "${INSTALL_TARGET:-}" && "${INSTALL_TARGET}" == "${runner_temp}"/orbit-installer-target.* && -d "${INSTALL_TARGET}" && ! -L "${INSTALL_TARGET}" ]]; then
  if [[ -f "${INSTALL_TARGET}/docker-compose.yml" && -f "${INSTALL_TARGET}/.env-orbit" ]]; then
    (cd "${INSTALL_TARGET}" && docker compose --env-file .env-orbit -f docker-compose.yml down --volumes --remove-orphans) || true
  fi
  rm -rf -- "${INSTALL_TARGET}"
fi

if [[ -n "${GIT_GUARD_DIR:-}" && "${GIT_GUARD_DIR}" == "${runner_temp}"/orbit-installer-git-guard.* && -d "${GIT_GUARD_DIR}" && ! -L "${GIT_GUARD_DIR}" ]]; then
  rm -rf -- "${GIT_GUARD_DIR}"
fi

if [[ -n "${REFUSAL_OUTPUT:-}" && "${REFUSAL_OUTPUT}" == "${runner_temp}"/orbit-installer-refusal-* ]]; then
  rm -f -- "${REFUSAL_OUTPUT}"
fi

if [[ -n "${REGISTRY_NAME:-}" && "${REGISTRY_ID:-}" =~ ^[0-9a-f]{64}$ ]]; then
  current_registry_id="$(docker inspect --format '{{.Id}}' "${REGISTRY_NAME}" 2> /dev/null || true)"
  if [[ "${current_registry_id}" == "${REGISTRY_ID}" ]]; then
    docker rm --force "${REGISTRY_ID}" > /dev/null 2>&1 || true
  fi
fi
