#!/usr/bin/env bash
# Platypus installer.
#
#   curl -fsSL https://platypus.chat/install.sh | ADMIN_EMAIL=you@example.com bash
#
# Stands up a pinned Docker Compose deployment in ./platypus. Runs without
# prompts; configure it with environment variables instead:
#
#   PLATYPUS_VERSION  release to install, e.g. 3.13.0 (default: latest)
#   PLATYPUS_DIR      install directory (default: ./platypus)
#   PLATYPUS_HOST     host the browser reaches Platypus on (default: localhost)
#   ADMIN_EMAIL       initial admin email (default: admin@example.com)
#   ADMIN_PASSWORD    initial admin password (default: randomly generated)
#
# Docs: https://docs.platypus.chat/self-hosting/docker-compose

set -euo pipefail

REPO="willdady/platypus"
DOCS="https://docs.platypus.chat"

fail() {
  echo "error: $*" >&2
  exit 1
}

# Everything runs from main, called on the last line, so a download cut short
# by the network runs nothing rather than half a script.
main() {
  # --- Preflight: nothing is written until all of these pass. ---
  echo "Checking prerequisites (Docker can take a few seconds to answer)..."
  case "$(uname -s)" in
    Linux | Darwin) ;;
    *) fail "unsupported OS '$(uname -s)'. Platypus installs on Linux or macOS; on Windows, run this inside WSL." ;;
  esac
  for cmd in curl openssl docker; do
    command -v "$cmd" >/dev/null 2>&1 || fail "'$cmd' is required but was not found."
  done
  docker compose version >/dev/null 2>&1 ||
    fail "Docker Compose v2 ('docker compose') is required but was not found."
  docker info >/dev/null 2>&1 ||
    fail "the Docker daemon is not running (or this user cannot reach it). Start Docker and try again."
  # Caught here, a taken port costs nothing; caught by 'docker compose up', it
  # leaves a .env behind that stops this installer from re-running.
  local port
  for port in 3000 4000; do
    ! (echo >"/dev/tcp/127.0.0.1/$port") 2>/dev/null ||
      fail "port $port is already in use on this host, and Platypus needs it. Stop whatever is using it (see: lsof -i :$port) and try again."
  done

  local host="${PLATYPUS_HOST:-localhost}"
  local email="${ADMIN_EMAIL:-admin@example.com}"
  local password="${ADMIN_PASSWORD:-$(openssl rand -hex 12)}"
  local secret
  secret="$(openssl rand -hex 32)"
  # Values are written single-quoted, one per line, so they can't hold a ' or
  # a control character such as a newline.
  for value in "$host" "$email" "$password"; do
    [[ "$value" != *"'"* && "$value" != *[[:cntrl:]]* ]] ||
      fail "PLATYPUS_HOST, ADMIN_EMAIL and ADMIN_PASSWORD must not contain a single quote (') or a control character such as a newline."
  done
  # A host name, IPv4 address or bracketed IPv6 address — it becomes the
  # scheme-and-host of three URLs.
  [[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ || "$host" =~ ^\[[0-9A-Fa-f:.]+\]$ ]] ||
    fail "PLATYPUS_HOST '$host' is not a host name or IP address (no scheme, port or path)."
  [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] ||
    fail "ADMIN_EMAIL '$email' is not an email address."
  # The backend refuses to seed a shorter one, which would leave a half-started
  # install this script then refuses to re-run over.
  ((${#password} >= 8)) || fail "ADMIN_PASSWORD must be at least 8 characters."

  local dir="${PLATYPUS_DIR:-./platypus}"
  [[ ! -e "$dir/.env" ]] ||
    fail "$dir/.env already exists, so Platypus is already installed there. Nothing was changed. To upgrade, see $DOCS/self-hosting/docker-compose#upgrading"

  # A database left by an earlier install into a same-named directory would be
  # reused, and first boot would skip seeding the admin printed below.
  # Mirrors Compose's project-name rule (lowercase, drop other chars); exotic dir names may differ.
  local project volume
  project="${COMPOSE_PROJECT_NAME:-$(basename "$dir" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')}"
  volume="${project}_postgres_data"
  ! docker volume inspect "$volume" >/dev/null 2>&1 ||
    fail "Docker volume '$volume' still holds the database of an earlier Platypus install.
This install would reuse it, and the admin password printed at the end wouldn't sign in. Either:
  - delete it, erasing that install's data:  docker volume rm $volume
  - or keep it and install into a directory with another name:
      curl -fsSL https://platypus.chat/install.sh | PLATYPUS_DIR=./platypus2 bash"

  # --- Resolve the version, from the redirect rather than the rate-limited API. ---
  local version="${PLATYPUS_VERSION:-}"
  if [[ -z "$version" ]]; then
    echo "Finding the latest release..."
    local latest
    latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" ||
      fail "could not reach GitHub to find the latest release. Set PLATYPUS_VERSION to install a specific one."
    version="${latest##*/}"
  fi
  version="${version#v}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || fail "'$version' is not a release version (expected e.g. 3.13.0)."

  echo "Installing Platypus $version into $dir"

  # --- Fetch the release's files. ---
  mkdir -p "$dir"
  local raw="https://raw.githubusercontent.com/$REPO/v$version"
  curl -fsSL "$raw/compose.yaml" -o "$dir/compose.yaml" ||
    fail "could not download compose.yaml for v$version. Check that the release exists."
  curl -fsSL "$raw/.env.example" -o "$dir/.env.example" ||
    fail "could not download .env.example for v$version."

  cat >"$dir/compose.override.yaml" <<EOF
services:
  backend:
    image: willdady/platypus-backend:$version
  frontend:
    image: willdady/platypus-frontend:$version
EOF

  # --- Write .env: the release's .env.example with our values substituted. ---
  (
    umask 077
    V_BETTER_AUTH_SECRET="$secret" \
      V_ADMIN_EMAIL="$email" \
      V_ADMIN_PASSWORD="$password" \
      V_FRONTEND_URL="http://$host:3000" \
      V_BACKEND_URL="http://$host:4000" \
      V_ALLOWED_ORIGINS="http://$host:3000" \
      awk '
        match($0, /^[A-Z_]+=/) {
          key = substr($0, 1, RLENGTH - 1)
          if (("V_" key) in ENVIRON) $0 = key "='\''" ENVIRON["V_" key] "'\''"
        }
        { print }
      ' "$dir/.env.example" >"$dir/.env.tmp"
  )
  local key
  for key in BETTER_AUTH_SECRET ADMIN_EMAIL ADMIN_PASSWORD FRONTEND_URL BACKEND_URL ALLOWED_ORIGINS; do
    grep -q "^$key='" "$dir/.env.tmp" || {
      rm -f "$dir/.env.tmp"
      fail "the v$version .env.example has no $key line, so this installer can't configure it."
    }
  done
  chmod 600 "$dir/.env.tmp"
  mv "$dir/.env.tmp" "$dir/.env"

  cat >"$dir/README.md" <<EOF
# Platypus $version

Installed by https://platypus.chat/install.sh. Run these from this directory.

    docker compose up -d       # start
    docker compose stop        # stop, keeping your data
    docker compose restart     # restart
    docker compose ps          # status
    docker compose logs -f     # follow the logs

Never run \`docker compose down -v\`: it deletes the database volume.

Settings are in \`.env\`; run \`docker compose up -d\` after changing them.
Upgrading: $DOCS/self-hosting/docker-compose#upgrading

## Feedback and contributing

Platypus is open source: https://github.com/$REPO
Bug reports, ideas and pull requests are all welcome; see
https://github.com/$REPO/blob/main/CONTRIBUTING.md
EOF

  # --- Start the stack. ---
  echo "Starting Platypus (the first run pulls images and can take a few minutes)..."
  (cd "$dir" && docker compose up -d --wait) ||
    fail "the stack did not start. See why with: cd $dir && docker compose logs backend
Once fixed, start it with 'docker compose up -d' in $dir; re-running this installer will refuse, because .env now exists."

  cat <<EOF

Platypus $version is running.

  Sign in at:  http://$host:3000
  Email:       $email
  Password:    $password

These credentials are temporary: change the password after you first sign in.
They are also saved in $dir/.env.

To stop, start or upgrade Platypus, see $dir/README.md.
EOF

  if [[ "$host" != "localhost" ]]; then
    cat <<EOF

WARNING: ports 3000 and 4000 serve plain HTTP, with no TLS, on every network
interface of this host. Before exposing Platypus beyond a trusted network, see
$DOCS/self-hosting/production
EOF
  fi
}

main
