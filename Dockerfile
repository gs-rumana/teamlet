# syntax=docker/dockerfile:1

# ---- build the web UI -------------------------------------------------------
# Static files are the same on every platform, so build them natively when cross-building.
FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm typecheck && pnpm build

# ---- production dependencies only ------------------------------------------
FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The only optional packages are the Agent SDK's bundled Claude Code binaries (~200 MB).
# Teamlet always runs the `claude` CLI installed below.
RUN pnpm install --frozen-lockfile --prod --no-optional

# ---- runtime ----------------------------------------------------------------
FROM node:24-slim
# Tools the agents commonly reach for while working.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client ripgrep python3 tini \
  && rm -rf /var/lib/apt/lists/*
# The agent CLIs. Sign-in happens at runtime and is stored under /data.
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force

ENV NODE_ENV=production \
    TEAMLET_HOST=0.0.0.0 \
    TEAMLET_PORT=4317 \
    TEAMLET_DATA_DIR=/data/teamlet \
    TEAMLET_DEFAULT_CWD=/workspace \
    CLAUDE_CONFIG_DIR=/data/claude \
    CODEX_HOME=/data/codex \
    HOME=/home/node

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY shared ./shared
COPY server ./server

# Claude Code refuses to skip permission prompts as root, so run as the image's `node` user.
RUN mkdir -p /data /workspace && chown -R node:node /data /workspace /home/node
USER node

EXPOSE 4317
VOLUME ["/data", "/workspace"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TEAMLET_PORT||4317)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# tini forwards SIGTERM so running agents are stopped and history is flushed.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.ts"]
