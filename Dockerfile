FROM node:22-alpine@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c AS base

# Alpine patches its OpenSSL packages faster than the Node official images are
# rebuilt, so a digest-pinned base is routinely a few package revisions behind
# its own Alpine release. That is not hypothetical: the pin above carries
# libcrypto3/libssl3 3.5.7-r0 while Alpine 3.24 has shipped 3.5.8-r0, which
# fixes CVE-2026-14456, and no node:22/24/26-alpine build carries the fix yet
# (#646). Upgrading from the pinned base's own Alpine branch closes that gap at
# build time instead of waiting on an upstream rebuild. The digest still fixes
# what this image starts from; this line only moves its packages forward to the
# current patch level of that same Alpine release.
RUN apk upgrade --no-cache

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /opt/orbit

FROM base AS vapid-generator
COPY scripts/generate-vapid.mjs ./scripts/generate-vapid.mjs
ENTRYPOINT ["node", "/opt/orbit/scripts/generate-vapid.mjs"]

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
# web/ is a workspace member (#419): one root lockfile covers both packages,
# so the frozen install below materialises web/node_modules too.
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /opt/orbit/node_modules ./node_modules
COPY . .
RUN pnpm build

# Bundles the orbit engine CLI (src/cli/orbit.ts) into a single, dependency-
# free CommonJS file (issue #295 engine-delivery slice, owner decision
# 2026-08-13: the engine ships INSIDE the app image, invoked by host scripts
# as a disposable `docker compose run --rm --no-deps` one-off — never handed
# the Docker socket, never requiring Node on the host). Built in its own
# stage off `deps` (not `builder`) since it needs neither the Next.js build
# nor its output — esbuild does not type-check, and `npx tsc --noEmit`
# already gates this file in CI. See scripts/bundle-orbit-cli.mjs for the
# deterministic flag set and docs/engine-events.md, "In-container engine
# invocation", for the resulting artifact's invocation contract.
# Builds the v19 front end (web/, SvelteKit + adapter-node) into its
# self-contained server output (#449). Its own stage off `deps`, like
# cli-builder: it needs neither the Next.js build nor its output. The
# adapter externalises whatever web/package.json lists under `dependencies`,
# which is why web/ keeps everything in devDependencies — the output below
# must import only node: builtins, because the runner copies it WITHOUT any
# node_modules. Nothing serves this output until the composite entry lands
# (#411 step 2); in this image it is carried, inert.
FROM base AS web-builder
COPY --from=deps /opt/orbit/node_modules ./node_modules
COPY --from=deps /opt/orbit/web/node_modules ./web/node_modules
COPY . .
RUN pnpm --filter orbit-web build

FROM base AS cli-builder
COPY --from=deps /opt/orbit/node_modules ./node_modules
COPY . .
RUN pnpm run build:cli

FROM node:22-alpine@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c AS runner

# The runtime stage starts from the base image again rather than from `base`,
# so it needs the same package upgrade for the same reason (see the base stage).
RUN apk upgrade --no-cache

ARG ORBIT_VERSION
ARG ORBIT_REVISION
ARG ORBIT_CHANNEL

# Release metadata is validated here, immediately after the ARGs, rather than
# beside the files it writes 50 steps later (#435). Nothing between depends on
# these values, so validating late meant a malformed version failed only after
# the whole application build had been done and thrown away. Only this one
# small file is copied to check it — the rest of the source tree (COPY . .,
# below in the other build stages) is untouched until this passes.
#
# The three patterns are the same ones scripts/build-container.sh checks
# before invoking Docker at all; both source scripts/release-metadata-
# patterns.sh rather than each holding its own copy, so a builder that
# bypasses the script still gets an identical guarantee, and the two checks
# cannot drift apart (#435).
COPY scripts/release-metadata-patterns.sh /opt/orbit/scripts/release-metadata-patterns.sh
RUN . /opt/orbit/scripts/release-metadata-patterns.sh \
  && printf '%s\n' "${ORBIT_VERSION}" | grep -Eq "$ORBIT_VERSION_PATTERN" \
  && printf '%s\n' "${ORBIT_REVISION}" | grep -Eq "$ORBIT_REVISION_PATTERN" \
  && printf '%s\n' "${ORBIT_CHANNEL}" | grep -Eq "$ORBIT_CHANNEL_PATTERN"
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV MIGRATE_ON_START=true
ENV WORKER_ENABLED=true
# Baked into the image config itself, so it is present in every container
# started from this image regardless of --entrypoint/--user overrides —
# unlike CMD/ENTRYPOINT, ENV is not replaced by `docker compose run
# --entrypoint`. This is the one fact src/cli/orbit.ts's in-container
# fail-closed guard (refuseDockerInContainer) trusts to refuse any command
# whose adapters would spawn `docker` before that spawn is ever attempted.
# See docs/engine-events.md, "In-container engine invocation".
ENV ORBIT_ENGINE_CONTEXT=container
LABEL org.opencontainers.image.title="Orbit"
LABEL org.opencontainers.image.description="Everything in your orbit, on track."
LABEL org.opencontainers.image.source="https://github.com/tomlawesome/orbit"
LABEL org.opencontainers.image.version="${ORBIT_VERSION}"
LABEL org.opencontainers.image.revision="${ORBIT_REVISION}"
LABEL io.github.tomlawesome.orbit.release-stage="${ORBIT_CHANNEL}"
WORKDIR /opt/orbit
# Seed the mount point with the runtime user's ownership so a new named volume
# is writable when Docker copies the image directory into it on first use.
RUN apk add --no-cache su-exec \
  && rm -rf /usr/local/lib/node_modules /opt/yarn-v* \
  && rm -f \
    /usr/local/bin/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/pnpm \
    /usr/local/bin/pnpx \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg \
  && addgroup --system --gid 1001 orbit \
  && adduser --system --uid 1001 --ingroup orbit orbit \
  && mkdir -p /var/lib/orbit/documents \
  && chown orbit:orbit /var/lib/orbit /var/lib/orbit/documents \
  && chmod 0750 /var/lib/orbit /var/lib/orbit/documents
