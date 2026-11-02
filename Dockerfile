FROM node:26-slim AS build
# Node 26 does not ship corepack, so npm installs it. `packageManager` in package.json selects the pnpm version.
RUN npm install --global corepack && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/claude_proxy_server/package.json packages/claude_proxy_server/package.json
COPY packages/claude_proxy_web_ui/package.json packages/claude_proxy_web_ui/package.json
RUN pnpm install --frozen-lockfile
COPY packages packages
# `pnpm build` also builds the macOS menu bar app, so build only the web UI.
RUN pnpm --filter claude_proxy_web_ui build

FROM node:26-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
COPY scripts scripts
# A new named volume at /data copies this owner. The server refuses to start when another user owns its directory.
RUN mkdir /data && chown node:node /data
ENV CLAUDE_PROXY_DIRECTORY=/data \
  CLAUDE_PROXY_LISTEN_ADDRESS=0.0.0.0 \
  CLAUDE_PROXY_PORT=4100
USER node
EXPOSE 4100
CMD ["node", "packages/claude_proxy_server/src/main.ts"]
