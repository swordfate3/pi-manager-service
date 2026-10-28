# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.22.1-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build && npm run verify:dist

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
WORKDIR /opt/pi-manager
COPY --from=build --chown=0:0 /build/dist/ ./dist/
COPY --from=dependencies --chown=0:0 /deps/node_modules/ ./node_modules/
ENV NODE_ENV=production HOME=/tmp
USER 1000:1000
ENTRYPOINT ["node", "/opt/pi-manager/dist/manager/pi-manager-service.mjs"]
CMD ["serve", "--config", "/data/manager/supervisor.json"]
