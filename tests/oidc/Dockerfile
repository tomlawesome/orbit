FROM node:24-alpine@sha256:83f1c388c31fb2e51f7cbd4dea949b96260798c98f206e8e4696bc93bd964e3a

RUN apk add --no-cache openssl

WORKDIR /app
COPY start.sh server.mjs ./
RUN chmod 0555 start.sh

EXPOSE 4443
ENTRYPOINT ["./start.sh"]
