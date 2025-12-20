#!/bin/bash

# Check if the container is running
if docker ps --filter name=platypus-postgres --format "{{.Names}}" | grep -q platypus-postgres; then
  echo "Stopping PostgreSQL container..."
  docker stop platypus-postgres
else
  echo "PostgreSQL container is not running."
fi