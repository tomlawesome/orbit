# OIDC_BASE_IMAGE_PREFIX lets GitLab CI route this pull through the group
# dependency proxy instead of Docker Hub directly (ai/orbit#1111); empty by
# default, which is the direct Docker Hub pull local builds and GitHub Actions
# use. Same digest either way.
ARG OIDC_BASE_IMAGE_PREFIX=
FROM ${OIDC_BASE_IMAGE_PREFIX}node:24-alpine@sha256:f777d4615e9f225aa23d72dc05bd8454a0fadcb033e00417c5b9257f5585677b

RUN apk add --no-cache openssl

WORKDIR /app
COPY start.sh server.mjs ./
RUN chmod 0555 start.sh

EXPOSE 4443
ENTRYPOINT ["./start.sh"]
