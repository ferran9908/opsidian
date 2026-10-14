# The Opsidian host, for a server that is always on. See docs/hosting.md.
FROM node:24-slim AS build
WORKDIR /src
RUN npm install --global pnpm@12.4.1
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/host/package.json apps/host/
COPY packages/core/package.json packages/core/
COPY packages/sync/package.json packages/sync/
RUN pnpm install --frozen-lockfile --filter @triadlabs/opsidian...
COPY tsconfig.base.json ./
COPY apps/host apps/host
COPY packages/core packages/core
COPY packages/sync packages/sync
RUN pnpm --filter @triadlabs/opsidian build

FROM node:24-slim
# One file, no dependencies to install.
COPY --from=build /src/apps/host/dist/opsidian.mjs /usr/local/lib/opsidian.mjs
RUN printf '#!/bin/sh\nexec node /usr/local/lib/opsidian.mjs "$@"\n' > /usr/local/bin/opsidian \
  && chmod +x /usr/local/bin/opsidian && mkdir /data && chown node:node /data
USER node
# Settings and data live in the volume. The host cannot see the address devices reach it at
# from inside a container, so pass it in: -e OPSIDIAN_ADDRESS=100.x.y.z:4810
ENV OPSIDIAN_HOME=/data
VOLUME /data
EXPOSE 4810
ENTRYPOINT ["opsidian", "host"]
CMD ["run"]
