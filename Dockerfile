# Orbit's own base image: Alpine plus Node built from the official signed
# source, rebuilt on a schedule we control. It replaces node:22-alpine for two
# reasons recorded on orbit#650 — provenance (docker-node's Alpine variant
# installs an unofficial musl build with no signature chain to Node's release
# keys) and freshness (node:22-alpine is rebuilt only when a new Node 22.x
# ships, so it inherits and compounds Alpine's staleness; #646 left Orbit
# shipping a fixed-in-Alpine OpenSSL flaw for a month).
#
# The image already carries current Alpine packages, npm and yarn removed, and
# proves `corepack enable && pnpm --version` at build time — so the
# `apk upgrade` this replaces is no longer needed here. #649 also stops
# applying: that upgrade froze behind the layer cache, and there is no upgrade
# layer left to freeze.
FROM ghcr.io/tomlawesome/orbit-base-image:latest@sha256:237aac3c9561c2e1f9febe7acd7c0f6051e13571b6c6cc1e318278df07b9bcb8 AS base

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

# Builds the v19 front end (web/, SvelteKit + adapter-node) into its server
# output (#449). Since the cut (#735) there is no other application build:
# this output IS the server, and it serves the API routes too. Vite bundles
# the engine's TypeScript into it — the engine is a linked library, not a
# separate process (the architecture ruling on #735) — so no `tsc` emit
# exists or is wanted.
FROM base AS web-builder
COPY --from=deps /opt/orbit/node_modules ./node_modules
COPY --from=deps /opt/orbit/web/node_modules ./web/node_modules
COPY . .
RUN pnpm --filter orbit-web build

# The front end's production node_modules, pruned by pnpm to what actually
# runs (#735). The engine's own code is bundled by the stage above, but its
# nine runtime dependencies stay external and must be present on disk:
# `pdfjs-dist` resolves its worker and cmap assets by path, `@napi-rs/canvas`
# is native, and the rest are listed in web/package.json `dependencies`
# precisely so the adapter externalises them.
#
# `--legacy` is not optional on pnpm 11: without it `deploy` refuses with
# ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE. `deploy` also writes the package's
# own sources into the target; only node_modules is copied to the runner.
FROM base AS web-deps
COPY --from=deps /opt/orbit/node_modules ./node_modules
COPY --from=deps /opt/orbit/web/node_modules ./web/node_modules
COPY . .
RUN pnpm --filter orbit-web --prod deploy --legacy /opt/deploy-web

# Bundles the orbit engine CLI (src/cli/orbit.ts) into a single, dependency-
# free CommonJS file (issue #295 engine-delivery slice, owner decision
# 2026-08-13: the engine ships INSIDE the app image, invoked by host scripts
# as a disposable `docker compose run --rm --no-deps` one-off — never handed
# the Docker socket, never requiring Node on the host). Built in its own
# stage off `deps` since it needs neither the front-end build nor its output
# — esbuild does not type-check, and `npx tsc --noEmit` already gates this
# file in CI. See scripts/bundle-orbit-cli.mjs for the deterministic flag set
# and docs/engine-events.md, "In-container engine invocation", for the
# resulting artifact's invocation contract.
FROM base AS cli-builder
COPY --from=deps /opt/orbit/node_modules ./node_modules
COPY . .
RUN pnpm run build:cli

# The runtime stage starts from the base image again rather than from `base`,
# so it pins the same digest for the same reasons (see the base stage).
FROM ghcr.io/tomlawesome/orbit-base-image:latest@sha256:237aac3c9561c2e1f9febe7acd7c0f6051e13571b6c6cc1e318278df07b9bcb8 AS runner

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
# adapter-node's own variables (#735). It reads HOST, not Next's HOSTNAME;
# both default to these values, and they are set explicitly so the listening
# address is visible in `docker inspect` rather than only in the adapter.
ENV HOST=0.0.0.0
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
COPY --chown=orbit:orbit drizzle ./drizzle
# The v19 front end's server output (#449): index.js + handler.js + client/.
# Since the cut (#735) this is the whole application server — it answers the
# API routes as well as drawing the screens — so it is started directly (see
# CMD) rather than dispatched to by a custom server.
COPY --from=web-builder --chown=orbit:orbit /opt/orbit/web/build ./web
# The nine engine runtime dependencies, pruned to production. Node resolves
# them by walking up from the importing file, so they must sit here, beside
# the output that imports them, and nowhere else.
COPY --from=web-deps --chown=orbit:orbit /opt/deploy-web/node_modules ./web/node_modules
# The output is ESM and /opt/orbit has no package.json at all, so without this
# marker Node reparses every file with a MODULE_TYPELESS_PACKAGE_JSON warning.
# It stops at ./web deliberately: the CLI below is CommonJS and relies on
# /opt/orbit staying typeless. Root-owned data file, like VERSION.
RUN printf '{"type":"module"}\n' > ./web/package.json \
  && chown root:root ./web/package.json \
  && chmod 0444 ./web/package.json
# Proves page-one previews can actually be rendered by what this image ships,
# against the finished layout rather than a build stage's copy of it (#476,
# #493, #735). It draws a real page with the native canvas that is here now;
# parsing a PDF is not rendering one, and #493 shipped a container that could
# do the first and not the second. The script is removed again immediately:
# it is a build-time gate, not runtime surface.
COPY scripts/web-pdfjs-runtime-check.mjs ./scripts/web-pdfjs-runtime-check.mjs
RUN ORBIT_WEB_BUILD_ROOT=/opt/orbit/web node scripts/web-pdfjs-runtime-check.mjs \
  && rm -f /opt/orbit/scripts/web-pdfjs-runtime-check.mjs
COPY --chown=orbit:orbit scripts/recovery-crypto.mjs ./scripts/recovery-crypto.mjs
COPY --chown=orbit:orbit scripts/generate-vapid.mjs ./scripts/generate-vapid.mjs
COPY --chown=root:root scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh
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
CMD ["node", "web/index.js"]
