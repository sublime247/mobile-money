#!/bin/bash
# Installation and quick test script for the CLI Dashboard

set -e

echo "🚀 Mobile Money CLI Dashboard Installation & Test"
echo "=================================================="
echo ""

# 1. Navigate to CLI directory
echo "📂 Navigating to CLI directory..."
cd cli

# 2. Install dependencies
echo "📦 Installing dependencies..."
npm install

# 3. Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

# 4. Test configuration
echo "⚙️  Setting up test configuration..."
export MOMO_API_URL=${MOMO_API_URL:-http://localhost:3000}
export MOMO_API_KEY=${MOMO_API_KEY:-test-key}

echo "API URL: $MOMO_API_URL"
echo "API Key: $MOMO_API_KEY"
echo ""

# 5. Test commands
echo "🧪 Testing dashboard commands..."
echo ""

echo "Test 1: Version check"
npm run dev -- --version
echo "✓ Version check passed"
echo ""

echo "Test 2: Help message"
npm run dev -- dashboard --help
echo "✓ Help message displayed"
echo ""

echo "Test 3: Dashboard (will fail if backend not running, that's OK)"
npm run dev -- dashboard:export 2>/dev/null || echo "⚠️  Backend not running (expected if not started)"
echo ""

# 6. Show available commands
echo "📋 Available Dashboard Commands:"
echo "================================="
echo ""
echo "  momo-cli dashboard           Display system dashboard"
echo "  momo-cli dashboard --watch   Auto-refresh dashboard (5s)"
echo "  momo-cli dashboard:live      Live status monitor"
echo "  momo-cli dashboard:export    Export metrics as JSON"
echo ""

# 7. Documentation
echo "📚 Documentation:"
echo "================="
echo ""
echo "  • DASHBOARD.md    - Complete user guide"
echo "  • QUICK_START.md  - Quick reference"
echo "  • EXAMPLES.md     - Usage examples & integrations"
echo "  • README.md       - Main CLI documentation"
echo ""

echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "1. Ensure backend is running: npm start (from root directory)"
echo "2. Set API credentials: export MOMO_API_URL=... MOMO_API_KEY=..."
echo "3. Try the dashboard: npm run dev -- dashboard"
echo ""
