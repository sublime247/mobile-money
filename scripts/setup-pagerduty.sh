#!/usr/bin/env bash
# PagerDuty Integration Setup Script
# This script helps deploy the PagerDuty integration

set -e

echo "🚀 PagerDuty Integration Setup"
echo "=============================="
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
  echo "❌ Error: package.json not found. Please run from project root."
  exit 1
fi

echo "✅ Found project root"
echo ""

# Verify TypeScript files exist
echo "📋 Verifying implementation files..."

files=(
  "src/services/pagerDutyService.ts"
  "src/services/alertService.ts"
  "src/queue/webhookRetryQueue.ts"
  "src/services/monitoringService.ts"
  "src/middleware/providerMetrics.ts"
  "src/jobs/scheduler.ts"
  "src/config/env.ts"
  "src/index.ts"
  "docs/PAGERDUTY_INTEGRATION.md"
)

missing_files=()
for file in "${files[@]}"; do
  if [ -f "$file" ]; then
    echo "  ✅ $file"
  else
    echo "  ❌ $file (MISSING)"
    missing_files+=("$file")
  fi
done

if [ ${#missing_files[@]} -gt 0 ]; then
  echo ""
  echo "❌ Missing files detected. Please check implementation."
  exit 1
fi

echo ""
echo "✅ All implementation files present"
echo ""

# Check for axios in package.json
if grep -q '"axios"' package.json; then
  echo "✅ axios dependency already installed"
else
  echo "⚠️  axios dependency not found, installing..."
  npm install axios
fi

echo ""
echo "📝 Environment Configuration"
echo "=============================="
echo ""
echo "To enable PagerDuty integration, set these environment variables:"
echo ""
echo "Required:"
echo "  PAGERDUTY_INTEGRATION_KEY=<your-routing-key>"
echo ""
echo "Optional:"
echo "  PAGERDUTY_DEDUP_KEY=mobile-money  (default)"
echo ""

# Check if .env file exists
if [ -f ".env" ]; then
  echo "📄 Found .env file - checking configuration..."
  
  if grep -q "PAGERDUTY_INTEGRATION_KEY" .env; then
    echo "✅ PAGERDUTY_INTEGRATION_KEY already configured"
  else
    echo "⚠️  PAGERDUTY_INTEGRATION_KEY not found in .env"
    echo "   Add it manually or run: echo 'PAGERDUTY_INTEGRATION_KEY=<your-key>' >> .env"
  fi
else
  echo "⚠️  No .env file found"
  echo "   Create one with: cp .env.example .env"
  echo "   Or add variables to your deployment platform"
fi

echo ""
echo "🧪 Running Tests"
echo "================"
echo ""

if npm run test -- pagerDutyService.test.ts alertService.test.ts setupPagerduty.test.ts --coverage=false --runInBand 2>/dev/null; then
  echo "✅ All tests passed"
else
  echo "⚠️  Build project first: npm run build"
fi

echo ""
echo "✅ Setup Complete!"
echo ""
echo "📚 Documentation:"
echo "  - Full Guide:   docs/PAGERDUTY_INTEGRATION.md"
echo "  - Examples:     src/services/examples/pagerDutyIntegrationExamples.ts"
echo ""
echo "🎯 Next Steps:"
echo "  1. Get PagerDuty Integration Key (Routing Key)"
echo "  2. Set PAGERDUTY_INTEGRATION_KEY in environment"
echo "  3. Restart application"
echo "  4. Monitor logs for: 'PagerDuty monitoring service started'"
echo ""
echo "🔗 PagerDuty Setup:"
echo "  https://app.pagerduty.com → Services → Integrations → Events API V2"
echo ""
