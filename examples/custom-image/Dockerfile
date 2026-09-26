# A custom backend image: the published image plus one third-party plugin.
# Bump this tag, and the frontend tag in compose.override.yaml, together.
FROM willdady/platypus-backend:3.10.2

# Install the plugin into its own npm project, outside the pnpm workspace in
# /app, so pnpm's node_modules is never touched. The plugin brings its own
# copy of @platypuschat/plugin-sdk and its other dependencies from npm.
COPY platypus-examples-tool-set-0.1.0.tgz /tmp/
RUN mkdir /opt/platypus-plugins && cd /opt/platypus-plugins && \
    echo '{"private":true}' > package.json && \
    npm install --omit=dev --no-audit --no-fund --cache /tmp/npm-cache \
      /tmp/platypus-examples-tool-set-0.1.0.tgz && \
    rm -rf /tmp/* && \
    chown -R platypus:platypus /opt/platypus-plugins

# The backend imports each PLATYPUS_PLUGINS entry by name from
# /app/apps/backend, so Node searches the node_modules of every parent
# directory. pnpm leaves /app/apps/node_modules unused; point it at the
# plugins project.
RUN ln -s /opt/platypus-plugins/node_modules /app/apps/node_modules && \
    chown -h platypus:platypus /app/apps/node_modules
