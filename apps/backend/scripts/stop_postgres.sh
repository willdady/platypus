#!/bin/bash

# Check if the container is running
if docker ps --filter name=agent-kit-postgres --format "{{.Names}}" | grep -q agent-kit-postgres; then
  echo "Stopping PostgreSQL container..."
  docker stop agent-kit-postgres
else
  echo "PostgreSQL container is not running."
fi