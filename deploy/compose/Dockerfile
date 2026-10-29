# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
ARG DOCKER_IMAGE=docker:29.3.0-cli@sha256:067c301efe497cd5d174d468b7b3422a485ae4aca8f7ec1ffd4655c9fa383af2
ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
FROM ${DOCKER_IMAGE} AS docker-cli
FROM ${NODE_IMAGE} AS build
RUN mkdir /node-runtime-libs \
    && ldd /usr/local/bin/node | awk '$3 ~ /^\// && $1 !~ /^(libc\.so|libm\.so|libpthread\.so|libdl\.so|librt\.so)/ {print $3}' | xargs -r cp -L -t /node-runtime-libs
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build && npm run verify:dist

FROM ${PYTHON_IMAGE} AS runtime
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.source="https://github.com/swordfate3/pi-manager-service" org.opencontainers.image.revision="${SOURCE_COMMIT}"
COPY --from=build /node-runtime-libs/ /opt/node-runtime-libs/
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=docker-cli /usr/local/bin/docker /usr/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
WORKDIR /opt/pi-manager
COPY --from=build /build/dist/ ./dist/
COPY --from=build /build/node_modules/ws/ ./node_modules/ws/
COPY --from=build /build/runtime/ ./runtime/
COPY --from=build /build/deploy/compose/ /opt/pi-stack/
RUN ln -s /usr/local/bin/python3 /usr/bin/python3 \
    && chmod 755 /opt/pi-stack/bin/* \
    && node --check dist/manager/pi-manager-local.mjs \
    && python3 -c 'import http.client,fcntl,ssl' \
    && command -v bash && command -v flock && docker compose version
ENV NODE_ENV=production LD_LIBRARY_PATH=/opt/node-runtime-libs
USER 1000:1000
ENTRYPOINT ["node", "/opt/pi-manager/dist/manager/pi-manager-local.mjs"]
CMD ["--help"]
