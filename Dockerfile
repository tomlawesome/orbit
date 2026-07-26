FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /opt/orbit

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /opt/orbit/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV MIGRATE_ON_START=true
ENV WORKER_ENABLED=true
LABEL org.opencontainers.image.title="Orbit"
LABEL org.opencontainers.image.description="Everything in your orbit, on track."
LABEL org.opencontainers.image.source="https://github.com/tomlawesome/orbit"
WORKDIR /opt/orbit
# Seed the mount point with the runtime user's ownership so a new named volume
# is writable when Docker copies the image directory into it on first use.
RUN apk add --no-cache su-exec \
  && addgroup --system --gid 1001 orbit \
  && adduser --system --uid 1001 --ingroup orbit orbit \
  && mkdir -p /var/lib/orbit/documents \
  && chown orbit:orbit /var/lib/orbit /var/lib/orbit/documents \
  && chmod 0750 /var/lib/orbit /var/lib/orbit/documents
COPY --from=builder --chown=orbit:orbit /opt/orbit/public ./public
COPY --from=builder --chown=orbit:orbit /opt/orbit/.next/standalone ./
COPY --from=builder --chown=orbit:orbit /opt/orbit/.next/static ./.next/static
COPY --from=builder --chown=orbit:orbit /opt/orbit/drizzle ./drizzle
COPY --from=builder --chown=orbit:orbit /opt/orbit/scripts/recovery-crypto.mjs ./scripts/recovery-crypto.mjs
COPY --from=builder --chown=root:root /opt/orbit/scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh
RUN chmod 0755 ./scripts/container-entrypoint.sh
USER root
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=10 CMD su-exec orbit:orbit node -e "fetch('http://127.0.0.1:3000/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch((error) => { console.error(error); process.exit(1); })"
ENTRYPOINT ["/opt/orbit/scripts/container-entrypoint.sh"]
CMD ["node", "server.js"]
