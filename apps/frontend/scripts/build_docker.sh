#!/bin/bash

# Navigate to the root of the monorepo
cd "$(dirname "$0")/../../.."

# Get the version from the root package.json
VERSION=$(node -p "require('./package.json').version")

echo "Building frontend Docker image with version $VERSION..."

# Build the image
docker build \
  --tag willdady/platypus-frontend:latest \
  --tag "willdady/platypus-frontend:$VERSION" \
  -f apps/frontend/Dockerfile .
