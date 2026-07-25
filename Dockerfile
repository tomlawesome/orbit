FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /opt/orbit

FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
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
RUN addgroup --system --gid 1001 orbit && adduser --system --uid 1001 --ingroup orbit orbit
COPY --from=builder --chown=orbit:orbit /opt/orbit/public ./public
COPY --from=builder --chown=orbit:orbit /opt/orbit/.next/standalone ./
COPY --from=builder --chown=orbit:orbit /opt/orbit/.next/static ./.next/static
COPY --from=builder --chown=orbit:orbit /opt/orbit/drizzle ./drizzle
USER orbit
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=10 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch((error) => { console.error(error); process.exit(1); })"
CMD ["node", "server.js"]
