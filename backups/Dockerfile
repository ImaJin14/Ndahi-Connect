ARG ALPINE_VERSION=3.21
FROM node:22-alpine${ALPINE_VERSION}
ARG POSTGRES_VERSION=17
RUN apk add --no-cache postgresql${POSTGRES_VERSION}-client openssl curl bash
WORKDIR /backup
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY backups/backup.sh backups/restore.sh backups/gcs.mjs ./
RUN chmod 0555 ./backup.sh ./restore.sh ./gcs.mjs
ENTRYPOINT ["/backup/backup.sh"]
