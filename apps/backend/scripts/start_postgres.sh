#!/bin/bash

# Check if the container already exists
if docker ps -a --filter name=agent-kit-postgres --format "{{.Names}}" | grep -q agent-kit-postgres; then
  echo "Starting existing PostgreSQL container..."
  docker start -a agent-kit-postgres
else
  echo "Creating and starting new PostgreSQL container..."
  docker run --name agent-kit-postgres -e POSTGRES_PASSWORD=mypassword -p 5432:5432 postgres
fi