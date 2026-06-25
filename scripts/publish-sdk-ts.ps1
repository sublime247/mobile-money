$ErrorActionPreference = 'Stop'

$OutputDir = "sdk-ts"
$SpecUrl = "http://localhost:3000/docs/openapi.json"

Write-Host "=== TypeScript SDK Generation and Build ==="

# Check if server is running
Write-Host "Checking if API server is running at $SpecUrl..."
try {
    $response = Invoke-WebRequest -Uri $SpecUrl -Method Get -UseBasicParsing -TimeoutSec 5
} catch {
    Write-Error "Error: API server is not running at $SpecUrl. Please start the server first by running 'npm run dev' or 'npm start'."
    exit 1
}

Write-Host "Generating TypeScript SDK..."
npx.cmd @openapitools/openapi-generator-cli generate -i $SpecUrl -c sdk-config-ts.yaml -o $OutputDir

Write-Host "Building TypeScript SDK and compiling types..."
Set-Location $OutputDir
npm.cmd install
npm.cmd run build

Write-Host "=== TypeScript SDK compiled and verified successfully ==="
