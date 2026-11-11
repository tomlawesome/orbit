# OIDC_BASE_IMAGE_PREFIX is an optional registry prefix for this pull; empty by
# default, which is a plain Docker Hub name. CI leaves it empty too: the runner
# hosts mirror Docker Hub through the image cache (ai/orbit#1510).
ARG OIDC_BASE_IMAGE_PREFIX=
FROM ${OIDC_BASE_IMAGE_PREFIX}node:24-alpine@sha256:ec318aabf188af4e5488847eea4b24452650b9917140563e140762526a37f1df

RUN apk add --no-cache openssl

WORKDIR /app
COPY start.sh server.mjs ./
RUN chmod 0555 start.sh

EXPOSE 4443
ENTRYPOINT ["./start.sh"]
