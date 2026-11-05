# The e2e stack's DKIM key stand-in (#1681): built from the same pinned
# node:24-alpine as tests/oidc/Dockerfile, so it adds no third-party image.
# OIDC_BASE_IMAGE_PREFIX, the same build arg tests/oidc takes so one setting
# covers both node pulls, is an optional registry prefix; empty by default,
# which is a plain Docker Hub name. CI leaves it empty too: the runner hosts
# mirror Docker Hub through the image cache (ai/orbit#1510).
ARG OIDC_BASE_IMAGE_PREFIX=
FROM ${OIDC_BASE_IMAGE_PREFIX}node:24-alpine@sha256:4eefa1bfce4197942661ef9148247d779ddf1bb0ee006d3294a467609de60724

WORKDIR /app
COPY server.mjs ./
USER node

EXPOSE 5353/udp
ENTRYPOINT ["node", "server.mjs"]
