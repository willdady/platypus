#!/bin/bash

# Check if the container already exists
if docker ps -a --filter name=platypus-postgres --format "{{.Names}}" | grep -q platypus-postgres; then
  echo "Starting existing PostgreSQL container..."
  docker start -a platypus-postgres
else
  echo "Creating and starting new PostgreSQL container..."
  docker run --name platypus-postgres -e POSTGRES_PASSWORD=mypassword -p 5432:5432 postgres:17
fi