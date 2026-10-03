# Node 25+ no longer bundles corepack. pnpm itself is pinned and hash-checked
# through `packageManager` in the root package.json; this pins the shim.
ARG COREPACK_VERSION=0.36.0

FROM node:26-alpine AS base
ARG COREPACK_VERSION
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g corepack@$COREPACK_VERSION && corepack enable pnpm

FROM base AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
# Install turbo at the exact version the root package.json pins, so the image
# build prunes with the same turbo the repo uses.
COPY package.json ./
RUN npm install -g turbo@$(node -p "require('./package.json').devDependencies.turbo")
COPY . .
# Prune the workspace for backend
RUN turbo prune --scope=@platypus/backend --docker

# Stage to install production dependencies
FROM base AS prod-deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY .npmrc ./
# Disable auto-install of peer dependencies to avoid pulling in
# unnecessary packages like next, react, react-dom from better-auth. It is a
# flag rather than a line appended to .npmrc: that file has no trailing newline,
# so an appended line merges into its last one and pnpm silently ignores it.
RUN pnpm install --prod --config.auto-install-peers=false && \
    pnpm store prune && \
    rm -rf /tmp/* /root/.cache

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Where this image keeps uploaded files. `DiskStorage`'s own default is
# relative, so it resolves under WORKDIR and lands in the container's writable
# layer — gone on the next container recreate, which an image upgrade and a
# Kubernetes rollout both perform. Declaring it here reaches every way the image
# is deployed rather than Compose alone: mount a volume over /data and uploads
# persist with nothing else to configure. A deployment that sets the variable
# itself still overrides this.
ENV STORAGE_DISK_PATH=/data/files

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
# carry --chown, leaving the directory itself owned by root. The application
# runs from here as `platypus`, so hand it over.
RUN chown platypus:platypus /app

# Copy prod dependencies (includes root node_modules and workspace node_modules)
COPY --from=prod-deps --chown=platypus:platypus /app .

# Copy source code
COPY --from=builder --chown=platypus:platypus /app/out/full/ .

COPY --chown=platypus:platypus apps/backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 4000

# Probe the port the server actually listens on: PORT if set, else the app's
# own default. Alpine has no curl, so use node's fetch.
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 4001) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# The entrypoint fixes ownership of the bind-mounted /data and then drops to
# `platypus`, so the server below never runs as root. Deployments that would
# rather the container never start as root at all can set `--user 1001:1001`
# and take on making /data writable by that uid themselves.
ENTRYPOINT ["docker-entrypoint.sh"]

# Run migrations and start the server
CMD ["sh", "-c", "node ./apps/backend/scripts/migrate.ts && node --env-file-if-exists=./apps/backend/.env ./apps/backend/index.ts"]
