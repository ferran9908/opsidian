# The Opsidian host, for a server that is always on. See docs/hosting.md.
FROM node:24-slim AS build
WORKDIR /src
RUN npm install --global pnpm@12.4.1
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/host/package.json apps/host/
COPY packages/core/package.json packages/core/
COPY packages/sync/package.json packages/sync/
RUN pnpm install --frozen-lockfile --filter @opsidian/host...
COPY tsconfig.base.json ./
COPY apps/host apps/host
COPY packages/core packages/core
COPY packages/sync packages/sync
RUN pnpm --filter @opsidian/host build

FROM node:24-slim
# One file, no dependencies to install.
COPY --from=build /src/apps/host/dist/opsidian-host.mjs /usr/local/bin/opsidian-host
RUN chmod +x /usr/local/bin/opsidian-host && mkdir /data && chown node:node /data
USER node
ENV OPSIDIAN_HOST_DATA=/data
VOLUME /data
EXPOSE 4810
ENTRYPOINT ["opsidian-host"]
CMD ["serve"]
