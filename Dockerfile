# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
ARG NODE_IMAGE=node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY minimal/web ./minimal/web
COPY minimal/vite.config.ts ./minimal/vite.config.ts
COPY scripts/licenses.mjs ./scripts/licenses.mjs
RUN npm run build

FROM ${NODE_IMAGE} AS runtime-base
ARG GIT_VERSION=1:2.39.5-0+deb12u3
RUN apt-get update \
    && apt-get install -y --no-install-recommends "git=${GIT_VERSION}" \
    && rm -rf /var/lib/apt/lists/* /root/.npm /usr/local/lib/node_modules/npm /opt/yarn* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir -p /app /data /run/t3 \
    && chown node:node /app /data /run/t3
RUN chmod 1777 /data
WORKDIR /app
COPY minimal/server ./minimal/server
COPY LICENSE ./LICENSE
COPY NOTICE ./NOTICE
COPY minimal/web/UPSTREAM.md ./UPSTREAM.md
USER node
ENV NODE_ENV=production
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "minimal/server/health.mjs", "--socket", "/run/t3/http.sock"]
ENTRYPOINT ["node", "minimal/server/main.mjs"]

FROM runtime-base AS prebuilt
COPY dist ./dist

FROM runtime-base AS production
COPY --from=build /build/dist ./dist
