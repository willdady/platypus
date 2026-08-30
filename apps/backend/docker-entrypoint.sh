#!/bin/sh
set -e

# Platypus runs as `platypus` (uid 1001, gid 1001). Two directories have to be
# writable by that account, and only one of them can be settled while the image
# is being built:
#
#   - Everything under /app, including the STORAGE_DISK_PATH default of
#     ./data/files. The Dockerfile owns this; nothing here needs to.
#   - /data, which compose.yaml bind-mounts from the host. On Linux a bind mount
#     keeps the host directory's ownership and masks whatever the build set, so
#     an existing deployment whose ./data belongs to some other uid would hit
#     EACCES on the first upload. It can only be repaired once the mount is in
#     place, which is here.
#
# Started as root, we repair that ownership and then drop to `platypus`, so the
# application itself never runs privileged. Started as an explicit non-root user
# (`docker run --user`, Kubernetes `runAsUser`) we cannot chown anything, so we
# leave the mount alone and exec as whoever we already are — that deployment has
# taken ownership of the problem itself and the host directory must already be
# writable by its uid.
if [ "$(id -u)" = "0" ]; then
  for dir in /data "${STORAGE_DISK_PATH:-}"; do
    [ -n "$dir" ] || continue
    [ -d "$dir" ] || mkdir -p "$dir"
    # Recursing a large store on every restart is wasteful, and the common case
    # is a directory this container already owns. Only walk it when the top of
    # the tree says the owner is somebody else.
    if [ "$(stat -c %u "$dir")" != "1001" ]; then
      chown -R platypus:platypus "$dir"
    fi
  done
  exec su-exec platypus "$@"
fi

exec "$@"
