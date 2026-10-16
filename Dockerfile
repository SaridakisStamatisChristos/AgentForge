FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@10.18.3 --activate \
  && npm install --global typescript@5.8.3
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY types ./types
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY examples ./examples
COPY benchmarks ./benchmarks
COPY docs ./docs
RUN pnpm install --frozen-lockfile && pnpm build
ENV DATABASE_URL=postgresql://agentforge:agentforge@postgres:5432/agentforge
CMD ["node", "--conditions=development", "apps/api/dist/index.js"]
