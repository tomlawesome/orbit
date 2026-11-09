# The e2e stack's DKIM key stand-in (#1681): built from the same pinned
# node:24-alpine as tests/oidc/Dockerfile, so it adds no third-party image.
# OIDC_BASE_IMAGE_PREFIX, the same build arg tests/oidc takes so one setting
# covers both node pulls, is an optional registry prefix; empty by default,
# which is a plain Docker Hub name. CI leaves it empty too: the runner hosts
# mirror Docker Hub through the image cache (ai/orbit#1510).
ARG OIDC_BASE_IMAGE_PREFIX=
FROM ${OIDC_BASE_IMAGE_PREFIX}node:24-alpine@sha256:ec318aabf188af4e5488847eea4b24452650b9917140563e140762526a37f1df

WORKDIR /app
COPY server.mjs ./
USER node

EXPOSE 5353/udp
ENTRYPOINT ["node", "server.mjs"]