COPY --from=builder --chown=orbit:orbit /opt/orbit/public ./public
COPY --from=builder --chown=orbit:orbit /opt/orbit/.next/standalone ./
COPY --from=builder --chown=orbit:orbit /opt/orbit/.next/static ./.next/static
COPY --from=builder --chown=orbit:orbit /opt/orbit/drizzle ./drizzle
# The v19 front end's server output (#449): index.js + handler.js + client/.
# Self-contained (node: builtins only — asserted by the closure evidence's
# bare-import scan), so no web node_modules is copied. Inert until #411's
# composite entry dispatches to it.
COPY --from=web-builder --chown=orbit:orbit /opt/orbit/web/build ./web
# The output is ESM but sits under the Next standalone's package.json, which
# has no "type" field — without this marker Node reparses every file with a
# MODULE_TYPELESS_PACKAGE_JSON warning. Root-owned data file, like VERSION.
RUN printf '{"type":"module"}\n' > ./web/package.json \
  && chown root:root ./web/package.json \
  && chmod 0444 ./web/package.json
COPY --from=builder --chown=orbit:orbit /opt/orbit/scripts/recovery-crypto.mjs ./scripts/recovery-crypto.mjs
COPY --from=builder --chown=orbit:orbit /opt/orbit/scripts/generate-vapid.mjs ./scripts/generate-vapid.mjs
COPY --from=builder --chown=root:root /opt/orbit/scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh
# The composite entry (#450): both applications in one process on one origin.
# Root-owned data files like the entrypoint; invoked as `node scripts/...`.
COPY --from=builder --chown=root:root /opt/orbit/scripts/container-server.mjs ./scripts/container-server.mjs
COPY --from=builder --chown=root:root /opt/orbit/scripts/v19-dispatch.mjs ./scripts/v19-dispatch.mjs
# The bundled engine CLI (single file, no node_modules dependency at
# runtime — see scripts/bundle-orbit-cli.mjs). Root-owned and read-only,
# like container-entrypoint.sh above and VERSION/REVISION/CHANNEL below;
# unlike container-entrypoint.sh it is never executed directly (it is
# always invoked as `node /opt/orbit/cli/orbit.js ...`, per docs/
# engine-events.md's "In-container engine invocation" contract), so it
# gets a data-file mode (0444) rather than an executable one.
COPY --from=cli-builder --chown=root:root /opt/orbit/dist/cli/orbit.js ./cli/orbit.js
# Re-validated here (belt-and-suspenders) immediately before the values are
# written to disk, using the same shared patterns sourced above (#435) — not
# a second hardcoded copy, so this cannot silently diverge from the early
# check's idea of what counts as valid.
RUN . /opt/orbit/scripts/release-metadata-patterns.sh \
  && printf '%s\n' "${ORBIT_VERSION}" | grep -Eq "$ORBIT_VERSION_PATTERN" \
  && printf '%s\n' "${ORBIT_REVISION}" | grep -Eq "$ORBIT_REVISION_PATTERN" \
  && printf '%s\n' "${ORBIT_CHANNEL}" | grep -Eq "$ORBIT_CHANNEL_PATTERN" \
  && printf '%s\n' "${ORBIT_VERSION}" > /opt/orbit/VERSION \
  && printf '%s\n' "${ORBIT_REVISION}" > /opt/orbit/REVISION \
  && printf '%s\n' "${ORBIT_CHANNEL}" > /opt/orbit/CHANNEL \
  && chown root:root /opt/orbit/VERSION /opt/orbit/REVISION /opt/orbit/CHANNEL \
  && chmod 0444 /opt/orbit/VERSION /opt/orbit/REVISION /opt/orbit/CHANNEL \
  && chmod 0755 ./scripts/container-entrypoint.sh \
  && chmod 0444 ./cli/orbit.js \
  && rm -f /opt/orbit/scripts/release-metadata-patterns.sh
USER root
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=10 CMD su-exec orbit:orbit node -e "fetch('http://127.0.0.1:3000/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch((error) => { console.error(error); process.exit(1); })"
ENTRYPOINT ["/opt/orbit/scripts/container-entrypoint.sh"]
CMD ["node", "scripts/container-server.mjs"]
