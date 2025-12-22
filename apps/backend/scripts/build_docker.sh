#!/bin/bash

# Navigate to the root of the monorepo
cd "$(dirname "$0")/../../.."

# Get the version from the root package.json
VERSION=$(node -p "require('./package.json').version")

echo "Building backend Docker image with version $VERSION..."

# Build the image
docker build \
  --tag willdady/platypus-backend:latest \
  --tag "willdady/platypus-backend:$VERSION" \
  -f apps/backend/Dockerfile .
