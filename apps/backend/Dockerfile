FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable pnpm

FROM base AS builder
RUN apk add --no-cache libc6-compat
# Install turbo globally
RUN npm install -g turbo
WORKDIR /app
COPY . .
# Prune the workspace for backend
RUN turbo prune --scope=@platypus/backend --docker

# Stage to install dependencies and run tests
FROM base AS tester
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy pruned package.json files
COPY --from=builder /app/out/json/ .
# Remove the lockfile to force re-resolution of dependencies.
RUN rm -f pnpm-lock.yaml

# Install ALL dependencies (including devDependencies for testing)
RUN pnpm install

# Copy source code
COPY --from=builder /app/out/full/ .

# Run tests
RUN pnpm test

# Stage to install production dependencies
FROM base AS prod-deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY --from=builder /app/out/json/ .
RUN pnpm install --prod --no-optional

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Don't run production as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 hono

# Copy prod dependencies (includes root node_modules and workspace node_modules)
COPY --from=prod-deps /app .

# Copy source code
COPY --from=builder /app/out/full/ .

# Expose port
EXPOSE 4000

# Run migrations and start the server
CMD ["sh", "-c", "node ./apps/backend/scripts/migrate.ts && node --env-file-if-exists=./apps/backend/.env ./apps/backend/index.ts"]
