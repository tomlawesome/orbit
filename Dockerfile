FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /opt/homesee

FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /opt/homesee/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV MIGRATE_ON_START=true
ENV WORKER_ENABLED=true
WORKDIR /opt/homesee
RUN addgroup --system --gid 1001 homesee && adduser --system --uid 1001 --ingroup homesee homesee
COPY --from=builder --chown=homesee:homesee /opt/homesee/public ./public
COPY --from=builder --chown=homesee:homesee /opt/homesee/.next/standalone ./
COPY --from=builder --chown=homesee:homesee /opt/homesee/.next/static ./.next/static
COPY --from=builder --chown=homesee:homesee /opt/homesee/drizzle ./drizzle
USER homesee
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
