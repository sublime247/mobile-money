#!/bin/bash
# Exit immediately if a command exits with a non-zero status
set -e

# Config
OUTPUT_DIR="sdk-ts"
SPEC_URL="http://localhost:3000/docs/openapi.json"

echo "=== TypeScript SDK Generation and Build ==="

# Try to check if server is running
echo "Checking if API server is running at $SPEC_URL..."
if ! curl -sf "$SPEC_URL" > /dev/null; then
  echo "Error: API server is not running at $SPEC_URL."
  echo "Please start the server first by running 'npm run dev' or 'npm start'."
  exit 1
fi

echo "Generating TypeScript SDK..."
npx @openapitools/openapi-generator-cli generate \
  -i "$SPEC_URL" \
  -c sdk-config-ts.yaml \
  -o "$OUTPUT_DIR"

echo "Building TypeScript SDK and compiling types..."
cd "$OUTPUT_DIR"
npm install
npm run build

echo "=== TypeScript SDK compiled and verified successfully ==="
