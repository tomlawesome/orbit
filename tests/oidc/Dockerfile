# OIDC_BASE_IMAGE_PREFIX lets GitLab CI route this pull through the group
# dependency proxy instead of Docker Hub directly (ai/orbit#1111); empty by
# default, which is the direct Docker Hub pull local builds and GitHub Actions
# use. Same digest either way.
ARG OIDC_BASE_IMAGE_PREFIX=
FROM ${OIDC_BASE_IMAGE_PREFIX}node:24-alpine@sha256:83f1c388c31fb2e51f7cbd4dea949b96260798c98f206e8e4696bc93bd964e3a

RUN apk add --no-cache openssl

WORKDIR /app
COPY start.sh server.mjs ./
RUN chmod 0555 start.sh

EXPOSE 4443
ENTRYPOINT ["./start.sh"]
