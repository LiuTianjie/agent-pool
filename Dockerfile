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

FROM node:22-alpine AS production-dependencies

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/runner/package.json ./apps/runner/
COPY apps/official-runner/package.json ./apps/official-runner/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --prod --frozen-lockfile

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST_PATH=/app/apps/web/dist

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=production-dependencies /app/apps/api/node_modules ./apps/api/node_modules
COPY --chown=node:node --from=production-dependencies /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --chown=node:node apps/api/package.json ./apps/api/
COPY --chown=node:node packages/shared/package.json ./packages/shared/
COPY --chown=node:node --from=build /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node --from=build /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node --from=build /app/packages/shared/dist ./packages/shared/dist

EXPOSE 3000
USER node
CMD ["node", "apps/api/dist/src/index.js"]
