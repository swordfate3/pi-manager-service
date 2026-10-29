# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.22.1-bookworm-slim
ARG DOCKER_IMAGE=docker:29.3.0-cli
FROM ${DOCKER_IMAGE} AS docker-cli
FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build && npm run verify:dist

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash python3 git openssh-client curl ca-certificates util-linux procps \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
WORKDIR /opt/pi-manager
COPY --from=build /build/dist/ ./dist/
COPY --from=build /build/node_modules/ws/ ./node_modules/ws/
COPY --from=build /build/deploy/stack/ ./deploy/stack/
COPY --from=build /build/runtime/ ./runtime/
RUN chmod 755 deploy/stack/scripts/* \
    && node --check dist/manager/pi-manager-local.mjs \
    && docker --version && docker compose version
ENV NODE_ENV=production
USER 1000:1000
ENTRYPOINT ["node", "/opt/pi-manager/dist/manager/pi-manager-local.mjs"]
CMD ["--help"]
