# Stage 1: Builder
FROM node:24-alpine AS builder

# Set working directory
WORKDIR /app

# Install pnpm
RUN corepack enable pnpm

# Copy dependency definition files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY apps/backend ./apps/backend
COPY packages/schemas ./packages/schemas

# Stage 2: Runner
FROM node:24-alpine AS runner

# Set working directory
WORKDIR /app

# Copy source code and dependencies from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/backend ./apps/backend
COPY --from=builder /app/packages/schemas ./packages/schemas

# Expose port
EXPOSE 3001

# Start the server
CMD ["node", "--env-file-if-exists=./apps/backend/.env", "./apps/backend/index.ts"]
