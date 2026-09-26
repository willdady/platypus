# A custom backend image: the published image plus one third-party plugin.
# Bump this tag, and the frontend tag in compose.override.yaml, together.
FROM willdady/platypus-backend:3.10.2

# Install the plugin into its own npm project, outside the pnpm workspace in
# /app, so pnpm's node_modules is never touched. The plugin brings its own
# copy of @platypuschat/plugin-sdk and its other dependencies from npm.
#
# The whole build context is copied so the COPY still succeeds with no tarball
# in it: installing from npm instead changes only the `npm install` argument.
COPY . /tmp/plugins/
RUN mkdir /opt/platypus-plugins && cd /opt/platypus-plugins && \
    echo '{"private":true}' > package.json && \
    npm install --omit=dev --no-audit --no-fund --cache /tmp/npm-cache \
      /tmp/plugins/platypus-examples-tool-set-0.1.0.tgz && \
    rm -rf /tmp/plugins /tmp/npm-cache && \
    chown -R platypus:platypus /opt/platypus-plugins

# The backend imports each PLATYPUS_PLUGINS entry by name from its own source
# under /app/apps/backend, so Node searches the node_modules of every parent
# directory. pnpm leaves /app/apps/node_modules unused; point it at the
# plugins project.
RUN ln -s /opt/platypus-plugins/node_modules /app/apps/node_modules && \
    chown -h platypus:platypus /app/apps/node_modules
