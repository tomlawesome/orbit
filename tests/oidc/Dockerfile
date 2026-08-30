FROM node:24-alpine@sha256:4caaaf42195bcd6f6f3559a413b20cb8f8ad089e231ee874cf7701643966689f

RUN apk add --no-cache openssl

WORKDIR /app
COPY start.sh server.mjs ./
RUN chmod 0555 start.sh

EXPOSE 4443
ENTRYPOINT ["./start.sh"]
