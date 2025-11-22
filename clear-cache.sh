#!/bin/bash

# Clear Cache Script for Tradooor
# Clears all cache files and folders locally and provides instructions for VPS

echo "🧹 Clearing cache files..."

# Frontend cache
echo "  📦 Clearing Next.js cache..."
rm -rf apps/frontend/.next
rm -rf apps/frontend/out
rm -rf apps/frontend/.next/cache

# Backend cache
echo "  📦 Clearing backend build cache..."
rm -rf apps/backend/dist
rm -rf apps/backend/build
rm -rf apps/backend/.cache

# Packages cache
echo "  📦 Clearing packages cache..."
rm -rf packages/db/dist
rm -rf packages/shared/dist

# TypeScript cache
echo "  📦 Clearing TypeScript cache..."
find . -name "*.tsbuildinfo" -type f -delete
find . -name ".tsbuildinfo" -type f -delete

# Node modules cache (optional - uncomment if needed)
# echo "  📦 Clearing node_modules cache..."
# find . -name "node_modules/.cache" -type d -exec rm -rf {} + 2>/dev/null || true

# pnpm cache (optional - uncomment if needed)
# echo "  📦 Clearing pnpm cache..."
# pnpm store prune

# Browser cache instructions
echo ""
echo "✅ Local cache cleared!"
echo ""
echo "🌐 To clear browser cache:"
echo "   - Chrome/Edge: Ctrl+Shift+Delete (Windows) or Cmd+Shift+Delete (Mac)"
echo "   - Firefox: Ctrl+Shift+Delete (Windows) or Cmd+Shift+Delete (Mac)"
echo "   - Or hard refresh: Ctrl+F5 (Windows) or Cmd+Shift+R (Mac)"
echo ""
echo "🖥️  To clear cache on VPS, run:"
echo "   ssh root@157.180.41.49 'cd /opt/tradooor && bash clear-cache.sh'"
echo ""

