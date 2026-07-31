FROM node:22-alpine@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c

RUN apk add --no-cache openssl

WORKDIR /app
COPY start.sh server.mjs ./
RUN chmod 0555 start.sh

EXPOSE 4443
ENTRYPOINT ["./start.sh"]
