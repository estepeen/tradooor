#!/bin/bash
# Skript pro přidání createdAt a updatedAt do ClosedLot tabulky

set -e

cd "$(dirname "$0")/.."

echo "🔧 Adding createdAt and updatedAt columns to ClosedLot table..."

# Načti DATABASE_URL z .env souboru
if [ -f "apps/backend/.env" ]; then
  export $(grep -v '^#' apps/backend/.env | xargs)
fi

if [ -z "$DATABASE_URL" ]; then
  echo "❌ Error: DATABASE_URL not found in apps/backend/.env"
  exit 1
fi

# Spusť SQL skript pomocí psql s DATABASE_URL
psql "$DATABASE_URL" -f add_closed_lot_timestamps.sql

echo "✅ Successfully added createdAt and updatedAt columns to ClosedLot table"
echo "🔄 Regenerating Prisma client..."

cd packages/db
pnpm db:generate

echo "✅ Done! You can now restart the backend."

