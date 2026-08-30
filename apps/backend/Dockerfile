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

# Copy pruned package.json files and lockfile
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY .npmrc ./

# Install ALL dependencies (including devDependencies for testing)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY --from=builder /app/out/full/ .

# Run tests
RUN pnpm test

# Stage to install production dependencies
FROM base AS prod-deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY .npmrc ./
# Disable auto-install of peer dependencies to avoid pulling in
# unnecessary packages like next, react, react-dom from better-auth
RUN echo "auto-install-peers=false" >> .npmrc
RUN pnpm install --prod && \
    pnpm store prune && \
    rm -rf /tmp/* /root/.cache

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# `su-exec` lets the entrypoint drop from root to `platypus` once it has
# repaired the ownership of a bind-mounted /data.
RUN apk add --no-cache su-exec

# Don't run production as root. uid/gid 1001 is the part of this identity that
# leaves the image — a bind-mounted /data has to match it — so it is fixed;
# the account name is not, and both images use `platypus`.
RUN addgroup --system --gid 1001 platypus && \
    adduser --system --uid 1001 --ingroup platypus platypus && \
    mkdir -p /data/files && chown -R platypus:platypus /data

# WORKDIR created /app as root:root, and only the *contents* of the copies below
# carry --chown. The STORAGE_DISK_PATH default resolves to /app/data/files, so
# the directory itself has to be writable or the app cannot create it.
RUN chown platypus:platypus /app

# Copy prod dependencies (includes root node_modules and workspace node_modules)
COPY --from=prod-deps --chown=platypus:platypus /app .

# Copy source code
COPY --from=builder --chown=platypus:platypus /app/out/full/ .

COPY --chown=platypus:platypus apps/backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 4000

# The entrypoint fixes ownership of the bind-mounted /data and then drops to
# `platypus`, so the server below never runs as root. Deployments that would
# rather the container never start as root at all can set `--user 1001:1001`
# and take on making /data writable by that uid themselves.
ENTRYPOINT ["docker-entrypoint.sh"]

# Run migrations and start the server
CMD ["sh", "-c", "node ./apps/backend/scripts/migrate.ts && node --env-file-if-exists=./apps/backend/.env ./apps/backend/index.ts"]
