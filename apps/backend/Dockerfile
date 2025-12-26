# Stage 1: Builder
FROM node:24-alpine AS builder

# Set working directory
WORKDIR /app

# Install pnpm
RUN corepack enable pnpm

# Copy all package.json files first (needed for pnpm to know workspace structure)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/schemas/package.json ./packages/schemas/

# Install dependencies (now pnpm knows about all workspace packages)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY apps/backend ./apps/backend
COPY packages/schemas ./packages/schemas

# Stage 2: Runner
FROM node:24-alpine AS runner

# Set working directory
WORKDIR /app

ENV NODE_ENV=production

# Copy package.json files (needed for ESM module resolution)
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# Copy dependencies and source code from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/backend ./apps/backend
COPY --from=builder /app/packages/schemas ./packages/schemas

# Expose port
EXPOSE 4000

# Run migrations and start the server
CMD ["sh", "-c", "node ./apps/backend/scripts/migrate.ts && node --env-file-if-exists=./apps/backend/.env ./apps/backend/index.ts"]
