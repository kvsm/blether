# The Blether relay. See docs/self-hosting.md.

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm exec tsc -b packages/relay \
 && pnpm --filter @blether/relay deploy --prod --legacy /relay

FROM node:24-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    BLETHER_RELAY_HOST=0.0.0.0 \
    BLETHER_RELAY_PORT=7357 \
    BLETHER_RELAY_DB=/data/relay.db
COPY --from=build /relay /app
RUN mkdir /data && chown node:node /data
USER node
WORKDIR /app
VOLUME /data
EXPOSE 7357
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.BLETHER_RELAY_PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/app/dist/bin.js"]
CMD ["serve"]
