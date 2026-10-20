# OIDC_BASE_IMAGE_PREFIX lets GitLab CI route this pull through the group
# dependency proxy instead of Docker Hub directly (ai/orbit#1111); empty by
# default, which is the direct Docker Hub pull local builds and GitHub Actions
# use. Same digest either way.
ARG OIDC_BASE_IMAGE_PREFIX=
FROM ${OIDC_BASE_IMAGE_PREFIX}node:24-alpine@sha256:429bdfbc204b4eabc6438e6d34e4e9d8dd2ca1df8289bcd78cdd3c5db387b7a5

RUN apk add --no-cache openssl

WORKDIR /app
COPY start.sh server.mjs ./
RUN chmod 0555 start.sh

EXPOSE 4443
ENTRYPOINT ["./start.sh"]
