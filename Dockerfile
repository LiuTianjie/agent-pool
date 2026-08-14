# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/runner/package.json apps/runner/tsconfig.json ./apps/runner/
COPY apps/official-runner/package.json apps/official-runner/tsconfig.json ./apps/official-runner/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/vite.config.ts ./apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST_PATH=/app/apps/web/dist

WORKDIR /app
COPY --chown=node:node --from=build /app /app

EXPOSE 3000
USER node
CMD ["node", "apps/api/dist/src/index.js"]
