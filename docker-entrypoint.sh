#!/bin/sh
set -e

# Docker entrypoint script for mobile-money
# Supports running migrations before starting the application

# If the first argument is a migration command, run it
if [ "$1" = "npm" ] && [ "$2" = "run" ] && [ "$3" = "migrate:up" ]; then
  echo "Running database migrations..."
  exec npm run migrate:up
fi

# Otherwise, start the application (or execute whatever command was passed)
# If no command provided, default to npm start
if [ $# -eq 0 ]; then
  echo "Starting application..."
  exec npm start
fi

echo "Executing command: $@"
exec "$@"
