ARG ALPINE_VERSION=3.21
FROM alpine:${ALPINE_VERSION}
ARG POSTGRES_VERSION=17
RUN apk add --no-cache postgresql${POSTGRES_VERSION}-client aws-cli openssl curl bash
WORKDIR /backup
COPY backups/backup.sh ./backup.sh
RUN chmod 0555 ./backup.sh
ENTRYPOINT ["/backup/backup.sh"]
